import asyncio
from urllib.parse import parse_qs, urlencode, urlparse

import httpx
import pytest
import respx

from chatgpt_oauth import AuthSession, create_memory_store, login_with_loopback

SUBJECT = "app-user-42"
TOKEN_URL = "https://auth.openai.com/oauth/token"
LOOPBACK_PORT = 18_455


def _callback_query(authorize_url: str) -> str:
    """Builds a valid `/auth/callback` query from an authorize URL's `state`."""
    state = parse_qs(urlparse(authorize_url).query)["state"][0]
    return urlencode({"state": state, "code": "test-code"})


async def _send_callback(port: int, query: str) -> None:
    """Connects to the just-started loopback server and fires the OAuth callback."""
    deadline = asyncio.get_running_loop().time() + 5
    while True:
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            break
        except OSError:
            if asyncio.get_running_loop().time() > deadline:
                raise
            await asyncio.sleep(0.01)
    writer.write(f"GET /auth/callback?{query} HTTP/1.1\r\nHost: localhost\r\n\r\n".encode())
    await writer.drain()
    await reader.read()
    writer.close()
    await writer.wait_closed()


@pytest.mark.asyncio
@respx.mock
async def test_login_with_loopback_composes_begin_wait_and_complete() -> None:
    respx.post(TOKEN_URL).mock(
        return_value=httpx.Response(
            200, json={"access_token": "new", "refresh_token": "refresh", "expires_in": 3600}
        )
    )
    opened: list[str] = []

    def open_url(url: str) -> None:
        opened.append(url)
        asyncio.get_running_loop().create_task(
            _send_callback(LOOPBACK_PORT, _callback_query(url))
        )

    async with httpx.AsyncClient() as client:
        auth = AuthSession(store=create_memory_store(), client=client, now=lambda: 0)
        token = await login_with_loopback(auth, SUBJECT, open=open_url, port=LOOPBACK_PORT)

    assert token.access_token == "new"
    assert len(opened) == 1 and opened[0].startswith("https://auth.openai.com/oauth/authorize?")
    assert await auth.get_access_token(SUBJECT) == "new"


@pytest.mark.asyncio
@respx.mock
async def test_login_with_loopback_default_open_prints_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    respx.post(TOKEN_URL).mock(
        return_value=httpx.Response(
            200, json={"access_token": "new", "refresh_token": "refresh", "expires_in": 3600}
        )
    )
    printed: list[str] = []

    def capturing_print(message: str) -> None:
        printed.append(message)
        url = message.removeprefix("Open ")
        asyncio.get_running_loop().create_task(
            _send_callback(LOOPBACK_PORT + 1, _callback_query(url))
        )

    monkeypatch.setattr("chatgpt_oauth.loopback.print", capturing_print, raising=False)

    async with httpx.AsyncClient() as client:
        auth = AuthSession(store=create_memory_store(), client=client, now=lambda: 0)
        token = await login_with_loopback(auth, SUBJECT, port=LOOPBACK_PORT + 1)

    assert token.access_token == "new"
    assert len(printed) == 1 and printed[0].startswith("Open https://")
