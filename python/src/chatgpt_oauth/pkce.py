"""PKCE generation, base64url helpers, and constant-work state comparison."""

import base64
import hashlib
import secrets

from .types import StateMismatchError


def base64url(value: bytes) -> str:
    """Encodes bytes as unpadded RFC 4648 URL-safe base64."""
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def decode_base64url(value: str) -> bytes:
    """Decodes unpadded RFC 4648 URL-safe base64."""
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def pkce_challenge(verifier: str) -> str:
    """Computes an OAuth S256 code challenge."""
    return base64url(hashlib.sha256(verifier.encode()).digest())


def create_pkce() -> tuple[str, str, str]:
    """Creates a verifier, its challenge, and independent callback state."""
    verifier = base64url(secrets.token_bytes(64))
    return verifier, pkce_challenge(verifier), base64url(secrets.token_bytes(32))


def assert_state(expected: str, actual: str | None) -> None:
    """Rejects state mismatch without a data-dependent early exit."""
    left = expected.encode()
    right = (actual or "").encode()
    difference = len(left) ^ len(right)
    for index in range(max(len(left), len(right))):
        difference |= (left[index] if index < len(left) else 0) ^ (
            right[index] if index < len(right) else 0
        )
    if difference:
        raise StateMismatchError
