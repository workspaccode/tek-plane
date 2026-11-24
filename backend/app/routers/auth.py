"""Sign-in with Google or a one-time email code. No passwords."""

import base64
import hashlib
import hmac
import re
import secrets
from datetime import timedelta
from urllib.parse import quote, urlencode

import httpx
import jwt
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .. import config, mailer
from .. import models as m
from ..db import get_db
from ..security import create_token, current_user
from ..serializers import user_out
from ..services import get_or_create_user

router = APIRouter(prefix="/api", tags=["auth"])

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
RESEND_SECONDS = 30
MAX_CODES_PER_HOUR = 6

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
OAUTH_COOKIE = "tp_oauth"


class OtpRequestIn(BaseModel):
    email: str = Field(max_length=255)


class OtpVerifyIn(BaseModel):
    email: str = Field(max_length=255)
    code: str = Field(min_length=4, max_length=12)


class MePatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    title: str | None = Field(None, max_length=120)
    avatar_color: str | None = Field(None, max_length=20)


def _normalize_email(raw: str) -> str:
    email = raw.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(422, "Enter a valid email address")
    return email


def _code_hash(email: str, code: str) -> str:
    return hmac.new(config.SECRET_KEY.encode(), f"{email}:{code}".encode(), hashlib.sha256).hexdigest()


def public_base(request: Request) -> str:
    return config.BASE_URL or str(request.base_url).rstrip("/")


def issue_link(db: Session, request: Request, email: str, purpose: str, ttl: timedelta, next_path: str = "/dashboard") -> str:
    """Create a single-use email link and return its URL. Only a hash of the token is stored."""
    token = secrets.token_urlsafe(32)
    db.add(m.EmailLink(email=email, token_hash=hashlib.sha256(token.encode()).hexdigest(), purpose=purpose,
                       next_path=next_path, expires_at=m.utcnow() + ttl))
    return f"{public_base(request)}/api/auth/link/{token}"


def _needs_name(user: m.User) -> bool:
    return not user.name or user.name == user.email.split("@")[0]


# ---------------------------------------------------------------- config

@router.get("/auth/config")
def auth_config():
    return {
        "google": bool(config.GOOGLE_CLIENT_ID and config.GOOGLE_CLIENT_SECRET),
        "email_delivery": mailer.provider(),
        "otp_length": 6,
        "resend_seconds": RESEND_SECONDS,
    }


# ---------------------------------------------------------------- email one-time code

@router.post("/auth/otp/request")
def request_code(body: OtpRequestIn, request: Request, db: Session = Depends(get_db)):
    email = _normalize_email(body.email)
    now = m.utcnow()
    recent = db.scalars(select(m.OtpCode).where(
        m.OtpCode.email == email, m.OtpCode.created_at >= now - timedelta(hours=1)
    ).order_by(m.OtpCode.id.desc())).all()
    if recent and (now - recent[0].created_at).total_seconds() < RESEND_SECONDS:
        wait = RESEND_SECONDS - int((now - recent[0].created_at).total_seconds())
        raise HTTPException(429, f"Please wait {wait}s before requesting another code")
    if len(recent) >= MAX_CODES_PER_HOUR:
        raise HTTPException(429, "Too many codes requested. Try again in an hour.")
    for old in recent:
        old.consumed = True  # only the newest code is valid
    code = f"{secrets.randbelow(10**6):06d}"
    db.add(m.OtpCode(email=email, code_hash=_code_hash(email, code),
                     expires_at=now + timedelta(minutes=config.OTP_TTL_MINUTES)))
    existing = db.scalar(select(m.User).where(m.User.email == email))
    is_new = existing is None or not existing.email_verified
    link = issue_link(db, request, email, "activate" if is_new else "login",
                      timedelta(minutes=config.LOGIN_LINK_TTL_MINUTES))
    db.commit()
    mailer.send_login_email(email, code, link, is_new)
    return {"ok": True, "is_new": existing is None, "expires_in": config.OTP_TTL_MINUTES * 60}


@router.post("/auth/otp/verify")
def verify_code(body: OtpVerifyIn, db: Session = Depends(get_db)):
    email = _normalize_email(body.email)
    code = re.sub(r"\D", "", body.code)
    otp = db.scalar(select(m.OtpCode).where(m.OtpCode.email == email, m.OtpCode.consumed.is_(False))
                    .order_by(m.OtpCode.id.desc()))
    if not otp or otp.expires_at < m.utcnow():
        raise HTTPException(400, "This code has expired. Request a new one.")
    if otp.attempts >= config.OTP_MAX_ATTEMPTS:
        raise HTTPException(429, "Too many wrong attempts. Request a new code.")
    if not hmac.compare_digest(otp.code_hash, _code_hash(email, code)):
        otp.attempts += 1
        db.commit()
        left = config.OTP_MAX_ATTEMPTS - otp.attempts
        raise HTTPException(400, f"Wrong code. {left} attempt{'s' if left != 1 else ''} left." if left else
                            "Wrong code. Request a new one.")
    otp.consumed = True
    user, is_new = get_or_create_user(db, email)
    user.email_verified = True
    db.commit()
    return {"token": create_token(user.id), "user": user_out(user), "is_new": is_new or _needs_name(user)}


