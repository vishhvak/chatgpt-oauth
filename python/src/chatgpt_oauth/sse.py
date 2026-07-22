"""Incremental server-sent event framing across arbitrary byte chunks."""

from __future__ import annotations

import codecs
import json
from collections.abc import AsyncIterable, AsyncIterator
from typing import cast

from .types import JsonValue, ResponseEvent


def _parse_block(block: str) -> ResponseEvent | str | None:
    event_name = "message"
    data: list[str] = []
    for line in block.split("\n"):
        if line.startswith(":"):
            continue
        field, separator, value = line.partition(":")
        if not separator:
            value = ""
        elif value.startswith(" "):
            value = value[1:]
        if field == "event":
            event_name = value
        elif field == "data":
            data.append(value)
    if not data:
        return None
    joined = "\n".join(data)
    if joined == "[DONE]":
        return "done"
    parsed: JsonValue = joined
    try:
        loaded = cast(object, json.loads(joined))
        if isinstance(loaded, (str, int, float, bool, list, dict)) or loaded is None:
            parsed = cast(JsonValue, loaded)
    except json.JSONDecodeError:
        pass
    event_type = event_name
    delta: str | None = None
    if isinstance(parsed, dict):
        candidate_type = parsed.get("type")
        candidate_delta = parsed.get("delta")
        if isinstance(candidate_type, str):
            event_type = candidate_type
        if isinstance(candidate_delta, str):
            delta = candidate_delta
    return ResponseEvent(event_type, parsed, delta)


async def parse_sse(body: AsyncIterable[bytes]) -> AsyncIterator[ResponseEvent]:
    """Yields SSE events, forwarding opaque data and unknown event types."""
    decoder = codecs.getincrementaldecoder("utf-8")()
    buffer = ""
    async for chunk in body:
        buffer += decoder.decode(chunk)
        buffer = buffer.replace("\r\n", "\n")
        if buffer.endswith("\r"):
            preserved = "\r"
            buffer = buffer[:-1].replace("\r", "\n") + preserved
        else:
            buffer = buffer.replace("\r", "\n")
        boundary = buffer.find("\n\n")
        while boundary != -1:
            event = _parse_block(buffer[:boundary])
            buffer = buffer[boundary + 2 :]
            if event == "done":
                return
            if isinstance(event, ResponseEvent):
                yield event
            boundary = buffer.find("\n\n")
    buffer += decoder.decode(b"", final=True)
    buffer = buffer.replace("\r\n", "\n").replace("\r", "\n")
    final = _parse_block(buffer)
    if isinstance(final, ResponseEvent):
        yield final
