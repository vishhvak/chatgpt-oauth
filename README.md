# chatgpt-oauth

Experimental, unofficial OAuth and subscription transport for apps whose users bring their own ChatGPT account. One protocol, four implementations.

> [!WARNING]
> Every implementation rides the Codex CLI's public OAuth client and an undocumented ChatGPT backend API. This is not an official OpenAI SDK. OpenAI can change or disable the flow at any time. Treat refresh tokens like passwords, never pool tokens or resell subscription access, use this only for personal or self-hosted software unless OpenAI approves your exact use, and keep an API-key or local-model fallback.

## Implementations

| language | directory | install | ships |
| --- | --- | --- | --- |
| TypeScript | [`typescript/`](typescript/) | `pnpm add chatgpt-oauth` | Node, browsers, React, React Native/Expo, Electron, Tauri, Vercel AI SDK provider, Next.js route handler, Codex app-server transport |
| Swift | [`swift/`](swift/) | SwiftPM | iOS 16+/macOS 13+, Keychain store, SwiftUI `SignInWithChatGPT` |
| Python | [`python/`](python/) | `pip install chatgpt-oauth` | asyncio + httpx, encrypted file store, loopback callback |
| Kotlin | [`kotlin/`](kotlin/) | Gradle | JVM core + Android module, EncryptedSharedPreferences store, Compose `SignInWithChatGPT` |

Each directory is self-contained: its own README, quickstart, tests, and build. [`PROTOCOL.md`](PROTOCOL.md) is the shared contract they all implement — the wire protocol, the refresh/quarantine lifecycle, and the threat model. A behavior difference between ports is a bug.

## The identity rule

Every credential operation requires a `subject` derived by your application from its own authenticated session. Never accept it from a request body, never use `chatgpt-account-id` as application identity, never keep a global credential row. `accountId`, `planType`, and `email` come from an unverified JWT: routing and display only, never authorization.

## Shared design

- **Subject-keyed custody** — there is no `store.load()`; only `store.load(subject)`.
- **Singleflight refresh** — concurrent callers for one subject share one refresh; compare-and-swap persistence makes losing writers adopt the winner.
- **Quarantine on terminal failure** — `invalid_grant` marks one subject reauth-required; a 429 or 5xx never destroys credentials.
- **Secrets never leak** — tokens are redacted from errors, logs, and debug output in every port, enforced by tests.

## License

MIT
