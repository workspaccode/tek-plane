"""Command-line admin tools.

  uv run python -m backend.app.manage create-admin USERNAME [--name NAME] [--email EMAIL]
  uv run python -m backend.app.manage set-password USERNAME
  uv run python -m backend.app.manage list-admins

The password is typed at a hidden prompt (or piped in with --password-stdin), never passed as an
argument, so it doesn't end up in your shell history. Only a scrypt hash is stored.
Admins sign in at /admin/login.
"""

import argparse
import getpass
import re
import sys

from sqlalchemy import func, select

from . import models as m
from .db import Base, SessionLocal, engine
from .main import _migrate
from .passwords import PLACEHOLDER_DOMAIN, hash_password, password_problem
from .security import is_admin
from .services import get_or_create_user

USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,59}$")


def _read_password(from_stdin: bool) -> str:
    if from_stdin:
        password = sys.stdin.readline().rstrip("\r\n")
    else:
        password = getpass.getpass("Password: ")
        if getpass.getpass("Repeat password: ") != password:
            sys.exit("Passwords don't match.")
    problem = password_problem(password)
    if problem:
        sys.exit(f"Password not accepted: {problem}")
    return password


def _prepare_db() -> None:
    _migrate()
    Base.metadata.create_all(engine)


def create_admin(username: str, password: str, name: str | None = None, email: str | None = None) -> m.User:
    """Create (or update) an admin who signs in with USERNAME + password."""
    username = username.strip().lower()
    if not USERNAME_RE.match(username):
        raise ValueError("Usernames are 3-60 characters: letters, numbers, dots, dashes or underscores.")
    _prepare_db()
    with SessionLocal() as db:
        user = db.scalar(select(m.User).where(func.lower(m.User.username) == username))
        if not user:
            target_email = (email or f"{username}@{PLACEHOLDER_DOMAIN}").strip().lower()
            user, _ = get_or_create_user(db, target_email, name or username)
            if user.username and user.username != username:
                raise ValueError(f"{target_email} already signs in as {user.username}.")
            user.username = username
        if name:
            user.name = name.strip()[:120]
        user.password_hash = hash_password(password)
        user.is_admin = True
        user.disabled = False
        user.email_verified = True
        db.commit()
        db.refresh(user)
        db.expunge(user)
        return user


def set_password(username: str, password: str) -> None:
    _prepare_db()
    with SessionLocal() as db:
        user = db.scalar(select(m.User).where(func.lower(m.User.username) == username.strip().lower()))
        if not user:
            raise ValueError(f"No admin named {username}.")
        user.password_hash = hash_password(password)
        user.sessions_revoked_at = m.utcnow().replace(microsecond=0)  # sign out other sessions
        db.commit()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m backend.app.manage", description="6dx admin tools")
    sub = parser.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-admin", help="create or update an admin who signs in with a username and password")
    c.add_argument("username")
    c.add_argument("--name", help="display name (default: the username)")
    c.add_argument("--email", help="attach to this email's account instead of creating a separate one")
    c.add_argument("--password-stdin", action="store_true", help="read the password from standard input")
    s = sub.add_parser("set-password", help="change an admin's password")
    s.add_argument("username")
    s.add_argument("--password-stdin", action="store_true")
    sub.add_parser("list-admins", help="show every admin")
    args = parser.parse_args(argv)

    try:
        if args.cmd == "create-admin":
            user = create_admin(args.username, _read_password(args.password_stdin), args.name, args.email)
            print(f"Admin ready: {user.username} ({user.name}). Sign in at /admin/login")
        elif args.cmd == "set-password":
            set_password(args.username, _read_password(args.password_stdin))
            print(f"Password changed for {args.username}. Their other sessions were signed out.")
        else:
            _prepare_db()
            with SessionLocal() as db:
                users = [u for u in db.scalars(select(m.User).order_by(m.User.id)) if is_admin(u)]
                for u in users:
                    how = f"username {u.username}" if u.password_hash else "email/Google"
                    print(f"{u.name:<24} {u.email:<36} {how}")
                if not users:
                    print("No admins yet. Create one with: create-admin USERNAME")
    except ValueError as exc:
        sys.exit(str(exc))


if __name__ == "__main__":
    main()
