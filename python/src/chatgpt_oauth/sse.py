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
    """Yields SSE events, forwarding opaque data and unknown event types.

    Only the newly appended suffix of each chunk is normalized and scanned for a
    ``\\n\\n`` boundary — re-scanning the whole accumulated buffer on every chunk
    is O(n^2) for one large event split across many small chunks. A bare ``\\r``
    at a chunk boundary is deferred (`pending_cr`) until the next chunk arrives,
    since a following ``\\n`` must still collapse with it into a single newline.
    """
    decoder = codecs.getincrementaldecoder("utf-8")()
    buffer = ""
    pending_cr = False
    search_from = 0
    async for chunk in body:
        decoded = decoder.decode(chunk)
        if pending_cr:
            decoded = "\r" + decoded
            pending_cr = False
        if not decoded:
            continue
        if decoded.endswith("\r"):
            pending_cr = True
            decoded = decoded[:-1]
        buffer += decoded.replace("\r\n", "\n").replace("\r", "\n")
        boundary = buffer.find("\n\n", search_from)
        while boundary != -1:
            event = _parse_block(buffer[:boundary])
            buffer = buffer[boundary + 2 :]
            search_from = 0
            if event == "done":
                return
            if isinstance(event, ResponseEvent):
                yield event
            boundary = buffer.find("\n\n", search_from)
        search_from = max(0, len(buffer) - 1)
    if pending_cr:
        buffer += "\n"
    buffer += decoder.decode(b"", final=True)
    buffer = buffer.replace("\r\n", "\n").replace("\r", "\n")
    final = _parse_block(buffer)
    if isinstance(final, ResponseEvent):
        yield final
