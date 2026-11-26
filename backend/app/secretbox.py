"""Encrypts integration secrets (API tokens, webhook URLs) at rest, with a key derived from SECRET_KEY."""

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from . import config


def _fernet() -> Fernet:
    # The "tek-plane/" prefix predates the rename to 6dx. Keep it: changing it makes every stored secret unreadable.
    key = hashlib.sha256(f"tek-plane/integrations/{config.SECRET_KEY}".encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def seal(value: str | None) -> str | None:
    return _fernet().encrypt(value.encode()).decode() if value else None


def unseal(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return _fernet().decrypt(value.encode()).decode()
    except InvalidToken:  # SECRET_KEY changed: the stored secret can't be read any more
        return None
