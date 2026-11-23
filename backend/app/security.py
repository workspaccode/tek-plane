from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from .config import SECRET_KEY, TOKEN_TTL_HOURS
from .db import get_db
from .models import User


def create_token(user_id: int) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": str(user_id), "iat": now, "exp": now + timedelta(hours=TOKEN_TTL_HOURS)}
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")


def decode_token(token: str) -> int | None:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        return int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        return None


def user_from_token(db: Session, token: str | None) -> User | None:
    if not token:
        return None
    user_id = decode_token(token)
    return db.get(User, user_id) if user_id else None


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return None


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    user = user_from_token(db, _bearer(request))
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    return user


def current_user_or_query_token(
    request: Request, token: str | None = Query(None), db: Session = Depends(get_db)
) -> User:
    """For file downloads opened via <a href>/<img src>, where headers can't be set."""
    user = user_from_token(db, _bearer(request) or token)
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    return user
