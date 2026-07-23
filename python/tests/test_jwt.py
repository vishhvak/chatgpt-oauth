import json

from chatgpt_oauth import TokenSet
from chatgpt_oauth.jwt import extract_unverified_claims
from chatgpt_oauth.pkce import base64url
from chatgpt_oauth.redact import redact


def jwt(payload: object) -> str:
    return f"x.{base64url(json.dumps(payload).encode())}.signature"


def test_extracts_unverified_claims_and_prefers_id_token() -> None:
    access = jwt({"email": "fallback@example.com"})
    identity = jwt(
        {
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acct-1",
                "chatgpt_plan_type": "pro",
            },
            "email": "display@example.com",
        }
    )
    claims = extract_unverified_claims(identity, access)
    assert (claims.account_id, claims.plan_type, claims.email) == (
        "acct-1",
        "pro",
        "display@example.com",
    )


def test_malformed_id_token_falls_back_to_access_token() -> None:
    claims = extract_unverified_claims("malformed", jwt({"email": "fallback@example.com"}))
    assert claims.email == "fallback@example.com"


def test_tokens_never_appear_in_repr_or_redacted_text() -> None:
    token = TokenSet("access-secret", "refresh-secret", 10, 1, id_token="id-secret")
    representation = repr(token)
    assert "access-secret" not in representation
    assert "refresh-secret" not in representation
    assert "id-secret" not in representation
    secret = "s" * 1500
    message = redact(f'Bearer access-secret {{"access_token":"{secret}"}}')
    assert "access-secret" not in message
    assert secret[:500] not in message
    assert "[REDACTED]" in message
