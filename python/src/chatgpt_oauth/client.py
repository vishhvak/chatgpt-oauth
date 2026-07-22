"""Direct backend SubscriptionAI transport with one reactive authentication retry."""

from __future__ import annotations

import email.utils
import math
import time
import uuid
from collections.abc import AsyncIterator, Callable
from datetime import timezone

import httpx

from .protocol import PROTOCOL, ProtocolConfig
from .redact import redact
from .session import AuthSession
from .sse import parse_sse
from .types import (
    AuthError,
    JsonValue,
    RateLimitError,
    RateLimitSnapshot,
    RateLimitWindow,
    ResponseEvent,
    ResponseRequest,
    ResponseResult,
    TransportError,
)


def _finite_header(headers: httpx.Headers, name: str) -> float | None:
    value = headers.get(name)
    if value is None or not value.strip():
        return None
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    except ValueError:
        return None


def _window(headers: httpx.Headers, prefix: str) -> RateLimitWindow | None:
    used = _finite_header(headers, f"x-codex-{prefix}-used-percent")
    if used is None:
        return None
    return RateLimitWindow(
        used_percent=used,
        window_minutes=_finite_header(headers, f"x-codex-{prefix}-window-minutes"),
        resets_at=_finite_header(headers, f"x-codex-{prefix}-reset-at"),
    )


def parse_rate_limit_headers(headers: httpx.Headers) -> RateLimitSnapshot:
    """Parses finite backend rate-limit headers without credentials."""
    return RateLimitSnapshot(
        primary=_window(headers, "primary"), secondary=_window(headers, "secondary")
    )


def _retry_after(headers: httpx.Headers) -> int | None:
    raw = headers.get("retry-after")
    if raw is None:
        return None
    try:
        seconds = float(raw)
        if math.isfinite(seconds):
            return max(0, int(seconds * 1000))
    except ValueError:
        pass
    try:
        parsed = email.utils.parsedate_to_datetime(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return max(0, int(parsed.timestamp() * 1000 - time.time() * 1000))
    except (TypeError, ValueError, OverflowError):
        return None


class SubscriptionAI:
    """Streams subscription responses for one immutable, explicit subject."""

    def __init__(
        self,
        session: AuthSession,
        subject: str,
        *,
        client: httpx.AsyncClient | None = None,
        protocol: ProtocolConfig = PROTOCOL,
        session_id: str | None = None,
        on_rate_limits: Callable[[RateLimitSnapshot], None] | None = None,
    ) -> None:
        if not subject:
            raise ValueError("subject must be nonempty")
        self._session = session
        self._subject = subject
        self._client = client or httpx.AsyncClient()
        self._owns_client = client is None
        separator = "&" if "?" in protocol.responses_url else "?"
        # The backend rejects requests without client_version (400 missing query param).
        self._endpoint = f"{protocol.responses_url}{separator}client_version={protocol.client_version}"
        self._session_id = session_id or str(uuid.uuid4())
        self._on_rate_limits = on_rate_limits
        self._last_rate_limits: RateLimitSnapshot | None = None

    @property
    def last_rate_limits(self) -> RateLimitSnapshot | None:
        """Returns the latest response-header snapshot without making a request."""
        return self._last_rate_limits

    async def __aenter__(self) -> SubscriptionAI:
        """Enters the async lifecycle for an owned HTTP client."""
        return self

    async def __aexit__(self, exc_type: object, exc: object, traceback: object) -> None:
        """Closes only the HTTP client created by this transport."""
        await self.aclose()

    async def aclose(self) -> None:
        """Closes only the HTTP client created by this transport."""
        if self._owns_client:
            await self._client.aclose()

    def _capture(self, snapshot: RateLimitSnapshot) -> None:
        self._last_rate_limits = snapshot
        try:
            if self._on_rate_limits is not None:
                self._on_rate_limits(snapshot)
        except Exception:
            pass

    async def _send(self, request: ResponseRequest, retried: bool) -> httpx.Response:
        access_token = (
            await self._session.refresh_access_token(self._subject)
            if retried
            else await self._session.get_access_token(self._subject)
        )
        status = await self._session.status(self._subject)
        headers = {
            "authorization": f"Bearer {access_token}",
            "openai-beta": "responses=experimental",
            "originator": "codex_cli_rs",
            "content-type": "application/json",
            "session_id": self._session_id,
        }
        if status is not None and status.account_id is not None:
            headers["chatgpt-account-id"] = status.account_id
        body: dict[str, JsonValue] = {
            "model": request.model,
            # The backend rejects bare-string input ("Input must be a list").
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": request.input}],
                }
            ]
            if isinstance(request.input, str)
            else [dict(item) for item in request.input],
            "parallel_tool_calls": False,
            "store": False,
            "stream": True,
        }
        if request.instructions is not None:
            body["instructions"] = request.instructions
        if request.tools is not None:
            body["tools"] = [dict(tool) for tool in request.tools]
        if request.tool_choice is not None:
            body["tool_choice"] = request.tool_choice
        if request.reasoning is not None:
            body["reasoning"] = dict(request.reasoning)
        if request.include is not None:
            body["include"] = list(request.include)
        try:
            prepared = self._client.build_request(
                "POST", self._endpoint, headers=headers, json=body
            )
            response = await self._client.send(prepared, stream=True)
        except httpx.HTTPError as error:
            message = redact(str(error))[:1024]
            raise TransportError(f"Subscription request failed: {message}") from error
        if response.status_code == 401:
            await response.aclose()
            if retried:
                raise AuthError("Authentication was rejected after one refresh retry.")
            return await self._send(request, True)
        if response.status_code == 429:
            await response.aclose()
            raise RateLimitError(_retry_after(response.headers))
        if not response.is_success:
            content = await response.aread()
            await response.aclose()
            snippet = redact(content.decode("utf-8", "replace")[:4096])[:1024]
            raise TransportError(
                f"Subscription transport failed ({response.status_code}): {snippet}"
            )
        return response

    async def stream(self, request: ResponseRequest) -> AsyncIterator[ResponseEvent]:
        """Streams parsed SSE events and forwards unknown future event types."""
        response = await self._send(request, False)
        snapshot = parse_rate_limit_headers(response.headers)
        try:
            async for event in parse_sse(response.aiter_bytes()):
                yield event
        except Exception as error:
            if isinstance(error, (AuthError, RateLimitError, TransportError)):
                raise
            raise TransportError(
                f"Subscription stream failed: {redact(str(error))[:1024]}"
            ) from error
        finally:
            await response.aclose()
            self._capture(snapshot)

    async def respond(self, request: ResponseRequest) -> ResponseResult:
        """Collects the same streaming path into text, events, and completion metadata."""
        events: list[ResponseEvent] = []
        output_text = ""
        completed: JsonValue = None
        async for event in self.stream(request):
            events.append(event)
            if event.type == "response.output_text.delta" and event.delta is not None:
                output_text += event.delta
            if event.type == "response.completed":
                completed = event.data
        return ResponseResult(output_text, tuple(events), completed)


def create_client(
    session: AuthSession,
    subject: str,
    *,
    client: httpx.AsyncClient | None = None,
    protocol: ProtocolConfig = PROTOCOL,
    session_id: str | None = None,
    on_rate_limits: Callable[[RateLimitSnapshot], None] | None = None,
) -> SubscriptionAI:
    """Creates a direct subscription transport bound to one explicit subject."""
    return SubscriptionAI(
        session,
        subject,
        client=client,
        protocol=protocol,
        session_id=session_id,
        on_rate_limits=on_rate_limits,
    )
