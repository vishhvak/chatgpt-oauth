"""Signs in and streams one response, to check the port against a live account.

    cd python && python examples/verify.py

Credentials land in an encrypted file store, so a second run skips the sign-in and
exercises refresh instead. Delete ~/.chatgpt-oauth-example to start over.
"""

import asyncio
from pathlib import Path

from chatgpt_oauth import AuthSession, ResponseRequest, SubscriptionAI, create_file_store

SUBJECT = "example-user"
MODEL = "gpt-5.4-mini"


async def main(store_dir: Path) -> None:
    store = await create_file_store(store_dir)
    async with AuthSession(store=store) as auth:
        if await auth.status(SUBJECT) is None:
            device = await auth.start_device_login(SUBJECT)
            print(f"Open {device.verification_url} and enter code {device.user_code}\n")
            await device.wait()

        client = SubscriptionAI(auth, SUBJECT)
        try:
            request = ResponseRequest(model=MODEL, input="Say hello in five words.")
            async for event in client.stream(request):
                if event.delta is not None:
                    print(event.delta, end="", flush=True)
            print()
        finally:
            await client.aclose()


if __name__ == "__main__":
    asyncio.run(main(Path("~/.chatgpt-oauth-example").expanduser()))
