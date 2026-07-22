import asyncio
from dataclasses import replace

import httpx
import pytest
import respx

from chatgpt_oauth import (
    AuthSession,
    DisabledError,
    ReauthRequired,
    TokenSet,
    create_memory_store,
)
from chatgpt_oauth.types import CompareAndSwapResult

SUBJECT = "app-user-42"
TOKEN_URL = "https://auth.openai.com/oauth/token"


def token(**overrides: object) -> TokenSet:
    base = TokenSet("access-old", "refresh-old", 1, 1)
    return replace(base, **overrides)


@pytest.mark.asyncio
@respx.mock
async def test_twenty_callers_share_one_refresh() -> None:
    route = respx.post(TOKEN_URL).mock(
        return_value=httpx.Response(
            200,
            json={"access_token": "access-new", "refresh_token": "refresh-new", "expires_in": 3600},
        )
    )
    async with httpx.AsyncClient() as client:
        auth = AuthSession(
            store=create_memory_store({SUBJECT: token()}), client=client, now=lambda: 10_000
        )
        values = await asyncio.gather(*(auth.get_access_token(SUBJECT) for _ in range(20)))
    assert set(values) == {"access-new"}
    assert route.call_count == 1


class RacingStore:
    def __init__(self) -> None:
        self.current = token(expires_at=10_500)
        self.loads = 0
        self.flight_started = asyncio.Event()
        self.unblock = asyncio.Event()

    async def load(self, subject: str) -> TokenSet | None:
        self.loads += 1
        if self.loads == 2:
            self.flight_started.set()
            await self.unblock.wait()
        return replace(self.current)

    async def compare_and_swap(
        self, subject: str, expected_version: int, next_token: TokenSet
    ) -> CompareAndSwapResult:
        if self.current.version != expected_version:
            return CompareAndSwapResult(False, replace(self.current))
        self.current = replace(next_token, version=expected_version + 1)
        return CompareAndSwapResult(True, replace(self.current))

    async def delete(self, subject: str) -> None:
        return None


@pytest.mark.asyncio
@respx.mock
async def test_forced_refresh_does_not_settle_on_nonforce_skip() -> None:
    store = RacingStore()
    route = respx.post(TOKEN_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "access_token": "access-forced",
                "refresh_token": "refresh-forced",
                "expires_in": 3600,
            },
        )
    )
    async with httpx.AsyncClient() as client:
        auth = AuthSession(store=store, client=client, now=lambda: 10_000)
        opportunistic = asyncio.create_task(auth.get_access_token(SUBJECT))
        await store.flight_started.wait()
        forced = asyncio.create_task(auth.refresh_access_token(SUBJECT))
        store.current = token(
            access_token="access-rotated",
            refresh_token="refresh-rotated",
            expires_at=9_999_999,
            version=2,
        )
        store.unblock.set()
        assert await asyncio.gather(opportunistic, forced) == ["access-rotated", "access-forced"]
    assert route.call_count == 1


class WinnerStore:
    def __init__(self, winner: TokenSet) -> None:
        self.current = token()
        self.winner = winner

    async def load(self, subject: str) -> TokenSet | None:
        return replace(self.current)

    async def compare_and_swap(
        self, subject: str, expected_version: int, next_token: TokenSet
    ) -> CompareAndSwapResult:
        return CompareAndSwapResult(False, replace(self.winner))

    async def delete(self, subject: str) -> None:
        return None


@pytest.mark.asyncio
@respx.mock
async def test_cas_loser_adopts_healthy_winner() -> None:
    winner = token(
        access_token="winner-access",
        refresh_token="winner-refresh",
        expires_at=9_999_999,
        version=2,
    )
    respx.post(TOKEN_URL).mock(
        return_value=httpx.Response(200, json={"access_token": "loser", "expires_in": 3600})
    )
    async with httpx.AsyncClient() as client:
        auth = AuthSession(store=WinnerStore(winner), client=client, now=lambda: 10_000)
        assert await auth.get_access_token(SUBJECT) == "winner-access"


@pytest.mark.asyncio
@respx.mock
async def test_terminal_failure_quarantines() -> None:
    terminal_store = create_memory_store({SUBJECT: token()})
    terminal = respx.post(TOKEN_URL).mock(
        return_value=httpx.Response(400, json={"error": "invalid_grant"})
    )
    async with httpx.AsyncClient() as client:
        auth = AuthSession(store=terminal_store, client=client, now=lambda: 10_000)
        with pytest.raises(ReauthRequired):
            await auth.get_access_token(SUBJECT)
        with pytest.raises(ReauthRequired):
            await auth.get_access_token(SUBJECT)
    assert terminal.call_count == 1
    quarantined = await terminal_store.load(SUBJECT)
    assert quarantined is not None and quarantined.quarantine_reason == "invalid_grant"


# Kept apart from the terminal case: respx dedupes identically-patterned routes,
# so one shared route would leak call counts between the two phases.
@pytest.mark.asyncio
@respx.mock
async def test_429_retries_bounded_and_never_quarantines() -> None:
    limited_store = create_memory_store({SUBJECT: token()})
    limited = respx.post(TOKEN_URL).mock(return_value=httpx.Response(429, text="limited"))
    async with httpx.AsyncClient() as client:
        auth = AuthSession(
            store=limited_store,
            client=client,
            now=lambda: 10_000,
            sleep=lambda _: asyncio.sleep(0),
        )
        from chatgpt_oauth import RateLimitError

        with pytest.raises(RateLimitError):
            await auth.get_access_token(SUBJECT)
    stored = await limited_store.load(SUBJECT)
    assert stored is not None and stored.quarantined_at is None
    assert limited.call_count == 3


@pytest.mark.asyncio
async def test_kill_switch_precedes_store_load_and_subject_is_mandatory() -> None:
    store = create_memory_store({SUBJECT: token()})
    auth = AuthSession(store=store, disabled=lambda: True)
    with pytest.raises(DisabledError):
        await auth.get_access_token(SUBJECT)
    with pytest.raises(DisabledError):
        await auth.status(SUBJECT)
    with pytest.raises(ValueError):
        await auth.logout("")
    await auth.aclose()
