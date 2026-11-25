from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from . import config
from .config import SECRET_KEY, TOKEN_TTL_HOURS
from .db import get_db
from .models import User, utcnow

SEEN_EVERY = timedelta(minutes=2)  # how often last_seen_at is written


def create_token(user_id: int) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": str(user_id), "iat": now, "exp": now + timedelta(hours=TOKEN_TTL_HOURS)}
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")


def _decode(token: str) -> dict | None:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        int(payload["sub"])
        return payload
    except (jwt.PyJWTError, KeyError, ValueError):
        return None


def decode_token(token: str) -> int | None:
    payload = _decode(token)
    return int(payload["sub"]) if payload else None


def user_from_token(db: Session, token: str | None) -> User | None:
    """The token's user, unless the account is suspended or an admin signed it out after the token was issued."""
    payload = _decode(token) if token else None
    if not payload:
        return None
    user = db.get(User, int(payload["sub"]))
    if not user or user.disabled:
        return None
    if user.sessions_revoked_at:
        revoked = int(user.sessions_revoked_at.replace(tzinfo=timezone.utc).timestamp())
        if int(payload.get("iat", 0)) < revoked:
            return None
    return user


def is_admin(user: User | None) -> bool:
    return bool(user and (user.is_admin or user.email.lower() in config.ADMIN_EMAILS))


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return None


def _touch(db: Session, user: User) -> None:
    now = utcnow()
    if not user.last_seen_at or now - user.last_seen_at > SEEN_EVERY:
        user.last_seen_at = now
        db.commit()


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    user = user_from_token(db, _bearer(request))
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    _touch(db, user)
    return user


def admin_user(user: User = Depends(current_user)) -> User:
    if not is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admins only")
    return user


def current_user_or_query_token(
    request: Request, token: str | None = Query(None), db: Session = Depends(get_db)
) -> User:
    """For file downloads opened via <a href>/<img src>, where headers can't be set."""
    user = user_from_token(db, _bearer(request) or token)
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    return user
