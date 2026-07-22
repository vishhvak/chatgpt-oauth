import httpx
import pytest
import respx

from chatgpt_oauth import AuthSession, PendingLogin, create_memory_store

SUBJECT = "app-user-42"
TOKEN_URL = "https://auth.openai.com/oauth/token"
DEVICE_START = "https://auth.openai.com/api/accounts/deviceauth/usercode"
DEVICE_POLL = "https://auth.openai.com/api/accounts/deviceauth/token"


def pending() -> PendingLogin:
    return PendingLogin(
        "https://auth.example/authorize", "state", "verifier", "http://localhost:1455/auth/callback"
    )


@pytest.mark.asyncio
@respx.mock
async def test_string_and_invalid_expiry_normalization() -> None:
    route = respx.post(TOKEN_URL)
    route.side_effect = [
        httpx.Response(200, json={"access_token": "a", "refresh_token": "r", "expires_in": "3600"}),
        httpx.Response(200, json={"access_token": "b", "refresh_token": "r", "expires_in": "bad"}),
    ]
    async with httpx.AsyncClient() as client:
        auth = AuthSession(store=create_memory_store(), client=client, now=lambda: 1000)
        first = await auth.complete_login(
            SUBJECT, "http://localhost:1455/auth/callback?state=state&code=one", pending()
        )
        second = await auth.complete_login(
            "other", "http://localhost:1455/auth/callback?state=state&code=two", pending()
        )
    assert first.expires_at == 3_601_000
    assert second.expires_at == 1000


@pytest.mark.asyncio
@respx.mock
async def test_device_pending_slow_down_and_success() -> None:
    clock = 0
    sleeps: list[int] = []

    async def sleep(milliseconds: int) -> None:
        nonlocal clock
        sleeps.append(milliseconds)
        clock += milliseconds

    respx.post(DEVICE_START).mock(
        return_value=httpx.Response(
            200,
            json={"user_code": "ABCD", "device_auth_id": "device", "interval": 1, "expires_in": 60},
        )
    )
    polls = respx.post(DEVICE_POLL)
    polls.side_effect = [
        httpx.Response(403, json={"error": "authorization_pending"}),
        httpx.Response(403),
        httpx.Response(400, json={"error": "slow_down"}),
        httpx.Response(200, json={"authorization_code": "code", "code_verifier": "verifier"}),
    ]
    respx.post(TOKEN_URL).mock(
        return_value=httpx.Response(
            200, json={"access_token": "new", "refresh_token": "refresh", "expires_in": 3600}
        )
    )
    async with httpx.AsyncClient() as client:
        auth = AuthSession(
            store=create_memory_store(), client=client, now=lambda: clock, sleep=sleep
        )
        device = await auth.start_device_login(SUBJECT)
        saved = await device.wait()
    assert saved.access_token == "new"
    assert sleeps == [1000, 1000, 1000, 6000]


@pytest.mark.asyncio
@respx.mock
async def test_callback_state_precedes_oauth_error() -> None:
    from chatgpt_oauth import StateMismatchError

    async with httpx.AsyncClient() as client:
        auth = AuthSession(store=create_memory_store(), client=client)
        with pytest.raises(StateMismatchError):
            await auth.complete_login(
                SUBJECT,
                "http://localhost:1455/auth/callback?state=wrong&error=access_denied",
                pending(),
            )
    assert not respx.calls
