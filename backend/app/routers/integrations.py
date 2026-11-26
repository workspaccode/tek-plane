"""Integrations for software projects.

GitHub: link a repository, see pull requests, commits and open issues, import issues as tasks and
complete those tasks when their issues are closed.
Slack / Discord: post a message to a channel when tasks are created, completed, assigned or commented on.

Secrets (GitHub tokens, webhook URLs) are stored encrypted and never sent back to the browser.
"""

import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from urllib.parse import urlencode

import httpx
import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import event, select
from sqlalchemy.orm import Session, selectinload
from starlette.concurrency import run_in_threadpool

from .. import config, github_app
from .. import models as m
from ..db import SessionLocal, get_db
from ..secretbox import seal, unseal
from ..security import current_user
from ..serializers import iso, task_summaries
from ..services import ROLE_RANK, broadcast, broadcast_task, log, place_task, require_role, set_status
from .auth import public_base

router = APIRouter(prefix="/api", tags=["integrations"])
logger = logging.getLogger("6dx.integrations")

NAMES = {"github": "GitHub", "slack": "Slack", "discord": "Discord"}
NOTIFY_EVENTS = {
    "task.created": "New tasks",
    "task.completed": "Completed tasks",
    "task.assigned": "Assignments",
    "comment.added": "Comments",
    "member.added": "New members",
}
DEFAULT_EVENTS = ["task.created", "task.completed", "comment.added"]
WRITEBACK_EVENTS = {"task.completed", "task.reopened"}  # mirrored to the linked GitHub issue
GITHUB_API = "https://api.github.com"
REPO_RE = re.compile(r"^(?:https?://(?:www\.)?github\.com/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/([A-Za-z0-9._-]{1,100}?)(?:\.git)?/?$")
WEBHOOK_RE = {
    "slack": re.compile(r"^https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+$"),
    "discord": re.compile(r"^https://(?:(?:ptb|canary)\.)?discord(?:app)?\.com/api/webhooks/\d+/[A-Za-z0-9._-]+$"),
}
WEBHOOK_HELP = {
    "slack": "Paste a Slack incoming-webhook URL. It starts with https://hooks.slack.com/services/",
    "discord": "Paste a Discord webhook URL. It starts with https://discord.com/api/webhooks/",
}
LABEL_ALIASES = {"enhancement": "feature", "documentation": "docs", "tech-debt": "tech debt"}


class GithubConnectIn(BaseModel):
    repo: str = Field(min_length=3, max_length=300)
    token: str | None = Field(None, max_length=300)
    method: str | None = None  # "app" (GitHub App) | "token" (personal token, or none for public repos); default: app when set up


class WebhookConnectIn(BaseModel):
    url: str = Field(min_length=10, max_length=500)
    events: list[str] = Field(default_factory=lambda: list(DEFAULT_EVENTS))


class IntegrationPatch(BaseModel):
    token: str | None = Field(None, max_length=300)  # GitHub: new token, "" removes it
    url: str | None = Field(None, max_length=500)  # Slack/Discord: new webhook URL
    events: list[str] | None = None
    enabled: bool | None = None
    close_issues: bool | None = None  # GitHub: close/reopen the issue when its task is completed/reopened
    auto_import: bool | None = None  # GitHub: new issues become tasks (needs the webhook)


class ImportIn(BaseModel):
    numbers: list[int] = Field(min_length=1, max_length=100)
    section_id: int | None = None


# ---------------------------------------------------------------- outside calls (tests replace these)

