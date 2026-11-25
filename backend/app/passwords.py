"""Passwords for admin accounts. Hashed with scrypt (standard library); only the hash is stored."""

import base64
import hashlib
import hmac
import secrets

N, R, P = 2**15, 8, 1  # ~32 MB and ~50 ms per hash: slow for attackers, quick enough for a sign-in
MAXMEM = 64 * 1024 * 1024
MIN_LENGTH = 10

# Admin accounts that have no email of their own get an address on this reserved domain (RFC 2606),
# so nothing is ever emailed to them and they can't sign in with an email code.
PLACEHOLDER_DOMAIN = "admin.invalid"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    key = hashlib.scrypt(password.encode(), salt=salt, n=N, r=R, p=P, maxmem=MAXMEM, dklen=32)
    return f"scrypt${N}${R}${P}${_b64(salt)}${_b64(key)}"


def verify_password(password: str, stored: str | None) -> bool:
    try:
        algo, n, r, p, salt, key = (stored or "").split("$")
        if algo != "scrypt":
            return False
        expected = _unb64(key)
        actual = hashlib.scrypt(password.encode(), salt=_unb64(salt), n=int(n), r=int(r), p=int(p),
                                maxmem=MAXMEM, dklen=len(expected))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def password_problem(password: str) -> str | None:
    """A reason the password is too weak, or None."""
    if len(password) < MIN_LENGTH:
        return f"Use at least {MIN_LENGTH} characters."
    if len(password) > 256:
        return "That password is too long."
    if password.isalpha() or password.isdigit():
        return "Mix letters with numbers or symbols."
    return None


def is_placeholder_email(email: str | None) -> bool:
    return bool(email) and email.lower().endswith(".invalid")


# Checked against when the username doesn't exist, so a wrong username takes as long as a wrong password.
_DUMMY = None


def dummy_hash() -> str:
    global _DUMMY
    if _DUMMY is None:
        _DUMMY = hash_password(secrets.token_urlsafe(16))
    return _DUMMY
