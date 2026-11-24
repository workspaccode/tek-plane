import os
import secrets
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader (KEY=VALUE lines). Real environment variables win."""
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv(ROOT_DIR / ".env")
DATA_DIR = Path(os.environ.get("TEKPLANE_DATA_DIR", ROOT_DIR / "data"))
UPLOAD_DIR = DATA_DIR / "uploads"
FRONTEND_DIR = ROOT_DIR / "frontend"

DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_URL = os.environ.get("TEKPLANE_DATABASE_URL", f"sqlite:///{DATA_DIR / 'tekplane.db'}")

MAX_UPLOAD_BYTES = int(os.environ.get("TEKPLANE_MAX_UPLOAD_MB", "25")) * 1024 * 1024
TOKEN_TTL_HOURS = int(os.environ.get("TEKPLANE_TOKEN_TTL_HOURS", str(24 * 14)))


def _load_secret() -> str:
    env = os.environ.get("TEKPLANE_SECRET")
    if env:
        return env
    path = DATA_DIR / "secret.key"
    if path.exists():
        return path.read_text().strip()
    value = secrets.token_urlsafe(48)
    path.write_text(value)
    path.chmod(0o600)
    return value


SECRET_KEY = _load_secret()


# Public URL of the app, used for the Google OAuth redirect. Defaults to the request's own URL.
BASE_URL = os.environ.get("TEKPLANE_BASE_URL", "").rstrip("/")

# Google sign-in (create an OAuth client of type "Web application" in Google Cloud Console)
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")

# Email delivery for one-time login codes. Without SMTP_HOST, codes are printed to the server console.
SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT") or "587")
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_FROM = os.environ.get("SMTP_FROM", SMTP_USER or "tek-plane <no-reply@localhost>")
SMTP_SECURITY = os.environ.get("SMTP_SECURITY", "starttls").lower()  # starttls | ssl | none

# Alternative to SMTP: Resend (https://resend.com) HTTP API. Takes precedence when set.
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
EMAIL_FROM = os.environ.get("EMAIL_FROM", "") or "tek-plane <onboarding@resend.dev>"

LOGIN_LINK_TTL_MINUTES = 10
INVITE_LINK_TTL_DAYS = 7

OTP_TTL_MINUTES = 10
OTP_MAX_ATTEMPTS = 5
