"""One-shot OAuth callback listener bound only to IPv4 loopback."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from urllib.parse import parse_qs, urlparse

from .pkce import assert_state
from .session import AuthSession
from .types import AuthError, PendingLogin, TokenSet, TransportError

_SUCCESS = (
    b"<!doctype html><meta charset=utf-8><title>Signed in</title>"
    b"<h1>Sign-in complete</h1><p>You may close this window.</p>"
)
_FAILURE = (
    b"<!doctype html><meta charset=utf-8><title>Sign-in failed</title>"
    b"<h1>Sign-in failed</h1><p>Return to the application and try again.</p>"
)


async def _reply(writer: asyncio.StreamWriter, status: str, content_type: str, body: bytes) -> None:
    writer.write(
        (
            f"HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\n"
            f"Cache-Control: no-store\r\nContent-Length: {len(body)}\r\n"
            "Connection: close\r\n\r\n"
        ).encode()
        + body
    )
    await writer.drain()
    writer.close()
    await writer.wait_closed()


async def wait_for_loopback_callback(
    pending: PendingLogin, *, port: int | None = None, timeout_ms: int = 300_000
) -> str:
    """Waits for the first valid callback while ignoring hostile local probes."""
    bind_port = port if port is not None else int(urlparse(pending.redirect_uri).port or 1455)
    loop = asyncio.get_running_loop()
    result: asyncio.Future[str] = loop.create_future()

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request_line = (await reader.readline()).decode("ascii", "replace").rstrip("\r\n")
            while await reader.readline() not in (b"\r\n", b"\n", b""):
                pass
            parts = request_line.split(" ")
            target = parts[1] if len(parts) >= 2 else "/"
            callback = urlparse(target)
            if callback.path != "/auth/callback":
                await _reply(writer, "404 Not Found", "text/plain; charset=utf-8", b"Not found")
                return
            query = parse_qs(callback.query, keep_blank_values=True)
            try:
                state_values = query.get("state")
                assert_state(pending.state, state_values[0] if state_values else None)
            except Exception:
                await _reply(writer, "400 Bad Request", "text/html; charset=utf-8", _FAILURE)
                return
            error = query.get("error", [""])[0]
            if error:
                await _reply(writer, "400 Bad Request", "text/html; charset=utf-8", _FAILURE)
                if not result.done():
                    result.set_exception(AuthError("Authorization callback was rejected."))
                return
            code = query.get("code", [""])[0]
            if not code:
                await _reply(writer, "400 Bad Request", "text/html; charset=utf-8", _FAILURE)
                return
            await _reply(writer, "200 OK", "text/html; charset=utf-8", _SUCCESS)
            if not result.done():
                result.set_result(f"http://localhost:{bind_port}{target}")
        except Exception as error:
            writer.close()
            if not result.done():
                result.set_exception(TransportError("OAuth loopback server failed."))

    try:
        server = await asyncio.start_server(handle, "127.0.0.1", bind_port)
    except OSError as error:
        raise TransportError("OAuth loopback server failed.") from error
    async with server:
        try:
            return await asyncio.wait_for(result, timeout_ms / 1000)
        except asyncio.TimeoutError as error:
            raise TransportError("OAuth loopback callback timed out.") from error
        finally:
            server.close()
            await server.wait_closed()


async def login_with_loopback(
    auth: AuthSession,
    subject: str,
    *,
    open: Callable[[str], None] | None = None,
    port: int | None = None,
    timeout: int | None = None,
) -> TokenSet:
    """Runs the full loopback quickstart: begin, present the URL, wait, complete.

    `open` receives the authorize URL instead of the default `print`; pass e.g.
    `webbrowser.open` to launch a browser. `timeout` is in milliseconds, matching
    `wait_for_loopback_callback`'s `timeout_ms`.
    """
    pending = await auth.begin_login(subject)
    if open is not None:
        open(pending.url)
    else:
        print(f"Open {pending.url}")
    timeout_ms = 300_000 if timeout is None else timeout
    callback = await wait_for_loopback_callback(pending, port=port, timeout_ms=timeout_ms)
    return await auth.complete_login(subject, callback, pending)
