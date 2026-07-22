"""Subject-scoped lifecycle with singleflight refresh, CAS, quarantine, and kill switch."""

from __future__ import annotations

import asyncio
import time
import weakref
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from typing import cast

import httpx

from .oauth import Clock, OAuth, Sleeper, TokenEndpointFailure, _validate_subject
from .protocol import PROTOCOL, ProtocolConfig
from .types import (
    AuthError,
    CredentialStore,
    DeviceLogin,
    DisabledError,
    PendingLogin,
    ReauthRequired,
    Session,
    TokenRefreshError,
    TokenSet,
)


@dataclass(frozen=True, slots=True)
class _RefreshResult:
    token: TokenSet
    refreshed: bool


_Flight = asyncio.Task[_RefreshResult]
_flights_by_store: weakref.WeakKeyDictionary[object, dict[str, tuple[bool, _Flight]]] = (
    weakref.WeakKeyDictionary()
)


class AuthSession:
    """Coordinates credentials for explicit subjects without ambient identity."""

    def __init__(
        self,
        *,
        store: CredentialStore,
        client: httpx.AsyncClient | None = None,
        now: Clock | None = None,
        sleep: Sleeper | None = None,
        disabled: Callable[[], bool] | None = None,
        protocol: ProtocolConfig = PROTOCOL,
    ) -> None:
        self._store = store
        self._client = client or httpx.AsyncClient()
        self._owns_client = client is None
        self._now = now or (lambda: time.time_ns() // 1_000_000)
        self._disabled = disabled or (lambda: False)
        self._protocol = protocol
        self._oauth = OAuth(client=self._client, protocol=protocol, now=self._now, sleep=sleep)
        store_key = cast(object, store)
        flights = _flights_by_store.get(store_key)
        if flights is None:
            flights = {}
            _flights_by_store[store_key] = flights
        self._flights = flights

    async def __aenter__(self) -> AuthSession:
        """Enters the async lifecycle for an owned HTTP client."""
        return self

    async def __aexit__(self, exc_type: object, exc: object, traceback: object) -> None:
        """Closes only the HTTP client created by this session."""
        await self.aclose()

    async def aclose(self) -> None:
        """Closes only the HTTP client created by this session."""
        if self._owns_client:
            await self._client.aclose()

    def _check_enabled(self) -> None:
        if self._disabled():
            raise DisabledError

    async def begin_login(self, subject: str, redirect_uri: str | None = None) -> PendingLogin:
        """Creates protected login state for one explicit subject."""
        self._check_enabled()
        return await self._oauth.begin_login(subject, redirect_uri)

    async def _persist_fresh(self, subject: str, token: TokenSet) -> TokenSet:
        current = await self._store.load(subject)
        expected = current.version if current else 0
        next_token = replace(
            token,
            version=expected + 1,
            quarantined_at=None,
            quarantine_reason=None,
        )
        saved = await self._store.compare_and_swap(subject, expected, next_token)
        if saved.ok:
            return next_token
        if saved.current is not None:
            return saved.current
        raise AuthError("Credentials changed while sign-in completed.")

    async def complete_login(
        self, subject: str, callback_url: str, pending: PendingLogin
    ) -> TokenSet:
        """Exchanges and atomically persists one explicit subject's fresh login."""
        self._check_enabled()
        _validate_subject(subject)
        return await self._persist_fresh(
            subject, await self._oauth.complete_login(subject, callback_url, pending)
        )

    async def start_device_login(self, subject: str) -> DeviceLogin:
        """Starts and binds a device login to one explicit subject."""
        self._check_enabled()
        _validate_subject(subject)

        async def persist(token: TokenSet) -> TokenSet:
            self._check_enabled()
            return await self._persist_fresh(subject, token)

        return await self._oauth.start_device_login(subject, persist)

    async def _quarantine(self, subject: str, token: TokenSet, reason: str) -> TokenSet:
        marker = replace(
            token,
            version=token.version + 1,
            quarantined_at=self._now(),
            quarantine_reason=reason,
        )
        result = await self._store.compare_and_swap(subject, token.version, marker)
        current = result.current
        if not result.ok and current is not None and current.quarantined_at is None:
            return current
        raise ReauthRequired(subject, (current.quarantine_reason if current else None) or reason)

    async def _refresh_one(self, subject: str, force: bool) -> _RefreshResult:
        self._check_enabled()
        current = await self._store.load(subject)
        if current is None:
            raise ReauthRequired(subject, "missing_credentials")
        if current.quarantined_at is not None:
            raise ReauthRequired(subject, current.quarantine_reason or "quarantined")
        if not force and current.expires_at - self._now() >= self._protocol.refresh_margin_ms:
            return _RefreshResult(current, False)
        try:
            next_token = await self._oauth.refresh(current)
            swapped = await self._store.compare_and_swap(subject, current.version, next_token)
            if swapped.ok:
                return _RefreshResult(next_token, True)
            if swapped.current is not None and swapped.current.quarantined_at is not None:
                raise ReauthRequired(subject, swapped.current.quarantine_reason or "quarantined")
            if swapped.current is not None:
                return _RefreshResult(swapped.current, True)
            raise ReauthRequired(subject, "credentials_deleted_during_refresh")
        except TokenEndpointFailure as error:
            if error.terminal:
                winner = await self._quarantine(
                    subject, current, error.error_code or f"http_{error.status}"
                )
                return _RefreshResult(winner, True)
            raise TokenRefreshError(f"Token refresh failed ({error.status}).") from error

    def _in_flight(self, subject: str, force: bool) -> Awaitable[_RefreshResult]:
        existing = self._flights.get(subject)
        if existing is not None:
            existing_force, task = existing
            if not force or existing_force:
                return task

            async def force_after_nonforce() -> _RefreshResult:
                result = await task
                return result if result.refreshed else await self._in_flight(subject, True)

            return force_after_nonforce()

        async def run() -> _RefreshResult:
            try:
                return await self._refresh_one(subject, force)
            finally:
                current_task = asyncio.current_task()
                current = self._flights.get(subject)
                if current is not None and current[1] is current_task:
                    del self._flights[subject]

        created = asyncio.create_task(run())
        self._flights[subject] = (force, created)
        return created

    async def get_access_token(self, subject: str) -> str:
        """Returns one subject's token, sharing refresh work when stale."""
        _validate_subject(subject)
        self._check_enabled()
        token = await self._store.load(subject)
        if token is None:
            raise ReauthRequired(subject, "missing_credentials")
        if token.quarantined_at is not None:
            raise ReauthRequired(subject, token.quarantine_reason or "quarantined")
        if token.expires_at - self._now() >= self._protocol.refresh_margin_ms:
            return token.access_token
        return (await self._in_flight(subject, False)).token.access_token

    async def refresh_access_token(self, subject: str) -> str:
        """Forces one subject through the singleflight refresh path."""
        _validate_subject(subject)
        self._check_enabled()
        return (await self._in_flight(subject, True)).token.access_token

    async def status(self, subject: str) -> Session | None:
        """Loads safe status for one subject without exposing credentials."""
        _validate_subject(subject)
        self._check_enabled()
        token = await self._store.load(subject)
        if token is None:
            return None
        return Session(
            subject=subject,
            status="quarantined" if token.quarantined_at is not None else "connected",
            expires_at=token.expires_at,
            account_id=token.account_id,
            plan_type=token.plan_type,
            email=token.email,
            reason=token.quarantine_reason,
        )

    async def logout(self, subject: str) -> None:
        """Deletes credentials for one explicit subject without remote revocation."""
        _validate_subject(subject)
        await self._store.delete(subject)
