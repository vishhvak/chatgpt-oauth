"""Public value objects, store protocol, and stable exception hierarchy."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal, Protocol, TypeAlias

JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | list["JsonValue"] | dict[str, "JsonValue"]
ResponseContent: TypeAlias = str | Sequence[Mapping[str, JsonValue]]


def validate_subject(subject: str) -> None:
    """Rejects the empty subject; every credential operation requires an explicit identity."""
    if not subject:
        raise ValueError("subject must be nonempty")


@dataclass(frozen=True, slots=True)
class TokenSet:
    """Stores one subject's credential generation without revealing secrets in repr."""

    access_token: str = field(repr=False)
    refresh_token: str = field(repr=False)
    expires_at: int
    version: int
    id_token: str | None = field(default=None, repr=False)
    account_id: str | None = None
    plan_type: str | None = None
    email: str | None = None
    quarantined_at: int | None = None
    quarantine_reason: str | None = None


@dataclass(frozen=True, slots=True)
class Session:
    """Describes safe connection metadata for one explicit subject."""

    subject: str
    status: Literal["connected", "quarantined"]
    expires_at: int
    account_id: str | None = None
    plan_type: str | None = None
    email: str | None = None
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class PendingLogin:
    """Carries protected, short-lived PKCE state until callback completion."""

    url: str
    state: str = field(repr=False)
    verifier: str = field(repr=False)
    redirect_uri: str


@dataclass(frozen=True, slots=True)
class DeviceLogin:
    """Presents a device code and asynchronously completes its token exchange."""

    user_code: str
    verification_url: str
    expires_at: int
    _wait: Callable[[], Awaitable[TokenSet]] = field(repr=False)

    async def wait(self) -> TokenSet:
        """Polls until device authorization succeeds or expires."""
        return await self._wait()


@dataclass(frozen=True, slots=True)
class RateLimitWindow:
    """Describes one backend usage window from response headers."""

    used_percent: float
    window_minutes: float | None = None
    resets_at: float | None = None


@dataclass(frozen=True, slots=True)
class RateLimitSnapshot:
    """Describes all backend rate-limit metadata known after a response."""

    primary: RateLimitWindow | None = None
    secondary: RateLimitWindow | None = None
    plan_type: str | None = None
    limit_name: str | None = None


@dataclass(frozen=True, slots=True)
class ResponseRequest:
    """Defines one streaming subscription-model request."""

    model: str
    input: ResponseContent
    instructions: str | None = None
    tools: Sequence[Mapping[str, JsonValue]] | None = None
    tool_choice: JsonValue = None
    reasoning: Mapping[str, JsonValue] | None = None
    include: Sequence[str] | None = None


@dataclass(frozen=True, slots=True)
class ResponseEvent:
    """Carries one parsed SSE event, including unknown future event types."""

    type: str
    data: JsonValue
    delta: str | None = None


@dataclass(frozen=True, slots=True)
class ResponseResult:
    """Collects output text, all events, and optional completion metadata."""

    output_text: str
    events: tuple[ResponseEvent, ...]
    response: JsonValue = None


@dataclass(frozen=True, slots=True)
class CompareAndSwapResult:
    """Reports whether CAS saved and always returns the current winner."""

    ok: bool
    current: TokenSet | None


class CredentialStore(Protocol):
    """Persists credentials only through explicit subject-keyed operations."""

    async def load(self, subject: str) -> TokenSet | None:
        """Loads credentials for exactly one explicit subject."""
        ...

    async def compare_and_swap(
        self, subject: str, expected_version: int, next_token: TokenSet
    ) -> CompareAndSwapResult:
        """Atomically saves one subject only when its version matches."""
        ...

    async def delete(self, subject: str) -> None:
        """Deletes credentials for exactly one explicit subject."""
        ...


class ChatGPTOAuthError(Exception):
    """Base class for public failures with a stable machine-readable code."""

    code: str

    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


class StateMismatchError(ChatGPTOAuthError):
    """Reports a callback whose state does not match its pending login."""

    def __init__(self) -> None:
        super().__init__("OAuth state did not match.", "state_mismatch")


class ReauthRequired(ChatGPTOAuthError):
    """Reports that one explicit subject must complete a fresh sign-in."""

    def __init__(self, subject: str, reason: str) -> None:
        super().__init__(
            f"Fresh sign-in required for subject {subject!r}: {reason}", "reauth_required"
        )
        self.subject = subject
        self.reason = reason


class TokenRefreshError(ChatGPTOAuthError):
    """Reports a retryable refresh failure without quarantining credentials."""

    def __init__(self, message: str = "Token refresh failed transiently.") -> None:
        super().__init__(message, "token_refresh")


class RateLimitError(ChatGPTOAuthError):
    """Reports a service rate limit and an optional retry delay in milliseconds."""

    def __init__(self, retry_after_ms: int | None = None) -> None:
        super().__init__("The service rate limit was reached.", "rate_limit")
        self.retry_after_ms = retry_after_ms


class AuthError(ChatGPTOAuthError):
    """Reports an OAuth or backend authentication rejection."""

    def __init__(self, message: str = "Authentication was rejected.") -> None:
        super().__init__(message, "auth")


class TransportError(ChatGPTOAuthError):
    """Reports a redacted network or protocol failure."""

    def __init__(self, message: str) -> None:
        super().__init__(message, "transport")


class DisabledError(ChatGPTOAuthError):
    """Reports that the runtime kill switch disabled subscription access."""

    def __init__(self) -> None:
        super().__init__("ChatGPT subscription access is disabled.", "disabled")


class StoreError(ChatGPTOAuthError):
    """Reports an authenticated-storage or persistence failure."""

    def __init__(self, message: str) -> None:
        super().__init__(message, "store")
