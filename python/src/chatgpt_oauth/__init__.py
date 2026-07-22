"""Async, subject-scoped ChatGPT OAuth and subscription transport."""

from .client import SubscriptionAI, create_client, parse_rate_limit_headers
from .jwt import UnverifiedClaims, extract_unverified_claims
from .loopback import wait_for_loopback_callback
from .pkce import assert_state, base64url, create_pkce, decode_base64url, pkce_challenge
from .protocol import PROTOCOL, ProtocolConfig
from .redact import redact
from .session import AuthSession
from .sse import parse_sse
from .stores import (
    FileCredentialStore,
    MemoryCredentialStore,
    create_file_credential_store,
    create_memory_store,
)
from .types import (
    AuthError,
    ChatGPTOAuthError,
    CompareAndSwapResult,
    CredentialStore,
    DeviceLogin,
    DisabledError,
    JsonValue,
    PendingLogin,
    RateLimitError,
    RateLimitSnapshot,
    RateLimitWindow,
    ReauthRequired,
    ResponseContent,
    ResponseEvent,
    ResponseRequest,
    ResponseResult,
    Session,
    StateMismatchError,
    StoreError,
    TokenRefreshError,
    TokenSet,
    TransportError,
)

__all__ = [
    "PROTOCOL",
    "AuthError",
    "AuthSession",
    "ChatGPTOAuthError",
    "CompareAndSwapResult",
    "CredentialStore",
    "DeviceLogin",
    "DisabledError",
    "FileCredentialStore",
    "JsonValue",
    "MemoryCredentialStore",
    "PendingLogin",
    "ProtocolConfig",
    "RateLimitError",
    "RateLimitSnapshot",
    "RateLimitWindow",
    "ReauthRequired",
    "ResponseContent",
    "ResponseEvent",
    "ResponseRequest",
    "ResponseResult",
    "Session",
    "StateMismatchError",
    "StoreError",
    "SubscriptionAI",
    "TokenRefreshError",
    "TokenSet",
    "TransportError",
    "UnverifiedClaims",
    "assert_state",
    "base64url",
    "create_client",
    "create_file_credential_store",
    "create_memory_store",
    "create_pkce",
    "decode_base64url",
    "extract_unverified_claims",
    "parse_rate_limit_headers",
    "parse_sse",
    "pkce_challenge",
    "redact",
    "wait_for_loopback_callback",
]