@router.get("/auth/link/{token}")
def open_link(token: str, db: Session = Depends(get_db)):
    """Sign-in / activation / invitation link from an email. Single use."""
    link = db.scalar(select(m.EmailLink).where(m.EmailLink.token_hash == hashlib.sha256(token.encode()).hexdigest()))
    if not link or link.used_at:
        return _fail("This link was already used. Request a new code to sign in.")
    if link.expires_at < m.utcnow():
        return _fail("This link has expired. Request a new code to sign in.")
    link.used_at = m.utcnow()
    user, created = get_or_create_user(db, link.email)
    user.email_verified = True
    # the matching code can't be used any more either
    for otp in db.scalars(select(m.OtpCode).where(m.OtpCode.email == link.email, m.OtpCode.consumed.is_(False))):
        otp.consumed = True
    db.commit()
    new = "1" if created or _needs_name(user) else "0"
    return RedirectResponse(f"/auth/callback#token={quote(create_token(user.id))}&next={quote(link.next_path)}&new={new}",
                            status_code=302)


# ---------------------------------------------------------------- Google OAuth (authorization code + PKCE)

def _redirect_uri(request: Request) -> str:
    base = config.BASE_URL or str(request.base_url).rstrip("/")
    return f"{base}/api/auth/google/callback"


def _fail(message: str) -> RedirectResponse:
    return RedirectResponse(f"/login#error={quote(message)}", status_code=302)


@router.get("/auth/google/start")
def google_start(request: Request, next: str = "/dashboard"):
    if not (config.GOOGLE_CLIENT_ID and config.GOOGLE_CLIENT_SECRET):
        return _fail("Google sign-in is not configured on this server.")
    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    safe_next = next if next.startswith("/") and not next.startswith("//") else "/dashboard"
    cookie = jwt.encode({"state": state, "verifier": verifier, "next": safe_next,
                         "exp": m.utcnow() + timedelta(minutes=10)}, config.SECRET_KEY, algorithm="HS256")
    params = {
        "client_id": config.GOOGLE_CLIENT_ID,
        "redirect_uri": _redirect_uri(request),
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "prompt": "select_account",
    }
    resp = RedirectResponse(f"{GOOGLE_AUTH_URL}?{urlencode(params)}", status_code=302)
    resp.set_cookie(OAUTH_COOKIE, cookie, max_age=600, httponly=True, samesite="lax",
                    secure=request.url.scheme == "https", path="/api/auth/google")
    return resp


@router.get("/auth/google/callback")
def google_callback(request: Request, code: str = "", state: str = "", error: str = "",
                    db: Session = Depends(get_db)):
    if error:
        return _fail("Google sign-in was cancelled." if error == "access_denied" else f"Google error: {error}")
    try:
        saved = jwt.decode(request.cookies.get(OAUTH_COOKIE, ""), config.SECRET_KEY, algorithms=["HS256"])
    except jwt.PyJWTError:
        return _fail("Your sign-in session expired. Please try again.")
    if not code or not hmac.compare_digest(saved.get("state", ""), state):
        return _fail("Invalid sign-in response. Please try again.")
    try:
        res = httpx.post(GOOGLE_TOKEN_URL, timeout=15, data={
            "code": code,
            "client_id": config.GOOGLE_CLIENT_ID,
            "client_secret": config.GOOGLE_CLIENT_SECRET,
            "redirect_uri": _redirect_uri(request),
            "grant_type": "authorization_code",
            "code_verifier": saved["verifier"],
        })
        res.raise_for_status()
        id_token = res.json()["id_token"]
    except (httpx.HTTPError, KeyError, ValueError):
        return _fail("Could not complete Google sign-in. Please try again.")
    # The ID token came straight from Google's token endpoint over TLS, so its signature check can be
    # skipped (OpenID Connect Core 3.1.3.7); the claims are still validated.
    try:
        claims = jwt.decode(id_token, options={"verify_signature": False})
    except jwt.PyJWTError:
        return _fail("Google returned an invalid identity token.")
    if (claims.get("iss") not in ("accounts.google.com", "https://accounts.google.com")
            or claims.get("aud") != config.GOOGLE_CLIENT_ID
            or not claims.get("email") or not claims.get("email_verified")):
        return _fail("Your Google account email is not verified.")

    email = claims["email"].lower()
    sub = str(claims["sub"])
    google_name = (claims.get("name") or " ".join(filter(None, [claims.get("given_name"), claims.get("family_name")]))).strip()
    user = db.scalar(select(m.User).where(m.User.google_sub == sub))
    if not user:
        user, _ = get_or_create_user(db, email, google_name or None)
        user.google_sub = sub
    if google_name and _needs_name(user):
        user.name = google_name[:120]
    if claims.get("picture"):
        user.avatar_url = str(claims["picture"])[:500]
    user.email_verified = True
    db.commit()
    token = create_token(user.id)
    resp = RedirectResponse(f"/auth/callback#token={quote(token)}&next={quote(saved.get('next', '/dashboard'))}",
                            status_code=302)
    resp.delete_cookie(OAUTH_COOKIE, path="/api/auth/google")
    return resp


# ---------------------------------------------------------------- profile

@router.get("/me")
def me(user: m.User = Depends(current_user)):
    return {**user_out(user), "google_linked": bool(user.google_sub)}


@router.patch("/me")
def update_me(body: MePatch, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    if body.name is not None:
        user.name = body.name.strip()
    if body.title is not None:
        user.title = body.title.strip()
    if body.avatar_color is not None:
        user.avatar_color = body.avatar_color
    db.commit()
    return {**user_out(user), "google_linked": bool(user.google_sub)}


@router.get("/users/search")
def search_users(q: str = "", user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    q = q.strip().lower()
    if len(q) < 2:
        return []
    like = f"%{q}%"
    rows = db.scalars(
        select(m.User).where(or_(func.lower(m.User.email).like(like), func.lower(m.User.name).like(like))).limit(10)
    )
    return [user_out(u) for u in rows if u.id != user.id]
