"""GitHub App authentication.

The app signs a short JWT with its private key, finds the installation for a repository, and trades
the JWT for an installation access token (valid one hour, cached here until shortly before it expires).
"""

import threading
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode

import httpx
import jwt

from . import config

GITHUB_API = "https://api.github.com"
GITHUB_WEB = "https://github.com"
_tokens: dict[int, tuple[float, str]] = {}
_lock = threading.Lock()


class GithubAppError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def private_key() -> str | None:
    if config.GITHUB_APP_PRIVATE_KEY:
        return config.GITHUB_APP_PRIVATE_KEY
    if not config.GITHUB_APP_PRIVATE_KEY_PATH:
        return None
    path = Path(config.GITHUB_APP_PRIVATE_KEY_PATH).expanduser()
    if not path.is_absolute():
        path = config.ROOT_DIR / path
    try:
        return path.read_text()
    except OSError:
        return None


def configured() -> bool:
    return bool(config.GITHUB_APP_ID and private_key())


def oauth_ready() -> bool:
    """People can connect their GitHub account (needs the app's client ID and secret as well as its key)."""
    return configured() and bool(config.GITHUB_APP_CLIENT_ID and config.GITHUB_APP_CLIENT_SECRET)


def install_url() -> str | None:
    return f"https://github.com/apps/{config.GITHUB_APP_SLUG}/installations/new" if config.GITHUB_APP_SLUG else None


# ---------------------------------------------------------------- user authorization (OAuth web flow)

def authorize_url(redirect_uri: str, state: str, challenge: str) -> str:
    # redirect_uri is always explicit: without it GitHub falls back to the app's first callback URL
    params = {"client_id": config.GITHUB_APP_CLIENT_ID, "redirect_uri": redirect_uri, "state": state,
              "code_challenge": challenge, "code_challenge_method": "S256", "allow_signup": "false"}
    return f"{GITHUB_WEB}/login/oauth/authorize?{urlencode(params)}"


_OAUTH_ERRORS = {
    "bad_verification_code": (400, "The GitHub sign-in code expired or was already used. Try again."),
    "incorrect_client_credentials": (400, "GitHub rejected the app's client ID or secret. Check GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET."),
    "redirect_uri_mismatch": (400, "This address isn't one of the app's callback URLs. Add it in the GitHub App's settings."),
    "bad_refresh_token": (401, "Your GitHub connection expired. Connect your GitHub account again."),
    "unauthorized_client": (400, "GitHub didn't allow this app to sign you in. Check the app's settings."),
}


def _token_call(data: dict) -> dict:
    try:
        res = httpx.post(f"{GITHUB_WEB}/login/oauth/access_token", timeout=15,
                         headers={"Accept": "application/json", "User-Agent": "6dx"},
                         data={"client_id": config.GITHUB_APP_CLIENT_ID, "client_secret": config.GITHUB_APP_CLIENT_SECRET, **data})
    except httpx.HTTPError as exc:
        raise GithubAppError(502, "Couldn't reach GitHub. Check this server's internet connection.") from exc
    try:
        body = res.json()
    except ValueError:
        body = {}
    if res.status_code >= 400 or not body.get("access_token"):
        error = body.get("error") or str(res.status_code)
        status, message = _OAUTH_ERRORS.get(error, (400, f"GitHub sign-in failed ({error})."))
        raise GithubAppError(status, message)
    return body


def exchange_code(code: str, redirect_uri: str, verifier: str | None = None) -> dict:
    """Trade the callback's code for a user access token (+ refresh token when tokens expire)."""
    data = {"code": code, "redirect_uri": redirect_uri}
    if verifier:
        data["code_verifier"] = verifier
    return _token_call(data)


def refresh_user_token(refresh_token: str) -> dict:
    return _token_call({"grant_type": "refresh_token", "refresh_token": refresh_token})


def revoke_user_token(token: str) -> None:
    """Best effort: tell GitHub to forget the token when someone disconnects."""
    try:
        httpx.request("DELETE", f"{GITHUB_API}/applications/{config.GITHUB_APP_CLIENT_ID}/token", timeout=10,
                      auth=(config.GITHUB_APP_CLIENT_ID, config.GITHUB_APP_CLIENT_SECRET), json={"access_token": token},
                      headers={"Accept": "application/vnd.github+json", "User-Agent": "6dx"})
    except httpx.HTTPError:
        pass


def app_jwt() -> str:
    now = int(time.time())
    # iat is backdated a minute for clock drift; GitHub allows at most 10 minutes
    return jwt.encode({"iat": now - 60, "exp": now + 540, "iss": str(config.GITHUB_APP_ID)}, private_key(), algorithm="RS256")


def _app_headers() -> dict:
    return {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "6dx",
            "Authorization": f"Bearer {app_jwt()}"}


def find_installation(repo: str) -> int | None:
    """The app's installation id for owner/repo, or None when the app isn't installed there."""
    try:
        res = httpx.get(f"{GITHUB_API}/repos/{repo}/installation", headers=_app_headers(), timeout=15)
    except httpx.HTTPError as exc:
        raise GithubAppError(502, "Couldn't reach GitHub. Check this server's internet connection.") from exc
    if res.status_code == 404:
        return None
    if res.status_code == 401:
        raise GithubAppError(400, "GitHub rejected the app's credentials. Check GITHUB_APP_ID and the private key.")
    if res.status_code >= 400:
        raise GithubAppError(502, f"GitHub answered with an error ({res.status_code}).")
    return int(res.json()["id"])


def installation_token(installation_id: int) -> str:
    now = time.time()
    with _lock:
        hit = _tokens.get(installation_id)
    if hit and hit[0] - now > 300:
        return hit[1]
    try:
        res = httpx.post(f"{GITHUB_API}/app/installations/{installation_id}/access_tokens", headers=_app_headers(), timeout=15)
    except httpx.HTTPError as exc:
        raise GithubAppError(502, "Couldn't reach GitHub. Check this server's internet connection.") from exc
    if res.status_code == 404:
        raise GithubAppError(409, "The GitHub App was uninstalled from this repository. Install it again, then reconnect.")
    if res.status_code >= 400:
        raise GithubAppError(400, "GitHub didn't give the app access. Check the app's credentials and installation.")
    data = res.json()
    expires = datetime.fromisoformat(data["expires_at"].replace("Z", "+00:00")).timestamp()
    with _lock:
        _tokens[installation_id] = (expires, data["token"])
    return data["token"]
