"""GitHub App authentication.

The app signs a short JWT with its private key, finds the installation for a repository, and trades
the JWT for an installation access token (valid one hour, cached here until shortly before it expires).
"""

import threading
import time
from datetime import datetime
from pathlib import Path

import httpx
import jwt

from . import config

GITHUB_API = "https://api.github.com"
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


def install_url() -> str | None:
    return f"https://github.com/apps/{config.GITHUB_APP_SLUG}/installations/new" if config.GITHUB_APP_SLUG else None


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
