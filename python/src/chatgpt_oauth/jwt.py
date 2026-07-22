"""Unverified JWT metadata extraction for display and request routing only."""

import json
from dataclasses import dataclass
from typing import cast

from .pkce import decode_base64url

_CLAIM_NAMESPACE = "https://api.openai.com/auth"


@dataclass(frozen=True, slots=True)
class UnverifiedClaims:
    """Carries unverified display/routing claims that must never authorize access."""

    account_id: str | None = None
    plan_type: str | None = None
    email: str | None = None


def _payload(token: str) -> object:
    try:
        segment = token.split(".")[1]
        return cast(object, json.loads(decode_base64url(segment).decode()))
    except (IndexError, UnicodeDecodeError, ValueError):
        return None


def extract_unverified_claims(
    id_token: str | None = None, access_token: str | None = None
) -> UnverifiedClaims:
    """Extracts display/routing claims only; these unverified claims never authorize."""
    payload = _payload(id_token or "")
    if not isinstance(payload, dict):
        payload = _payload(access_token or "")
    if not isinstance(payload, dict):
        return UnverifiedClaims()
    namespace = payload.get(_CLAIM_NAMESPACE)
    auth = namespace if isinstance(namespace, dict) else {}
    account_id = auth.get("chatgpt_account_id")
    plan_type = auth.get("chatgpt_plan_type")
    email = payload.get("email")
    return UnverifiedClaims(
        account_id=account_id if isinstance(account_id, str) else None,
        plan_type=plan_type if isinstance(plan_type, str) else None,
        email=email if isinstance(email, str) else None,
    )
