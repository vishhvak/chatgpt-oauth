# SPEC.md — `chatgpt-oauth` v1

**One npm package that lets end users sign in with their own ChatGPT account and run OpenAI models on their subscription — pluggable into any JS runtime: web apps, Node servers, React Native/Expo, Electron, Tauri, and (via a documented protocol) native Swift/Kotlin ports.**

This spec is the single source of truth for v1. It synthesizes a file:line audit of six reference implementations (`loginwithchatgpt`, `ben-vargas/ai-sdk-provider-chatgpt-oauth`, `openclaw`, `nousresearch/hermes-agent`, `openai/codex` codex-rs, `EvanZhouDev/openai-oauth`) and three production apps. Every constant and pattern below was verified against real source. Companion docs: `HANDOFF.md` (decision memo), `REFERENCES.md` (annotated prior art), `.lavish/plan.html` (designed plan).

**Build from scratch. Read the references, copy no code.** The references are study material; this repo must be unsullied original work under its own license (MIT).

---

## 0. Decisions already made (do not relitigate)

| Decision | Value |
|---|---|
| Name / registry | `chatgpt-oauth`, npm, standalone (not scoped) |
| Refresh margin | **120 seconds** before expiry (hermes' battle-tested value) |
| app-server transport | **NOT in v1.** The `chatgptAuthTokens` mode is stamped `[UNSTABLE] FOR OPENAI INTERNAL USE ONLY` in codex-rs source. v1 = backend-api transport only. Design the transport interface so app-server can land as a later minor without breaking changes. |
| WebSocket transport | Not in v1 |
| ToS posture | Proceed while OpenAI is welcoming; retire cleanly if that flips. Honest experimental README, kill-switch, never pool tokens. |
| License | MIT |

## 1. The one non-negotiable

**One ChatGPT identity ↔ one app user.** The API shape must make token pooling *structurally impossible*:

- Every `CredentialStore` method takes a `subject: string` as its first argument. There is NO zero-arg or global `load()`.
- In server contexts, `subject` is derived server-side from the app's own session. The library never accepts a client-submitted userId, bearer, or `chatgpt-account-id` as identity.
- The JWT's `chatgpt_account_id` is **untrusted routing metadata**: send it as a header, never authorize on it, document this in TSDoc and README.
- Single-user CLI/desktop tools pass a literal subject (e.g. `"default"`) — explicit, visible, greppable; not an ambient default.

## 2. Package shape

Single npm package, subpath exports, **zero runtime dependencies**. No monorepo, no workspaces.

```
chatgpt-oauth/
  src/
    core/           # runtime-agnostic: WebCrypto + fetch only. No node imports.
      constants.ts  # every endpoint/id in ONE file (§3)
      types.ts      # TokenSet, Session, errors, interfaces
      pkce.ts       # verifier/challenge/state generation (§4)
      jwt.ts        # unverified payload decode + claim extraction (§5)
      oauth.ts      # authorize URL, code exchange, refresh, device-code flow
      lifecycle.ts  # AuthSession: getAccessToken orchestration — singleflight, CAS, quarantine (§6)
      client.ts     # inference client: /codex/responses + SSE streaming (§7)
      redact.ts     # token scrubber for error messages/log output (§8)
    node/           # loopback callback server (127.0.0.1:1455), file store (atomic, 0600, AES-256-GCM)
    react/          # useChatGPTAuth hook + <SignInWithChatGPT/> headless-first component
    react-native/   # store adapter interface wired for expo-secure-store (peer, injected — no hard dep)
    web/            # browser redirect helpers (authorize URL builder, callback parser) for SPA/server-web flows
  test/             # vitest, no network: mock fetch. Invariants in §10
  PROTOCOL.md       # the exact wire protocol, precise enough to port to Swift/Kotlin with no TS knowledge
  README.md         # honest, experimental, ToS-forward (§11)
  LICENSE           # MIT
```

Exports map: `.` (core), `./node`, `./react`, `./react-native`, `./web`. ESM only, `"type": "module"`, TypeScript strict, bundler: tsdown or tsup, Node >= 20. React/RN/expo-secure-store are optional peerDependencies — core never imports them.

**Why this shape covers "anything":** core uses only WebCrypto (`crypto.subtle`, `crypto.getRandomValues`) and `fetch` — both exist in browsers, Node 20+, RN (with polyfill documented), Electron (both processes), and Tauri's webview. Platform differences are confined to (a) how the authorize redirect happens and (b) where tokens persist — both injected interfaces.

## 3. Protocol constants (verified by ≥2 independent implementations)

All in `src/core/constants.ts`, exported as a frozen object, overridable via config for testability:

```
CLIENT_ID           app_EMoamEEZ73f0CkXaXp7hrann        (Codex CLI public PKCE client, no secret)
AUTHORIZE_URL       https://auth.openai.com/oauth/authorize
TOKEN_URL           https://auth.openai.com/oauth/token
SCOPES              openid profile email offline_access
LOOPBACK_PORT       1455
LOOPBACK_REDIRECT   http://localhost:1455/auth/callback
EXTRA_AUTH_PARAMS   id_token_add_organizations=true, codex_cli_simplified_flow=true
RESPONSES_URL       https://chatgpt.com/backend-api/codex/responses
DEVICE_USERCODE_URL https://auth.openai.com/api/accounts/deviceauth/usercode
DEVICE_POLL_URL     https://auth.openai.com/api/accounts/deviceauth/token
DEVICE_VERIFY_URL   https://auth.openai.com/codex/device
REFRESH_MARGIN_MS   120_000
```

Inference headers (exact): `authorization: Bearer <access>`, `chatgpt-account-id: <accountId>` (only when present), `openai-beta: responses=experimental`, `originator: codex_cli_rs`, `content-type: application/json`, `session_id: <uuid v4, one per client instance>`.

## 4. PKCE + state (spec-correct, follow loginwithchatgpt not ben-vargas)

- `verifier = base64url(randomBytes(64))`, `challenge = base64url(sha256(verifier))`, method `S256`.
- `state = base64url(randomBytes(32))`; MUST be compared with a constant-time check on callback; mismatch throws `StateMismatchError`.
- base64url via manual alphabet mapping (no `Buffer` in core — must run in browsers).
- Token exchange: form-encoded POST, `grant_type=authorization_code`, `client_id`, `code`, `code_verifier`, `redirect_uri`. No client secret.
- Refresh: `grant_type=refresh_token`, `client_id`, `refresh_token`, `scope` re-sent. If the response omits a new `refresh_token`, keep the old one (rotation is optional server-side; handle defensively).
- Device flow: request user code → present `verificationUrl` + code → poll `DEVICE_POLL_URL` with backoff honoring `interval`/`slow_down` → same token shape. This is the universal flow (works with zero redirect capability — TVs, SSH boxes, Tauri without deep links), so make it first-class, not an afterthought.

## 5. Tokens and JWT claims

```ts
interface TokenSet {
  accessToken: string
  refreshToken: string
  idToken?: string
  /** epoch ms; computed as now + expires_in*1000 (raw, no margin baked in) */
  expiresAt: number
  accountId?: string   // untrusted; from JWT claims
  planType?: string    // untrusted; e.g. "plus", "pro"
  email?: string       // untrusted
  /** monotonically increasing version for compare-and-swap; store-managed */
  version: number
}
```

Claim extraction (`jwt.ts`): split on `.`, base64url-decode payload segment, `JSON.parse`. Claims live under namespace `"https://api.openai.com/auth"` → `chatgpt_account_id`, `chatgpt_plan_type`; `email` top-level. Prefer `id_token`, fall back to `access_token`. **No signature verification is possible client-side and none is attempted — the module TSDoc must state that every claim is unverified and must never gate authorization** (this exact bug shipped in music-player).

## 6. Lifecycle core — the part that must be perfect

`AuthSession` orchestrates: `getAccessToken(subject)` returns a valid token, refreshing when `expiresAt - now < 120_000`.

**CredentialStore (the injection point for every platform):**

```ts
interface CredentialStore {
  load(subject: string): Promise<TokenSet | null>
  /**
   * Persist `next` only if the stored version still equals `expectedVersion`.
   * Returns the stored TokenSet after the attempt (the winner's, on conflict).
   * This is the CAS that stops two refreshers clobbering a rotated token.
   */
  compareAndSwap(subject: string, expectedVersion: number, next: TokenSet): Promise<{ ok: boolean; current: TokenSet | null }>
  delete(subject: string): Promise<void>
}
```

**Refresh singleflight (in-process):** one in-flight refresh promise per `(store, subject)`, keyed in a Map, cleared in `finally`. Concurrent `getAccessToken` calls await the same promise. (calorie-tracking got this right; lift the pattern.)

**Cross-process safety (via CAS, hermes' double-check shape):** before refreshing, re-`load()` and re-check staleness — another process may have already rotated. After refreshing, `compareAndSwap` with the pre-refresh version; on conflict, adopt `current` (the winner's token) and discard ours.

**Reactive path:** inference client retries exactly once on 401: refresh (through the same singleflight) → retry. A second 401 surfaces `AuthError`.

**Quarantine (the pattern all three of our apps lack):**
- Trigger: token-endpoint 4xx with error code in `{invalid_grant, invalid_token, invalid_request}`, or any bare 401/403 from the token endpoint. **Never on 429** (rate limit) or 5xx/network errors — those retry with backoff and remain non-terminal.
- Action: persist a quarantine marker on the stored TokenSet (`quarantinedAt`, `reason`), stop all refresh attempts for that subject, throw `ReauthRequiredError` (typed, carries `subject` and `reason`).
- Recovery: only a fresh login (`completeLogin`/device flow success) or `logout()` clears it. Anti-flap: a healthy-looking token mid-rotation never triggers quarantine; only classified terminal errors do.

**Typed errors** (all extend `ChatGPTOAuthError` with a `code` discriminant): `StateMismatchError`, `ReauthRequiredError`, `TokenRefreshError` (transient), `RateLimitError` (carries retry-after), `AuthError`, `TransportError`. No stringly-typed error sniffing anywhere.

**Logout:** `delete(subject)` always; document that no reliable public revoke exists for this client — link users to their OpenAI account security page.

## 7. Inference client (`transport-backendapi`)

```ts
interface SubscriptionAI {
  respond(req: ResponseRequest): Promise<ResponseResult>       // collects the stream
  stream(req: ResponseRequest): AsyncIterable<ResponseEvent>   // raw SSE events, typed
}
createClient(session: AuthSession, subject: string, opts?): SubscriptionAI
```

- POST `RESPONSES_URL`, body `{ model, instructions?, input, tools?, tool_choice?, parallel_tool_calls: false, store: false, stream: true, reasoning?, include? }`. Always `stream: true`; `respond()` collects.
- SSE parser: incremental, handles multi-line `data:`, `[DONE]` sentinel, surfaces `response.output_text.delta` and friends as typed events; tolerant of unknown event types (forward them, don't throw).
- 401 → one refresh+retry (§6). 429 → `RateLimitError` with retry-after. Other non-OK → `TransportError` with **redacted** body snippet.
- The transport interface must be narrow enough that a future `transport-appserver` implements the same `SubscriptionAI` without touching core.

## 8. Security requirements (non-negotiable)

1. **No token ever appears in an error message, log line, or thrown string.** `redact.ts` scrubs `Bearer <...>`, JSON `"access_token"/"refresh_token"/"id_token"/"authorization"` values, and `key=value` forms (openclaw's three-pattern approach) — applied to every error path that echoes external input.
2. Node file store: write via temp file + `O_EXCL`-style exclusive create at `0600`, fsync, atomic rename; parent dir `0700` (hermes' TOCTOU-safe shape). Encrypt at rest with AES-256-GCM (12-byte IV, `iv.tag.ciphertext` base64 envelope); key from `CHATGPT_OAUTH_KEY` env or a generated `0600` key file.
3. Web/server store guidance: the shipped `MemoryStore` is for tests/dev; PROTOCOL.md + README show a reference SQL adapter (encrypted column keyed by server-derived subject) — but any DB adapter is user-supplied via `CredentialStore`.
4. Loopback server binds `127.0.0.1` only, validates `state` before reading `code`, 5-minute timeout, one-shot (closes after first callback), serves a minimal self-contained success/error HTML page.
5. Kill-switch: `disabled?: () => boolean` config on `AuthSession` — when true, `getAccessToken` throws a typed `DisabledError` without touching the network. Apps wire this to a remote flag.

## 9. Platform integration surfaces

| Surface | Login mechanism | Store |
|---|---|---|
| Node/CLI/Electron main/Tauri sidecar | loopback server (`./node`) or device flow | encrypted file store (`./node`) |
| Web SPA + server (Next.js etc.) | redirect helpers (`./web`) — server completes exchange, server-derived subject | user's DB via `CredentialStore` |
| React (any) | `./react`: `useChatGPTAuth({ endpoints })` — talks to app routes, never holds refresh tokens in the browser | n/a (server-side) |
| React Native / Expo | device flow (recommended) or system auth session (documented recipe with `expo-web-browser`); RN store adapter over injected `expo-secure-store` | `./react-native` |
| Swift / Kotlin | **PROTOCOL.md** — complete wire spec: every endpoint, param, header, claim path, state machine, and security requirement, written so a native port needs zero TS reading. Include the music-player lessons: use `ASWebAuthenticationSession`/Custom Tabs, Keychain ThisDeviceOnly/EncryptedSharedPreferences, claims are unverified. |

React component is headless-first: renders an unstyled button by default, full render-prop escape hatch. No CSS shipped.

## 10. Testing (vitest, mocked fetch, no network)

Required invariants, each its own test:
1. PKCE: verifier/challenge/state are base64url, challenge = S256(verifier) against a known vector.
2. State mismatch on callback → `StateMismatchError`, no token exchange attempted.
3. 20 concurrent `getAccessToken` calls with an expired token → exactly **one** refresh POST.
4. CAS conflict: store rotated underneath → our refresh result is discarded, winner's token adopted, no second refresh.
5. Refresh response without `refresh_token` → old refresh token retained.
6. `invalid_grant` → quarantine marker persisted, subsequent calls throw `ReauthRequiredError` **without a network call**; 429 → NOT quarantined, `RateLimitError`.
7. Inference 401 → exactly one refresh + one retry; second 401 → typed error.
8. SSE parser: split-across-chunks events, multi-line data, `[DONE]`, unknown event passthrough.
9. Redaction: an error containing a bearer token never exposes it (assert on the message).
10. Node store: file mode `0600`, parent `0700`, roundtrip encrypt/decrypt, tamper → clean typed error.
11. Store interface: no method callable without a subject (type-level test with `@ts-expect-error`).
12. Device flow: poll honors `interval`, handles `authorization_pending`/`slow_down`/success.

CI: single GitHub Actions workflow — typecheck, lint (eslint flat config), test, build. All green required.

## 11. README requirements

Honest and experimental, up front: unofficial, rides the Codex CLI's public OAuth client, credentials are passwords, **never pool tokens or resell access**, OpenAI can turn this off any time, personal/self-host use, keep an API-key fallback. Then: 60-second quickstarts per platform (Node, Next.js, RN/Expo, Electron, Tauri), the subject model explained with the ai-finances pooling bug as the cautionary tale, API reference, PROTOCOL.md pointer for native ports.

## 12. Style bar

- Zero runtime deps. Every module has a one-paragraph header comment saying what it owns.
- Small files, no barrel re-export sprawl beyond the subpath entries; no classes where a closure does; no abstraction with one implementation except the two seams that exist for platform plurality (`CredentialStore`) and transport evolution (`SubscriptionAI`).
- Code reads top-down; the tricky parts (singleflight, CAS, quarantine, SSE) get short "why" comments citing the failure they prevent.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass. That is the definition of done.
