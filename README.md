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

## Documentation

**[chatgpt-oauth.vishhvak.com](https://chatgpt-oauth.vishhvak.com)** — or read the same pages as
markdown in [`docs/`](docs/).

| | |
| --- | --- |
| [Concepts](docs/concepts.md) | Subject-keyed custody, generations and CAS, singleflight refresh, quarantine |
| [Errors](docs/errors.md) | The eight typed failures and what to do about each |
| [Storage](docs/storage.md) | Choosing a store, and writing one that is actually safe |
| [Security](docs/security.md) | What the library guarantees, what is yours, and a pre-ship checklist |
| [Deploying](docs/deploying.md) | The hosted render-service template |
| [Contributing](docs/contributing.md) | Four toolchains, and the rule that governs every change |

## Verification status

Every test in every port drives a mocked transport (`respx`, `MockWebServer`, `URLProtocol`,
stubbed `fetch`), so the suites prove the ports agree with the spec and with each other — never that
the spec still matches an undocumented backend. What separates the ports is whether anything has
actually run against a live ChatGPT account.

**TypeScript is field-proven.** It runs in production in three applications: a Next.js app using the
`next` route handler, the `react` hook, the `ai-sdk` provider and the `node` file store; a second
Next.js app using the `web` redirect callback and the `ai-sdk` provider; and a shipped React
Native/Expo iOS app using the `react-native` SecureStore adapter. Between them they have exercised
the browser and device-code login flows, refresh, singleflight, quarantine, and recovery from a real
multi-day credential outage — the kind of evidence a mocked suite cannot produce.

**Python, Swift and Kotlin have no known production use.** They are ports of a specification,
checked against mocks and against each other. Nothing in those three has been observed talking to
OpenAI. Treat them as unproven until someone reports otherwise.

| surface | status |
| --- | --- |
| TypeScript `node`, `web`, `next`, `react`, `react-native`, `ai-sdk`, core | in production use, plus tests against mocks |
| TypeScript `app-server` | tests only, and against a scripted stand-in for the Codex binary rather than the real one |
| Electron, Tauri | expected to work through the `node` and `web` entries; no specific code, tests, or reported use |
| Python core, loopback, file store | tests against mocks; no known production use |
| Kotlin JVM core | tests against mocks; no known production use |
| Swift core | tests against mocks, on macOS only — iOS is not built in CI; no known production use |
| Swift `KeychainCredentialStore`, SwiftUI `SignInWithChatGPT` | compiled; no tests |
| Android credential store, Compose `SignInWithChatGPT` | compiles, and the AES-256-GCM envelope is unit-tested; the Keystore and Compose paths have never run on a device or emulator |

### Observed in the field, not yet in the spec

`refresh_token_invalidated` is a real terminal error from the token endpoint, returned when the same
ChatGPT account signs in elsewhere and rotates the refresh token away. It is currently quarantined
only because it arrives with a bare `401`/`403`, which §6 already covers — the code itself appears in
no port's terminal list. If it ever arrives with another status, no port would quarantine it.

### Checking a port against your own account

Each port has an `examples/verify` that signs in and streams one response. It is the only way to
move a port off "no known production use" — every test suite here talks to a mock.

```sh
cd typescript          && pnpm dlx tsx examples/verify.ts
cd python              && python examples/verify.py
cd swift/examples/verify && swift run Verify
cd kotlin              && ./gradlew :examples:verify:run --console=plain
```

Each prints a URL and a device code, waits for you to approve it, then streams the reply. Where the
port has a persistent store, credentials are kept, so a second run exercises refresh instead of
signing in again.

## The identity rule

Every credential operation requires a `subject` derived by your application from its own authenticated session. Never accept it from a request body, never use `chatgpt-account-id` as application identity, never keep a global credential row. `accountId`, `planType`, and `email` come from an unverified JWT: routing and display only, never authorization.

## Shared design

- **Subject-keyed custody** — there is no `store.load()`; only `store.load(subject)`.
- **Singleflight refresh** — concurrent callers for one subject share one refresh; compare-and-swap persistence makes losing writers adopt the winner.
- **Quarantine on terminal failure** — `invalid_grant` marks one subject reauth-required; a 429 or 5xx never destroys credentials.
- **Secrets never leak** — tokens are redacted from errors, logs, and debug output in every port, enforced by tests.

## License

MIT
