"""OAuth wire calls, token normalization, device polling, and failure classification."""

from __future__ import annotations

import asyncio
import email.utils
import json
import math
import time
from collections.abc import Awaitable, Callable, Mapping
from datetime import timezone
from typing import cast
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

from .jwt import extract_unverified_claims
from .pkce import assert_state, create_pkce
from .protocol import PROTOCOL, ProtocolConfig
from .redact import redact
from .types import (
    AuthError,
    DeviceLogin,
    JsonValue,
    PendingLogin,
    RateLimitError,
    TokenRefreshError,
    TokenSet,
    TransportError,
)

Clock = Callable[[], int]
Sleeper = Callable[[int], Awaitable[None]]


class TokenEndpointFailure(Exception):
    """Carries typed refresh-endpoint classification for the lifecycle layer."""

    def __init__(self, status: int, error_code: str | None, terminal: bool, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.error_code = error_code
        self.terminal = terminal


async def _default_sleep(milliseconds: int) -> None:
    await asyncio.sleep(milliseconds / 1000)


def _validate_subject(subject: str) -> None:
    if not subject:
        raise ValueError("subject must be nonempty")


def _retry_after(response: httpx.Response, now_ms: int) -> int | None:
    value = response.headers.get("retry-after")
    if value is None:
        return None
    try:
        seconds = float(value)
        if math.isfinite(seconds):
            return max(0, int(seconds * 1000))
    except ValueError:
        pass
    try:
        parsed = email.utils.parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return max(0, int(parsed.timestamp() * 1000) - now_ms)
    except (TypeError, ValueError, OverflowError):
        return None


def _json_object(response: httpx.Response, context: str) -> dict[str, JsonValue]:
    try:
        parsed = cast(object, response.json())
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise TransportError(f"{context} returned invalid JSON.") from error
    if not isinstance(parsed, dict) or not all(isinstance(key, str) for key in parsed):
        raise TransportError(f"{context} returned invalid JSON.")
    return cast(dict[str, JsonValue], parsed)


def _failure(response: httpx.Response, context: str, now_ms: int) -> None:
    body = redact(response.text[:65_536])
    snippet = body[:1_024]
    error_code: str | None = None
    try:
        parsed = cast(object, json.loads(response.text[:65_536]))
        if isinstance(parsed, dict):
            error = parsed.get("error")
            if isinstance(error, str):
                error_code = error
            elif isinstance(error, dict) and isinstance(error.get("code"), str):
                error_code = cast(str, error["code"])
    except json.JSONDecodeError:
        pass
    if response.status_code == 429:
        raise RateLimitError(_retry_after(response, now_ms))
    terminal = response.status_code in (401, 403) or (
        400 <= response.status_code < 500
        and error_code in ("invalid_grant", "invalid_token", "invalid_request")
    )
    message = f"{context} failed ({response.status_code}): {snippet}"
    if context == "refresh":
        raise TokenEndpointFailure(response.status_code, error_code, terminal, message)
    raise AuthError(message)


def _number(value: JsonValue) -> float:
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return math.nan
    try:
        return float(value)
    except (TypeError, ValueError):
        return math.nan


def _normalize_token(
    payload: Mapping[str, JsonValue], now_ms: int, previous: TokenSet | None = None
) -> TokenSet:
    access_token = payload.get("access_token")
    if not isinstance(access_token, str):
        raise TransportError("Token endpoint returned an invalid response.")
    expires_in = _number(payload.get("expires_in"))
    candidate = now_ms + expires_in * 1000
    expires_at = int(candidate) if math.isfinite(candidate) else now_ms
    response_refresh = payload.get("refresh_token")
    refresh_token = (
        response_refresh
        if isinstance(response_refresh, str)
        else (previous.refresh_token if previous else None)
    )
    if refresh_token is None:
        raise TransportError("Token endpoint omitted the refresh token.")
    response_id = payload.get("id_token")
    id_token = (
        response_id if isinstance(response_id, str) else (previous.id_token if previous else None)
    )
    claims = extract_unverified_claims(id_token, access_token)
    return TokenSet(
        access_token=access_token,
        refresh_token=refresh_token,
        id_token=id_token,
        expires_at=expires_at,
        account_id=claims.account_id,
        plan_type=claims.plan_type,
        email=claims.email,
        version=(previous.version if previous else 0) + 1,
    )


class OAuth:
    """Implements the asynchronous OAuth wire protocol without credential custody."""

    def __init__(
        self,
        *,
        client: httpx.AsyncClient,
        protocol: ProtocolConfig = PROTOCOL,
        now: Clock | None = None,
        sleep: Sleeper | None = None,
    ) -> None:
        self.protocol = protocol
        self._client = client
        self._now = now or (lambda: time.time_ns() // 1_000_000)
        self._sleep = sleep or _default_sleep

    async def begin_login(self, subject: str, redirect_uri: str | None = None) -> PendingLogin:
        """Creates protected PKCE state for one explicit subject without persisting it."""
        _validate_subject(subject)
        verifier, challenge, state = create_pkce()
        redirect = redirect_uri or self.protocol.loopback_redirect
        params = {
            "response_type": "code",
            "client_id": self.protocol.client_id,
            "redirect_uri": redirect,
            "scope": self.protocol.scopes,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
            **self.protocol.extra_auth_params,
        }
        return PendingLogin(
            url=f"{self.protocol.authorize_url}?{urlencode(params)}",
            state=state,
            verifier=verifier,
            redirect_uri=redirect,
        )

    async def _exchange(
        self,
        code: str,
        verifier: str,
        redirect_uri: str,
        previous: TokenSet | None = None,
    ) -> TokenSet:
        try:
            response = await self._client.post(
                self.protocol.token_url,
                data={
                    "grant_type": "authorization_code",
                    "client_id": self.protocol.client_id,
                    "code": code,
                    "code_verifier": verifier,
                    "redirect_uri": redirect_uri,
                },
                headers={"content-type": "application/x-www-form-urlencoded"},
            )
        except httpx.HTTPError as error:
            message = redact(str(error))
            raise TransportError(
                f"Authorization code exchange failed due to a network error: {message}"
            ) from error
        if not response.is_success:
            _failure(response, "code exchange", self._now())
        return _normalize_token(_json_object(response, "OAuth endpoint"), self._now(), previous)

    async def complete_login(
        self, subject: str, callback_url: str, pending: PendingLogin
    ) -> TokenSet:
        """Validates state first and exchanges one subject's callback code."""
        _validate_subject(subject)
        query = parse_qs(urlparse(callback_url).query, keep_blank_values=True)
        state_values = query.get("state")
        actual_state = state_values[0] if state_values else None
        assert_state(pending.state, actual_state)
        if "error" in query:
            raise AuthError(f"Authorization failed: {redact(query['error'][0])}")
        code = query.get("code", [""])[0]
        if not code:
            raise AuthError("Authorization callback omitted the code.")
        return await self._exchange(code, pending.verifier, pending.redirect_uri)

    async def refresh(self, previous: TokenSet) -> TokenSet:
        """Refreshes one exact credential generation with bounded transient retries."""
        for attempt in range(3):
            try:
                response = await self._client.post(
                    self.protocol.token_url,
                    data={
                        "grant_type": "refresh_token",
                        "client_id": self.protocol.client_id,
                        "refresh_token": previous.refresh_token,
                        "scope": self.protocol.scopes,
                    },
                    headers={"content-type": "application/x-www-form-urlencoded"},
                )
            except httpx.HTTPError as error:
                if attempt < 2:
                    await self._sleep(250 * 2**attempt)
                    continue
                raise TokenRefreshError(
                    f"Token refresh failed due to a network error: {redact(str(error))}"
                ) from error
            if response.status_code >= 500 and attempt < 2:
                await self._sleep(250 * 2**attempt)
                continue
            if response.status_code == 429 and attempt < 2:
                retry_delay = _retry_after(response, self._now())
                await self._sleep(retry_delay if retry_delay is not None else 250 * 2**attempt)
                continue
            if not response.is_success:
                _failure(response, "refresh", self._now())
            try:
                return _normalize_token(
                    _json_object(response, "OAuth endpoint"), self._now(), previous
                )
            except TransportError as error:
                raise TokenRefreshError("Token refresh returned an invalid response.") from error
        raise TokenRefreshError

    async def start_device_login(
        self, subject: str, on_complete: Callable[[TokenSet], Awaitable[TokenSet]]
    ) -> DeviceLogin:
        """Starts one subject's device flow and returns its polling handle."""
        _validate_subject(subject)
        try:
            response = await self._client.post(
                self.protocol.device_usercode_url,
                json={"client_id": self.protocol.client_id},
                headers={"accept": "application/json", "content-type": "application/json"},
            )
        except httpx.HTTPError as error:
            raise TransportError(
                f"Device authorization failed due to a network error: {redact(str(error))}"
            ) from error
        if not response.is_success:
            _failure(response, "device authorization", self._now())
        payload = _json_object(response, "OAuth endpoint")
        user_code_value = payload.get("user_code", payload.get("usercode"))
        device_auth_id = payload.get("device_auth_id")
        if not isinstance(user_code_value, str) or not isinstance(device_auth_id, str):
            raise TransportError("Device authorization returned an invalid response.")
        interval_value = payload.get("interval")
        expires_value = payload.get("expires_in")
        interval = (
            int(interval_value * 1000)
            if isinstance(interval_value, (int, float)) and not isinstance(interval_value, bool)
            else 5000
        )
        expires_at = self._now() + (
            int(expires_value * 1000)
            if isinstance(expires_value, (int, float)) and not isinstance(expires_value, bool)
            else 900_000
        )

        async def wait() -> TokenSet:
            nonlocal interval
            while self._now() < expires_at:
                await self._sleep(interval)
                if self._now() >= expires_at:
                    break
                try:
                    poll = await self._client.post(
                        self.protocol.device_poll_url,
                        json={"device_auth_id": device_auth_id, "user_code": user_code_value},
                        headers={
                            "accept": "application/json",
                            "content-type": "application/json",
                        },
                    )
                except httpx.HTTPError as error:
                    diagnostic = redact(str(error))
                    raise TransportError(
                        f"Device authorization poll failed due to a network error: {diagnostic}"
                    ) from error
                try:
                    poll_body = _json_object(poll, "OAuth endpoint")
                except TransportError:
                    if poll.status_code not in (403, 404):
                        raise
                    poll_body = {}
                poll_error = poll_body.get("error")
                if poll_error == "authorization_pending" or poll.status_code in (403, 404):
                    continue
                if poll_error == "slow_down":
                    interval += 5000
                    continue
                if not poll.is_success:
                    raise AuthError(f"Device authorization failed ({poll.status_code}).")
                code = poll_body.get("authorization_code")
                verifier = poll_body.get("code_verifier")
                if not isinstance(code, str) or not isinstance(verifier, str):
                    raise TransportError("Device poll returned an invalid success response.")
                token = await self._exchange(code, verifier, self.protocol.device_redirect_url)
                return await on_complete(token)
            raise AuthError("Device authorization expired.")

        return DeviceLogin(user_code_value, self.protocol.device_verify_url, expires_at, wait)
