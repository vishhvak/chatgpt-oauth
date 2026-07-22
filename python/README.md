# chatgpt-oauth

Experimental, unofficial OAuth and subscription transport for Python apps whose users bring their own ChatGPT account.

> **Warning**
> This package uses the Codex CLI's public OAuth client and an undocumented ChatGPT backend API. It is not an official OpenAI SDK. Treat refresh tokens like passwords, never pool credentials between users, and keep an API-key or local-model fallback.

Every credential operation requires a nonempty `subject` derived from your application's trusted session. JWT `account_id`, `plan_type`, and `email` claims are unverified routing/display metadata and never application identity.

```sh
pip install chatgpt-oauth
```

```python
import asyncio
from pathlib import Path

from chatgpt_oauth import (
    AuthSession,
    ResponseRequest,
    create_client,
    create_file_credential_store,
    wait_for_loopback_callback,
)


async def main() -> None:
    subject = "local-user"  # explicit app-owned identity; never ambient
    store = await create_file_credential_store(Path.home() / ".my-app" / "chatgpt")
    async with AuthSession(store=store) as auth:
        pending = await auth.begin_login(subject)
        print(f"Open {pending.url}")
        callback = await wait_for_loopback_callback(pending)
        await auth.complete_login(subject, callback, pending)

        async with create_client(auth, subject) as ai:
            result = await ai.respond(
                ResponseRequest(model="gpt-5.4-mini", input="Explain CAS in one sentence.")
            )
            print(result.output_text)


asyncio.run(main())
```

The file store creates a `0700` directory, a `0600` AES-256-GCM key, and an atomically replaced `0600` encrypted credential file. Set `CHATGPT_OAUTH_KEY` to base64, base64url, or 64-character hex encoding exactly 32 bytes to manage the key externally.

Failures inherit `ChatGPTOAuthError` and expose a stable `code`: `StateMismatchError`, `ReauthRequired`, `TokenRefreshError`, `RateLimitError`, `AuthError`, `TransportError`, `DisabledError`, and `StoreError`.

MIT

