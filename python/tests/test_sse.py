from collections.abc import AsyncIterator

import httpx
import pytest
import respx

from chatgpt_oauth import (
    AuthError,
    AuthSession,
    ResponseRequest,
    TokenSet,
    create_client,
    create_memory_store,
    parse_sse,
)


async def chunks() -> AsyncIterator[bytes]:
    for value in (
        b"event: response.output_",
        b'text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
        b"event: future.event\ndata: first\ndata: second\n\n",
        b"data: [DO",
        b"NE]\r",
        b"\n\r\n",
        b"data: after\n\n",
    ):
        yield value


@pytest.mark.asyncio
async def test_chunk_split_multiline_done_and_unknown_events() -> None:
    events = [event async for event in parse_sse(chunks())]
    assert len(events) == 2
    assert events[0].type == "response.output_text.delta"
    assert events[0].delta == "Hi"
    assert events[1].type == "future.event"
    assert events[1].data == "first\nsecond"


@pytest.mark.asyncio
@respx.mock
async def test_client_retries_one_401_and_collects_the_stream() -> None:
    responses = respx.post("https://chatgpt.com/backend-api/codex/responses")
    responses.side_effect = [
        httpx.Response(401),
        httpx.Response(
            200,
            text=(
                'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n'
                'data: {"type":"response.completed","response":{"id":"r"}}\n\n'
                "data: [DONE]\n\n"
            ),
        ),
    ]
    respx.post("https://auth.openai.com/oauth/token").mock(
        return_value=httpx.Response(
            200, json={"access_token": "new", "refresh_token": "refresh", "expires_in": 3600}
        )
    )
    async with httpx.AsyncClient() as client:
        auth = AuthSession(
            store=create_memory_store({"subject": TokenSet("old", "refresh", 9_999_999, 1)}),
            client=client,
            now=lambda: 0,
        )
        ai = create_client(auth, "subject", client=client)
        result = await ai.respond(ResponseRequest("model", "hello"))
    assert result.output_text == "Hi"
    assert len(result.events) == 2
    assert responses.call_count == 2


@pytest.mark.asyncio
@respx.mock
async def test_client_second_401_is_typed_and_bounded() -> None:
    responses = respx.post("https://chatgpt.com/backend-api/codex/responses").mock(
        return_value=httpx.Response(401)
    )
    respx.post("https://auth.openai.com/oauth/token").mock(
        return_value=httpx.Response(
            200, json={"access_token": "new", "refresh_token": "refresh", "expires_in": 3600}
        )
    )
    async with httpx.AsyncClient() as client:
        auth = AuthSession(
            store=create_memory_store({"subject": TokenSet("old", "refresh", 9_999_999, 1)}),
            client=client,
            now=lambda: 0,
        )
        ai = create_client(auth, "subject", client=client)
        with pytest.raises(AuthError):
            await ai.respond(ResponseRequest("model", "hello"))
    assert responses.call_count == 2