class GithubError(Exception):
    def __init__(self, status: int, message: str, upstream: int | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.upstream = upstream  # GitHub's own status code, when it matters (401: token revoked or expired)


def github_request(path: str, token: str | None = None, params: dict | None = None):
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "6dx"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        res = httpx.get(f"{GITHUB_API}{path}", headers=headers, params=params, timeout=15)
    except httpx.HTTPError as exc:
        raise GithubError(502, "Couldn't reach GitHub. Check this server's internet connection.") from exc
    if res.status_code == 401:
        raise GithubError(400, "GitHub rejected the access token. Create a new one and try again.", 401)
    if res.status_code in (403, 429):
        if res.headers.get("x-ratelimit-remaining") == "0":
            raise GithubError(429, "GitHub's hourly limit was reached. Add an access token for a higher limit, or try later.")
        raise GithubError(400, "GitHub refused access. Check that the token can read this repository.")
    if res.status_code == 404:
        raise GithubError(404, "Repository not found. For a private repository, add an access token that can read it.")
    if res.status_code == 409:
        raise GithubError(409, "This repository is empty.")
    if res.status_code >= 400:
        raise GithubError(502, f"GitHub answered with an error ({res.status_code}). Try again in a moment.")
    return res.json()


def github_write(method: str, path: str, token: str | None, body: dict) -> dict:
    """PATCH/POST to the GitHub API (closing or reopening issues)."""
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "6dx"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        res = httpx.request(method, f"{GITHUB_API}{path}", headers=headers, json=body, timeout=15)
    except httpx.HTTPError as exc:
        raise GithubError(502, "Couldn't reach GitHub.") from exc
    if res.status_code in (401, 403, 404):
        raise GithubError(400, "GitHub didn't allow updating the issue. Give the app (or token) Issues: Read and write.")
    if res.status_code >= 400:
        raise GithubError(502, f"GitHub answered with an error ({res.status_code}).")
    return res.json()


def post_webhook(url: str, payload: dict) -> None:
    res = httpx.post(url, json=payload, timeout=10)
    if res.status_code >= 400:
        raise RuntimeError(f"The chat app answered {res.status_code}: {res.text[:120]}")


# ---------------------------------------------------------------- small cache for GitHub reads

CACHE_SECONDS = 60
_cache: dict[tuple, tuple[float, object]] = {}
_cache_lock = threading.Lock()


def _cached(key: tuple, fetch):
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
    if hit and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    value = fetch()
    with _cache_lock:
        _cache[key] = (now, value)
    return value


def _forget(integration_id: int) -> None:
    with _cache_lock:
        for key in [k for k in _cache if k[0] == integration_id]:
            _cache.pop(key, None)


# ---------------------------------------------------------------- helpers

def _software_project(db: Session, project_id: int, user: m.User, minimum: str = "viewer"):
    pm = require_role(db, project_id, user, minimum)
    project = db.get(m.Project, project_id)
    if project.category != "software":
        raise HTTPException(409, "Integrations are for software projects. Change the project type in Settings.")
    return project, pm


def _get(db: Session, project_id: int, provider: str) -> m.Integration | None:
    return db.scalar(select(m.Integration).where(m.Integration.project_id == project_id, m.Integration.provider == provider))


def _github(db: Session, project_id: int) -> m.Integration:
    integ = _get(db, project_id, "github")
    if not integ:
        raise HTTPException(404, "GitHub isn't connected to this project.")
    return integ


def _token_for(integ: m.Integration) -> str | None:
    """The token GitHub calls use: a fresh GitHub App installation token, the saved personal token, or none."""
    cfg = integ.config or {}
    if cfg.get("auth") == "app":
        if not github_app.configured():
            raise HTTPException(409, "This repository is connected through the GitHub App, but the app's settings are missing on this server.")
        try:
            return github_app.installation_token(int(cfg["installation_id"]))
        except github_app.GithubAppError as exc:
            raise HTTPException(exc.status, exc.message) from exc
    return unseal(integ.secret)


def _auth_kind(integ: m.Integration) -> str:
    if (integ.config or {}).get("auth") == "app":
        return "app"
    return "token" if integ.secret else "none"


def _clean_events(events: list[str]) -> list[str]:
    return [e for e in NOTIFY_EVENTS if e in set(events)]


def _url_hint(url: str) -> str:
    host = re.sub(r"^https://", "", url).split("/")[0]
    return f"{host}/…{url[-4:]}"


def integration_out(i: m.Integration) -> dict:
    cfg = i.config or {}
    out = {
        "id": i.id,
        "provider": i.provider,
        "name": NAMES.get(i.provider, i.provider),
        "enabled": i.enabled,
        "created_at": iso(i.created_at),
        "last_used_at": iso(i.last_used_at),
        "last_error": i.last_error,
    }
    if i.provider == "github":
        out.update(repo=cfg.get("repo"), html_url=cfg.get("html_url"), private=cfg.get("private", False),
                   default_branch=cfg.get("default_branch"), has_token=bool(i.secret), auth=_auth_kind(i),
                   linked_by=cfg.get("linked_by"),
                   close_issues=bool(cfg.get("close_issues")), auto_import=bool(cfg.get("auto_import")))
    else:
        out.update(events=cfg.get("events", []), hint=cfg.get("hint"))
    return out


def _validate_repo(raw: str, token: str | None) -> dict:
    match = REPO_RE.match(raw.strip())
    if not match:
        raise HTTPException(422, "Enter the repository as owner/name, or paste its GitHub link.")
    try:
        return github_request(f"/repos/{match.group(1)}/{match.group(2)}", token)
    except GithubError as exc:
        raise HTTPException(exc.status, exc.message) from exc


# ---------------------------------------------------------------- GitHub account (user authorization through the app)
#
# Linking a repository through the GitHub App is only allowed for someone whose own GitHub account can reach it:
# the app is often installed on many repositories (private ones included), and without this check anyone with a
# 6dx account could link any of them just by typing its name.

GH_COOKIE = "gh_oauth"
GH_BACK_COOKIE = "gh_back"
GH_COOKIE_PATH = "/api/integrations/github"
LINK_PERMISSIONS = ("admin", "maintain", "push", "triage")  # enough to close issues, so enough to link
EXPIRED = "Your GitHub connection expired or was revoked. Connect your GitHub account again."
BACK_RE = re.compile(r"^/projects/\d+/integrations$")
_refresh_lock = threading.Lock()


class GithubAuthorizeIn(BaseModel):
    project_id: int | None = None


def _account(db: Session, user: m.User) -> m.GithubAccount | None:
    return db.scalar(select(m.GithubAccount).where(m.GithubAccount.user_id == user.id))


def account_out(acc: m.GithubAccount | None) -> dict | None:
    if not acc:
        return None
    return {"login": acc.login, "name": acc.name, "avatar_url": acc.avatar_url,
            "html_url": f"https://github.com/{acc.login}", "connected_at": iso(acc.created_at)}


def _store_tokens(acc: m.GithubAccount, tok: dict) -> None:
    now = m.utcnow()
    acc.access_token = seal(tok["access_token"])
    acc.refresh_token = seal(tok.get("refresh_token"))
    acc.expires_at = now + timedelta(seconds=int(tok["expires_in"])) if tok.get("expires_in") else None
    acc.refresh_expires_at = (now + timedelta(seconds=int(tok["refresh_token_expires_in"]))
                              if tok.get("refresh_token_expires_in") else None)
    acc.updated_at = now


def _drop_account(db: Session, acc: m.GithubAccount) -> HTTPException:
    db.delete(acc)
    db.commit()
    return HTTPException(409, EXPIRED)


def _user_token(db: Session, user: m.User) -> tuple[m.GithubAccount, str]:
    """The person's GitHub user access token, refreshed when it's about to expire (refresh tokens are single-use)."""
    acc = _account(db, user)
    if not acc:
        raise HTTPException(409, "Connect your GitHub account first.")
    with _refresh_lock:
        db.refresh(acc)
        token = unseal(acc.access_token)
        now = m.utcnow()
        if token and (not acc.expires_at or acc.expires_at - now > timedelta(minutes=5)):
            return acc, token
        refresh = unseal(acc.refresh_token)
        if not refresh or (acc.refresh_expires_at and acc.refresh_expires_at <= now):
            raise _drop_account(db, acc)
        try:
            tok = github_app.refresh_user_token(refresh)
        except github_app.GithubAppError as exc:
            if exc.status == 401:
                raise _drop_account(db, acc) from exc
            raise HTTPException(exc.status, exc.message) from exc
        _store_tokens(acc, tok)
        db.commit()
        return acc, tok["access_token"]


def _can_link(perms: dict | None) -> bool:
    return True if perms is None else any(perms.get(k) for k in LINK_PERMISSIONS)


def _verify_app_repo(db: Session, user: m.User, raw: str) -> dict:
    """Check that the person's GitHub account can reach the repository with at least triage access and that the
    app is installed on it. Returns the repository and the integration settings for an app connection."""
    match = REPO_RE.match(raw.strip())
    if not match:
        raise HTTPException(422, "Enter the repository as owner/name, or paste its GitHub link.")
    name = f"{match.group(1)}/{match.group(2)}"
    acc, token = _user_token(db, user)
    try:
        # a user token of a GitHub App only reaches repositories both the person and the app can access
        seen = github_request(f"/repos/{name}", token)
    except GithubError as exc:
        if exc.upstream == 401:
            raise _drop_account(db, acc) from exc
        if exc.status == 404:
            raise HTTPException(404, f"{name} isn't among the repositories your GitHub account (@{acc.login}) can "
                                     "reach through the app. Check the name, or install the app on it.") from exc
        raise HTTPException(exc.status, exc.message) from exc
    full = seen["full_name"]
    if not _can_link(seen.get("permissions") or {}):
        raise HTTPException(403, f"Your GitHub account (@{acc.login}) needs at least triage access to {full} to link it.")
    try:
        installation = github_app.find_installation(full)
        if not installation:
            raise HTTPException(409, f"The GitHub App isn't installed on {full} yet. Install it on the repository, then connect again.")
        repo = _validate_repo(full, github_app.installation_token(installation))
    except github_app.GithubAppError as exc:
        raise HTTPException(exc.status, exc.message) from exc
    return {"repo": repo, "auth": "app", "installation_id": installation, "linked_by": acc.login,
            "close_issues": True, "auto_import": False}


def _gh_redirect_uri(request: Request) -> str:
    return f"{public_base(request)}/api/integrations/github/callback"


def _finish(dest: str, **fragment) -> RedirectResponse:
    resp = RedirectResponse(f"{dest}#{urlencode(fragment)}", status_code=302)
    resp.delete_cookie(GH_COOKIE, path=GH_COOKIE_PATH)
    return resp


@router.post("/integrations/github/authorize")
def github_authorize(body: GithubAuthorizeIn, request: Request, response: Response,
                     user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    """Start connecting the person's GitHub account; returns the GitHub page to open."""
    if not github_app.oauth_ready():
        raise HTTPException(409, "GitHub sign-in isn't set up on this server. Add GITHUB_APP_CLIENT_ID and "
                                 "GITHUB_APP_CLIENT_SECRET to .env.")
    back = "/dashboard"
    if body.project_id:
        require_role(db, body.project_id, user, "viewer")
        back = f"/projects/{body.project_id}/integrations"
    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    # Bound to this browser and this person: the callback only completes where the flow was started.
    cookie = jwt.encode({"uid": user.id, "state": state, "verifier": verifier, "back": back,
                         "exp": m.utcnow() + timedelta(minutes=10)}, config.SECRET_KEY, algorithm="HS256")
    response.set_cookie(GH_COOKIE, cookie, max_age=600, httponly=True, samesite="lax",
                        secure=request.url.scheme == "https", path=GH_COOKIE_PATH)
    return {"url": github_app.authorize_url(_gh_redirect_uri(request), state, challenge)}


@router.get("/integrations/github/callback")
def github_callback(request: Request, code: str = "", state: str = "", error: str = "", db: Session = Depends(get_db)):
    try:
        saved = jwt.decode(request.cookies.get(GH_COOKIE, ""), config.SECRET_KEY, algorithms=["HS256"])
    except jwt.PyJWTError:
        return _finish("/dashboard", github_error="The GitHub connection timed out or was started in another browser. Try again.")
    dest = saved.get("back") if BACK_RE.match(saved.get("back") or "") else "/dashboard"
    if error:
        return _finish(dest, github_error="Connecting GitHub was cancelled." if error == "access_denied" else f"GitHub error: {error}")
    if not code or not state or not hmac.compare_digest(saved.get("state", ""), state):
        return _finish(dest, github_error="GitHub sent an unexpected response. Try again.")
    user = db.get(m.User, saved.get("uid"))
    if not user or user.disabled:
        return _finish("/login", github_error="Sign in again, then connect GitHub.")
    try:
        tok = github_app.exchange_code(code, _gh_redirect_uri(request), saved.get("verifier"))
        me = github_request("/user", tok["access_token"])
    except (github_app.GithubAppError, GithubError) as exc:
        return _finish(dest, github_error=exc.message)
    acc = _account(db, user)
    if not acc:
        acc = m.GithubAccount(user_id=user.id)
        db.add(acc)
    acc.github_id, acc.login = int(me["id"]), str(me["login"])[:100]
    acc.name = (me.get("name") or "")[:200] or None
    acc.avatar_url = (me.get("avatar_url") or "")[:500] or None
    _store_tokens(acc, tok)
    db.commit()
    return _finish(dest, github="connected")


@router.delete("/integrations/github/account")
def github_disconnect(user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    """Forget the person's GitHub account. Repositories they already linked keep working through the app."""
    acc = _account(db, user)
    if acc:
        token = unseal(acc.access_token)
        db.delete(acc)
        db.commit()
        if token and github_app.oauth_ready():
            github_app.revoke_user_token(token)
    return {"ok": True}


@router.get("/integrations/github/repos")
def github_repos(user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    """Repositories the person can link: reachable by both their GitHub account and the app."""
    if not github_app.oauth_ready():
        raise HTTPException(409, "GitHub sign-in isn't set up on this server.")
    acc, token = _user_token(db, user)
    groups = []
    try:
        installs = github_request("/user/installations", token, {"per_page": 100}).get("installations", [])
        for inst in installs[:20]:
            repos: list[dict] = []
            for page in range(1, 6):
                chunk = github_request(f"/user/installations/{inst['id']}/repositories", token,
                                       {"per_page": 100, "page": page}).get("repositories", [])
                repos += chunk
                if len(chunk) < 100:
                    break
            repos.sort(key=lambda r: r.get("pushed_at") or "", reverse=True)
            owner = inst.get("account") or {}
            groups.append({
                "installation_id": inst["id"], "account": owner.get("login"), "avatar_url": owner.get("avatar_url"),
                "type": owner.get("type"), "selection": inst.get("repository_selection"), "manage_url": inst.get("html_url"),
                "repos": [{"full_name": r["full_name"], "private": bool(r.get("private")),
                           "description": (r.get("description") or "")[:200], "pushed_at": r.get("pushed_at"),
                           "can_link": _can_link(r.get("permissions"))} for r in repos],
            })
    except GithubError as exc:
        if exc.upstream == 401:
            raise _drop_account(db, acc) from exc
        raise HTTPException(exc.status, exc.message) from exc
    return {"account": account_out(acc), "installations": groups, "install_url": github_app.install_url()}


@router.get("/integrations/github/install")
def github_install(back: str = ""):
    """Open the app's install page; remembers where to come back to if the app's Setup URL points here."""
    url = github_app.install_url()
    if not url:
        raise HTTPException(404, "The GitHub App's name (GITHUB_APP_SLUG) isn't set on this server.")
    resp = RedirectResponse(url, status_code=302)
    if BACK_RE.match(back):
        resp.set_cookie(GH_BACK_COOKIE, back, max_age=3600, httponly=True, samesite="lax", path=GH_COOKIE_PATH)
    return resp


@router.get("/integrations/github/setup")
def github_setup(request: Request, setup_action: str = ""):
    """Optional Setup URL for the app: GitHub sends people here after they install it."""
    back = request.cookies.get(GH_BACK_COOKIE, "")
    dest = back if BACK_RE.match(back) else "/dashboard"
    resp = RedirectResponse(f"{dest}#{urlencode({'github': 'requested' if setup_action == 'request' else 'installed'})}", 302)
    resp.delete_cookie(GH_BACK_COOKIE, path=GH_COOKIE_PATH)
    return resp


# ---------------------------------------------------------------- manage connections

@router.get("/projects/{project_id}/integrations")
def list_integrations(project_id: int, request: Request, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    _, pm = _software_project(db, project_id, user)
    rows = db.scalars(select(m.Integration).where(m.Integration.project_id == project_id)).all()
    return {
        "connected": [integration_out(i) for i in rows],
        "events": NOTIFY_EVENTS,
        "can_manage": ROLE_RANK[pm.role] >= ROLE_RANK["admin"],
        "github_app": github_app_info(request, db, user),
    }


def github_app_info(request: Request, db: Session, user: m.User) -> dict:
    return {
        "configured": github_app.configured(),
        "oauth_ready": github_app.oauth_ready(),
        "account": account_out(_account(db, user)),
        "install_url": github_app.install_url(),
        "webhook_url": f"{public_base(request)}/api/integrations/github/webhook",
        "webhook_ready": bool(config.GITHUB_WEBHOOK_SECRET),
    }


@router.post("/projects/{project_id}/integrations/github")
def connect_github(project_id: int, body: GithubConnectIn, user: m.User = Depends(current_user),
                   db: Session = Depends(get_db)):
    _software_project(db, project_id, user, "admin")
    token = (body.token or "").strip() or None
    method = body.method or ("token" if token or not github_app.oauth_ready() else "app")
    if method not in ("app", "token"):
        raise HTTPException(422, "Choose the GitHub App or a personal token")
    if method == "app" and not github_app.configured():
        raise HTTPException(409, "The GitHub App isn't set up on this server. Use a personal token, or add the app's settings to .env.")
    if method == "app" and not github_app.oauth_ready():
        raise HTTPException(409, "Connecting through the GitHub App needs GitHub sign-in on this server "
                                 "(GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET in .env). Use a personal token for now.")
    app_cfg = {}
    if method == "app":
        app_cfg = _verify_app_repo(db, user, body.repo)
        repo = app_cfg.pop("repo")
    else:
        repo = _validate_repo(body.repo, token)
    integ = _get(db, project_id, "github")
    if not integ:
        integ = m.Integration(project_id=project_id, provider="github", created_by=user.id)
        db.add(integ)
    integ.config = {"repo": repo["full_name"], "html_url": repo["html_url"], "private": bool(repo.get("private")),
                    "default_branch": repo.get("default_branch"), **app_cfg}
    integ.secret = seal(token)
    integ.enabled = True
    integ.last_error = None
    log(db, project_id, user, "integration.connected", provider="GitHub", target=repo["full_name"])
    db.commit()
    _forget(integ.id)
    broadcast(db, project_id, "integrations.changed", {}, user.id)
    return integration_out(integ)


@router.post("/projects/{project_id}/integrations/{provider}")
def connect_webhook(project_id: int, provider: str, body: WebhookConnectIn, request: Request,
                    user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    if provider not in WEBHOOK_RE:
        raise HTTPException(404, "Unknown integration")
    _software_project(db, project_id, user, "admin")
    url = body.url.strip()
    if not WEBHOOK_RE[provider].match(url):
        raise HTTPException(422, WEBHOOK_HELP[provider])
    integ = _get(db, project_id, provider)
    if not integ:
        integ = m.Integration(project_id=project_id, provider=provider, created_by=user.id)
        db.add(integ)
    integ.config = {"events": _clean_events(body.events), "hint": _url_hint(url), "base_url": public_base(request)}
    integ.secret = seal(url)
    integ.enabled = True
    integ.last_error = None
    log(db, project_id, user, "integration.connected", provider=NAMES[provider])
    db.commit()
    broadcast(db, project_id, "integrations.changed", {}, user.id)
    return integration_out(integ)


def _owned(db: Session, project_id: int, integration_id: int) -> m.Integration:
    integ = db.get(m.Integration, integration_id)
    if not integ or integ.project_id != project_id:
        raise HTTPException(404, "Integration not found")
    return integ


@router.patch("/projects/{project_id}/integrations/{integration_id}")
def update_integration(project_id: int, integration_id: int, body: IntegrationPatch, request: Request,
                       user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    _software_project(db, project_id, user, "admin")
    integ = _owned(db, project_id, integration_id)
    cfg = dict(integ.config or {})
    if body.token is not None and integ.provider == "github":
        token = body.token.strip() or None
        _validate_repo(cfg["repo"], token)  # make sure the new token (or no token) can still read the repo
        integ.secret = seal(token)
        if token:  # a personal token replaces the GitHub App connection
            for key in ("auth", "installation_id"):
                cfg.pop(key, None)
        integ.last_error = None
        _forget(integ.id)
    if integ.provider == "github":
        if body.close_issues is not None:
            cfg["close_issues"] = body.close_issues
        if body.auto_import is not None:
            cfg["auto_import"] = body.auto_import
    if body.url is not None and integ.provider in WEBHOOK_RE:
        url = body.url.strip()
        if not WEBHOOK_RE[integ.provider].match(url):
            raise HTTPException(422, WEBHOOK_HELP[integ.provider])
        integ.secret = seal(url)
        cfg["hint"] = _url_hint(url)
        integ.last_error = None
    if body.events is not None and integ.provider in WEBHOOK_RE:
        cfg["events"] = _clean_events(body.events)
    if body.enabled is not None:
        integ.enabled = body.enabled
    if integ.provider in WEBHOOK_RE:
        cfg["base_url"] = public_base(request)
    integ.config = cfg
    db.commit()
    broadcast(db, project_id, "integrations.changed", {}, user.id)
    return integration_out(integ)


@router.delete("/projects/{project_id}/integrations/{integration_id}")
def remove_integration(project_id: int, integration_id: int, user: m.User = Depends(current_user),
                       db: Session = Depends(get_db)):
    _software_project(db, project_id, user, "admin")
    integ = _owned(db, project_id, integration_id)
    name = NAMES.get(integ.provider, integ.provider)
    _forget(integ.id)
    db.delete(integ)
    log(db, project_id, user, "integration.removed", provider=name)
    db.commit()
    broadcast(db, project_id, "integrations.changed", {}, user.id)
    return {"ok": True}


@router.post("/projects/{project_id}/integrations/{integration_id}/test")
def test_integration(project_id: int, integration_id: int, user: m.User = Depends(current_user),
                     db: Session = Depends(get_db)):
    project, _ = _software_project(db, project_id, user, "admin")
    integ = _owned(db, project_id, integration_id)
    try:
        if integ.provider == "github":
            _validate_repo(integ.config["repo"], _token_for(integ))
        else:
            url = unseal(integ.secret)
            if not url:
                raise HTTPException(400, "The webhook URL can't be read any more. Connect it again.")
            post_webhook(url, _payload(integ.provider, project.name,
                                       f"{user.name} connected this channel to 6dx. Updates will appear here.",
                                       f"{(integ.config or {}).get('base_url', '')}/projects/{project.id}"))
    except HTTPException as exc:
        integ.last_error = str(exc.detail)[:300]
        db.commit()
        raise
    except Exception as exc:  # the chat app refused the message
        integ.last_error = str(exc)[:300]
        db.commit()
        raise HTTPException(502, f"Sending failed: {integ.last_error}") from exc
    integ.last_error = None
    integ.last_used_at = m.utcnow()
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- GitHub data

def _shape_issue(x: dict) -> dict:
    return {
        "number": x["number"], "title": x["title"], "html_url": x["html_url"], "state": x.get("state"),
        "user": (x.get("user") or {}).get("login"), "avatar_url": (x.get("user") or {}).get("avatar_url"),
        "labels": [{"name": lb.get("name"), "color": lb.get("color")} for lb in x.get("labels") or [] if isinstance(lb, dict)],
        "comments": x.get("comments", 0), "created_at": x.get("created_at"), "updated_at": x.get("updated_at"),
        "body": (x.get("body") or "")[:8000],
    }


def _fetch_overview(repo: str, token: str | None) -> dict:
    info = github_request(f"/repos/{repo}", token)
    pulls = github_request(f"/repos/{repo}/pulls", token, {"state": "open", "per_page": 20, "sort": "updated", "direction": "desc"})
    try:
        commits = github_request(f"/repos/{repo}/commits", token, {"per_page": 15})
    except GithubError as exc:
        if exc.status != 409:  # 409: empty repository
            raise
        commits = []
    issues = github_request(f"/repos/{repo}/issues", token, {"state": "open", "per_page": 50, "sort": "updated", "direction": "desc"})
    return {
        "repo": {
            "full_name": info["full_name"], "description": info.get("description"), "html_url": info["html_url"],
            "private": bool(info.get("private")), "language": info.get("language"),
            "default_branch": info.get("default_branch"), "stars": info.get("stargazers_count", 0),
            "forks": info.get("forks_count", 0), "watchers": info.get("subscribers_count", info.get("watchers_count", 0)),
            "pushed_at": info.get("pushed_at"),
        },
        "pulls": [{
            "number": p["number"], "title": p["title"], "html_url": p["html_url"], "draft": bool(p.get("draft")),
            "user": (p.get("user") or {}).get("login"), "avatar_url": (p.get("user") or {}).get("avatar_url"),
            "head": (p.get("head") or {}).get("ref"), "base": (p.get("base") or {}).get("ref"),
            "created_at": p.get("created_at"), "updated_at": p.get("updated_at"),
        } for p in pulls],
        "commits": [{
            "sha": c["sha"][:7], "message": (c.get("commit") or {}).get("message", "").split("\n", 1)[0][:200],
            "html_url": c.get("html_url"),
            "author": ((c.get("commit") or {}).get("author") or {}).get("name"),
            "login": (c.get("author") or {}).get("login"), "avatar_url": (c.get("author") or {}).get("avatar_url"),
            "date": ((c.get("commit") or {}).get("author") or {}).get("date"),
        } for c in commits],
        "issues": [_shape_issue(x) for x in issues if "pull_request" not in x],
    }


def _linked_tasks(db: Session, project_id: int, repo: str) -> dict[int, m.Task]:
    prefix = f"github:{repo}#"
    tasks = db.scalars(select(m.Task).where(m.Task.project_id == project_id, m.Task.external_ref.startswith(prefix)))
    out = {}
    for t in tasks:
        try:
            out[int(t.external_ref[len(prefix):])] = t
        except ValueError:
            continue
    return out


@router.get("/projects/{project_id}/github")
def github_overview(project_id: int, refresh: bool = False, user: m.User = Depends(current_user),
                    db: Session = Depends(get_db)):
    _software_project(db, project_id, user)
    integ = _github(db, project_id)
    repo = integ.config["repo"]
    if refresh:
        _forget(integ.id)
    try:
        data = _cached((integ.id, "overview"), lambda: _fetch_overview(repo, _token_for(integ)))
    except GithubError as exc:
        integ.last_error = exc.message[:300]
        db.commit()
        raise HTTPException(exc.status, exc.message) from exc
    if integ.last_error:
        integ.last_error = None
        db.commit()
    linked = _linked_tasks(db, project_id, repo)
    issues = [{**{k: v for k, v in x.items() if k != "body"},
               "task": ({"id": linked[x["number"]].id, "number": linked[x["number"]].number, "status": linked[x["number"]].status}
                        if x["number"] in linked else None)} for x in data["issues"]]
    return {**data, "issues": issues, "integration": integration_out(integ),
            "linked_open": sum(1 for t in linked.values() if t.status == "open")}


def _task_from_issue(db: Session, project: m.Project, section: m.Section, repo: str, issue: dict,
                     tags: dict[str, m.Tag], user: m.User | None) -> m.Task:
    """Create a task for a (shaped) GitHub issue. user is None when GitHub itself triggered it."""
    number = issue["number"]
    project.task_counter += 1
    text = (issue.get("body") or "").strip()
    desc = f"Imported from GitHub issue [#{number}]({issue['html_url']})." + (f"\n\n{text}" if text else "")
    task = m.Task(project_id=project.id, section_id=section.id, number=project.task_counter,
                  title=issue["title"][:300], description=desc, creator_id=user.id if user else None,
                  external_url=issue["html_url"], external_ref=f"github:{repo}#{number}")
    names = {LABEL_ALIASES.get((lb["name"] or "").lower(), (lb["name"] or "").lower()) for lb in issue["labels"]}
    task.tags = [tags[n] for n in names if n in tags]
    task.watchers = [user] if user else []
    db.add(task)
    db.flush()
    place_task(db, task, section.id, None)
    extra = {} if user else {"via": "GitHub"}
    log(db, project.id, user, "task.created", task, section=section.name, imported_from=f"GitHub #{number}", **extra)
    return task


@router.post("/projects/{project_id}/github/import")
def import_issues(project_id: int, body: ImportIn, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    project, _ = _software_project(db, project_id, user, "member")
    integ = _github(db, project_id)
    repo, token = integ.config["repo"], _token_for(integ)
    if body.section_id:
        section = db.get(m.Section, body.section_id)
        if not section or section.project_id != project_id:
            raise HTTPException(422, "Section belongs to another project")
    else:
        section = db.scalar(select(m.Section).where(m.Section.project_id == project_id).order_by(m.Section.position))
    if not section:
        raise HTTPException(409, "Add a board to this project first, so issues have somewhere to go.")
    linked = _linked_tasks(db, project_id, repo)
    cached = _cache.get((integ.id, "overview"))
    known = {x["number"]: x for x in (cached[1]["issues"] if cached else [])}
    tags = {t.name.lower(): t for t in db.scalars(select(m.Tag).where(m.Tag.project_id == project_id))}

    created: list[m.Task] = []
    for number in dict.fromkeys(body.numbers):
        if number in linked:
            continue
        issue = known.get(number)
        if issue is None:
            try:
                raw = github_request(f"/repos/{repo}/issues/{number}", token)
            except GithubError as exc:
                if exc.status == 404:
                    continue
                raise HTTPException(exc.status, exc.message) from exc
            if "pull_request" in raw:
                continue
            issue = _shape_issue(raw)
        created.append(_task_from_issue(db, project, section, repo, issue, tags, user))
    db.commit()
    for t in created:
        broadcast_task(db, t, user.id, "task.created")
    return {"imported": len(created), "tasks": task_summaries(db, created)}


@router.post("/projects/{project_id}/github/sync")
def sync_issues(project_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    """Complete tasks whose GitHub issues were closed."""
    _software_project(db, project_id, user, "member")
    integ = _github(db, project_id)
    repo, token = integ.config["repo"], _token_for(integ)
    open_linked = {n: t for n, t in _linked_tasks(db, project_id, repo).items() if t.status == "open"}
    completed: list[m.Task] = []
    if open_linked:
        try:
            closed = github_request(f"/repos/{repo}/issues", token,
                                    {"state": "closed", "per_page": 100, "sort": "updated", "direction": "desc"})
        except GithubError as exc:
            raise HTTPException(exc.status, exc.message) from exc
        closed_numbers = {x["number"] for x in closed if "pull_request" not in x}
        for number, task in open_linked.items():
            if number in closed_numbers:
                set_status(db, task, "completed", user)
                completed.append(task)
        if completed:
            log(db, project_id, user, "integration.synced", provider="GitHub", completed=len(completed))
    integ.last_used_at = m.utcnow()
    db.commit()
    _forget(integ.id)
    for t in completed:
        broadcast_task(db, t, user.id)
    return {"checked": len(open_linked), "completed": len(completed)}


# ---------------------------------------------------------------- Slack / Discord notifications

def _line(a: m.Activity) -> str | None:
    d = a.data or {}
    who = a.user.name if a.user else d.get("via") or "Someone"
    task = f"#{d.get('task_number')} {d.get('task_title')}" if d.get("task_title") else "a task"
    if a.action == "task.created":
        return f"{who} created {task}" + (f" in {d['section']}" if d.get("section") else "")
    if a.action == "task.completed":
        return f"{who} completed {task}"
    if a.action == "task.assigned":
        return f"{who} assigned {task} to {d['assignee']}" if d.get("assignee") else f"{who} unassigned {task}"
    if a.action == "comment.added":
        excerpt = (d.get("excerpt") or "").strip().replace("\n", " ")
        return f"{who} commented on {task}" + (f": “{excerpt[:140]}”" if excerpt else "")
    if a.action == "member.added":
        return f"{who} added {d.get('member', 'someone')} to the project"
    return None


def _slack_escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _payload(provider: str, project: str, text: str, link: str) -> dict:
    if provider == "slack":
        return {"text": f"*{_slack_escape(project)}* · {_slack_escape(text)} <{link}|Open>", "unfurl_links": False}
    return {"content": f"**{project}** · {text}\n<{link}>", "username": "6dx", "allowed_mentions": {"parse": []}}


def _write_back(db: Session, acts: list[m.Activity]) -> None:
    """Close or reopen the GitHub issue linked to a task that was completed or reopened here."""
    for a in acts:
        if a.action not in WRITEBACK_EVENTS or not a.task_id or (a.data or {}).get("via") == "GitHub":
            continue
        task = db.get(m.Task, a.task_id)
        if not task or not (task.external_ref or "").startswith("github:"):
            continue
        integ = _get(db, task.project_id, "github")
        cfg = (integ.config or {}) if integ else {}
        if not integ or not integ.enabled or not cfg.get("close_issues"):
            continue
        repo, _, number = task.external_ref[len("github:"):].rpartition("#")
        if repo != cfg.get("repo"):
            continue
        body = {"state": "closed", "state_reason": "completed"} if a.action == "task.completed" else {"state": "open"}
        try:
            github_write("PATCH", f"/repos/{repo}/issues/{number}", _token_for(integ), body)
            integ.last_used_at = m.utcnow()
            integ.last_error = None
            _forget(integ.id)
        except (GithubError, HTTPException) as exc:
            integ.last_error = (getattr(exc, "message", None) or str(getattr(exc, "detail", exc)))[:300]


def _notify(activity_ids: list[int]) -> None:
    try:
        with SessionLocal() as db:
            acts = db.scalars(select(m.Activity).options(selectinload(m.Activity.user)).where(
                m.Activity.id.in_(activity_ids), m.Activity.action.in_(list(set(NOTIFY_EVENTS) | WRITEBACK_EVENTS)))
                .order_by(m.Activity.id)).all()
            if not acts:
                return
            _write_back(db, acts)
            db.commit()
            pids = {a.project_id for a in acts}
            hooks = db.scalars(select(m.Integration).where(
                m.Integration.project_id.in_(pids), m.Integration.provider.in_(list(WEBHOOK_RE)),
                m.Integration.enabled.is_(True))).all()
            if not hooks:
                return
            projects = {p.id: p for p in db.scalars(select(m.Project).where(m.Project.id.in_(pids)))}
            for hook in hooks:
                project = projects.get(hook.project_id)
                if not project or project.category != "software":
                    continue
                cfg = hook.config or {}
                wanted = set(cfg.get("events") or [])
                base = cfg.get("base_url", "")
                messages = []
                for a in acts:
                    if a.project_id != hook.project_id or a.action not in wanted:
                        continue
                    text = _line(a)
                    if text:
                        link = f"{base}/projects/{project.id}" + (f"?task={a.task_id}" if a.task_id else "")
                        messages.append(_payload(hook.provider, project.name, text, link))
                if not messages:
                    continue
                url = unseal(hook.secret)
                if not url:
                    hook.last_error = "The webhook URL can't be read any more. Connect it again."
                    continue
                try:
                    for payload in messages[:10]:
                        post_webhook(url, payload)
                    hook.last_used_at = m.utcnow()
                    hook.last_error = None
                except Exception as exc:  # keep the error for the Integrations page
                    hook.last_error = str(exc)[:300]
            db.commit()
    except Exception:
        logger.exception("Sending integration notifications failed")


_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="tp-notify")


@event.listens_for(Session, "after_flush")
def _collect_activity(session: Session, _ctx) -> None:
    ids = [obj.id for obj in session.new if isinstance(obj, m.Activity)
           and (obj.action in NOTIFY_EVENTS or obj.action in WRITEBACK_EVENTS)]
    if ids:
        session.info.setdefault("tp_notify_ids", []).extend(ids)


@event.listens_for(Session, "after_commit")
def _send_after_commit(session: Session) -> None:
    ids = session.info.pop("tp_notify_ids", None)
    if ids:
        _pool.submit(_notify, ids)


@event.listens_for(Session, "after_rollback")
def _drop_on_rollback(session: Session) -> None:
    session.info.pop("tp_notify_ids", None)


# ---------------------------------------------------------------- GitHub webhook (needs a public address)

@router.post("/integrations/github/webhook")
async def github_webhook(request: Request):
    """Instant updates from the GitHub App: issues closed, reopened, renamed or opened."""
    secret = config.GITHUB_WEBHOOK_SECRET
    if not secret:
        raise HTTPException(404, "Webhooks aren't set up on this server")
    raw = await request.body()
    expected = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(request.headers.get("x-hub-signature-256", ""), expected):
        raise HTTPException(401, "Bad signature")
    kind = request.headers.get("x-github-event", "")
    if kind == "ping":
        return {"ok": True}
    if kind != "issues":
        return {"ok": True, "ignored": kind}
    payload = json.loads(raw)
    changed = await run_in_threadpool(_apply_issue_event, payload)
    return {"ok": True, "changed": changed}


def _apply_issue_event(payload: dict) -> int:
    action = payload.get("action")
    issue = payload.get("issue") or {}
    repo = (payload.get("repository") or {}).get("full_name")
    if not repo or "pull_request" in issue or action not in ("opened", "closed", "reopened", "edited"):
        return 0
    ref = f"github:{repo}#{issue.get('number')}"
    changed = 0
    with SessionLocal() as db:
        integrations = [i for i in db.scalars(select(m.Integration).where(m.Integration.provider == "github"))
                        if (i.config or {}).get("repo") == repo and i.enabled]
        events = []
        for integ in integrations:
            project = db.get(m.Project, integ.project_id)
            if not project or project.category != "software":
                continue
            task = db.scalar(select(m.Task).where(m.Task.project_id == project.id, m.Task.external_ref == ref))
            if action == "closed" and task and task.status == "open":
                task.status, task.completed_at = "completed", m.utcnow()
                log(db, project.id, None, "task.completed", task, via="GitHub")
                events.append((project.id, task, "task.updated"))
            elif action == "reopened" and task and task.status == "completed":
                task.status, task.completed_at = "open", None
                place_task(db, task, task.section_id, None)
                log(db, project.id, None, "task.reopened", task, via="GitHub")
                events.append((project.id, task, "task.updated"))
            elif action == "edited" and task and issue.get("title") and task.title != issue["title"][:300]:
                old = task.title
                task.title = issue["title"][:300]
                log(db, project.id, None, "task.renamed", task, old=old, new=task.title, via="GitHub")
                events.append((project.id, task, "task.updated"))
            elif action == "opened" and not task and (integ.config or {}).get("auto_import"):
                section = db.scalar(select(m.Section).where(m.Section.project_id == project.id).order_by(m.Section.position))
                if section:
                    tags = {t.name.lower(): t for t in db.scalars(select(m.Tag).where(m.Tag.project_id == project.id))}
                    task = _task_from_issue(db, project, section, repo, _shape_issue(issue), tags, None)
                    events.append((project.id, task, "task.created"))
            _forget(integ.id)
        db.commit()
        for _pid, task, kind in events:
            broadcast_task(db, task, None, kind)
        changed = len(events)
    return changed
