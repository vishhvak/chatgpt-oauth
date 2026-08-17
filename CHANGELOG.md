# Changelog

All four ports share one version number and are released together, because they implement one
protocol and a behaviour difference between them is a bug. Swift carries no version field — it is
released by git tag.

While the project is `0.x`, behaviour changes bump the minor.

## 0.2.1

Two bugs that made the AI SDK bridge unusable against the real backend. Both were invisible to the
test suite because its fixtures described the direct OpenAI API rather than what the subscription
backend actually sends, and invisible to the other three ports because neither bug can be reached
without rebuilding a whole response object from a stream. Python, Kotlin and Swift are unchanged.

### Fixes

- **Non-streaming calls returned empty text.** `response.completed` arrives from this backend with
  `output: []`, and the turn's items are only ever delivered by the `response.output_item.done`
  events before it, so collapsing a stream into a one-shot response produced a turn that said
  nothing. `generateText` and `generateObject` were affected; `streamText` was not, because it reads
  the deltas. The bridge now collects those items and splices them in, leaving an already-populated
  `output` exactly as it arrived.
- **Ordinary call options failed the whole request with a bare `Bad Request`.** The backend refuses
  fourteen sampling and bookkeeping parameters, including `temperature`, `top_p`, `max_output_tokens`
  and `seed`, which the AI SDK emits from its own standard options. One `temperature: 0.2` was enough
  to break every call, and the error named nothing useful. The bridge now drops the refused set
  before sending. The full list, and the parameters that are accepted, are recorded in
  `PROTOCOL.md` §8.

## 0.2.0

Most of this release is one theme: **TypeScript had drifted from the other three ports**, and the
drift was found by comparing them against `PROTOCOL.md` rather than by any test failing.

### Behaviour changes

- **An empty or blank `subject` is now rejected** with a store error, in TypeScript. Python, Kotlin
  and Swift already did this. Previously an empty subject silently keyed one shared credential row
  for every user — the global credential row the identity rule exists to prevent. A `requireSubject`
  helper is now exported for custom stores.
- **The kill switch is enforced on every credential entry point** in TypeScript. `disabled()` was
  only checked in `getTokenSet`, so with the switch on, an in-flight login could still complete and
  persist credentials, and `status()` still read the store. `logout` remains reachable while
  disabled, deliberately — the other three ports agree.
- **The AI SDK bridge now throws a typed, redacted `TransportError`** on network failure instead of
  letting a raw `TypeError` escape. Consumers matching on `instanceof ChatGPTOAuthError` previously
  missed these, and the raw error was never passed through redaction.
- **Kotlin bounds transport error snippets to 1024 characters**, matching the other three ports. It
  was emitting up to 4096.
- **Swift deduplicates refreshes per `(store, subject)`**, not per `AuthSession` instance. Several
  sessions over one shared store previously issued one refresh each, spending a rotating refresh
  token repeatedly.

### Fixes

- **Android: migrated off `androidx.security:security-crypto`**, deprecated by Google in April 2025
  and never shipped stable. Credentials now use an Android Keystore AES-256-GCM key with the
  protocol's own envelope. Existing records migrate on first read; nobody is signed out by
  upgrading.
- **Android: enabled core library desugaring.** `chatgpt-oauth-core` uses `java.util.Base64`, which
  is API 26+, while `minSdk` is 23 — every sign-in on API 23–25 died with `NoSuchMethodError`.
- **Python: the loopback listener binds before the browser opens.** A fast redirect could beat the
  bind and the browser got `ECONNREFUSED`.
- **App-server clients recover from a failed `thread/start`.** One transient failure previously
  bricked the client for its entire lifetime.
- **The app-server stderr buffer is redacted before truncation.** The rolling window trimmed from
  the front, which could discard the `"access_token":` label a redaction pattern anchors on while
  keeping its value.
- **TypeScript SSE framing is linear, not quadratic.** It re-normalized and re-scanned the whole
  accumulated buffer per chunk; the other three ports already avoided this.
- **`retryAfter` honours the injectable clock** on its HTTP-date branch.

### Added

- `useChatGPTAuth` accepts `onConnected` and `onError`, fired from the state transition instead of
  an effect, which saves consumers a render.
- Every port has an `examples/verify` that signs in and streams one response against a real account.
- Documentation at [chatgpt-oauth.vishhvak.com](https://chatgpt-oauth.vishhvak.com), sourced from
  `docs/`.
- Supply-chain hardening for the TypeScript build: a minimum release age and no trust downgrades.
- CI now compiles and tests the Android module, and runs Python against its declared 3.10 floor.

## 0.1.1

- TypeScript: exported `extractUnverifiedClaims` and `UnverifiedClaims`.

## 0.1.0

- Initial release: TypeScript, Python, Kotlin and Swift ports of the v1 protocol.
