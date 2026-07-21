# Codex Subscription SDK — Handoff

**What this is:** the decision + plan to build a best-in-class, cross-platform SDK that lets end users **sign in with their own ChatGPT account** and run OpenAI models on **their subscription** (no API billing) — across web, React Native, and native iOS.

**Status:** decided to build (see verdict). Not started. This folder holds the reasoning; the code lives elsewhere once scaffolded.

**Decision (firm, 2026-07-20):** **build our own from scratch, publish it, use it.** NOT adopting or delegating to any existing package. Name: **`chatgpt-oauth`** (free on npm, standalone — not koban-scoped). The existing packages are **study material only** — see `REFERENCES.md` in this folder for the annotated list (what to steal from each).

**Companion files in this folder:**
- `REFERENCES.md` — annotated prior-art list to draw from while building (loginwithchatgpt, EvanZhou, ben-vargas, openclaw, hermes, app-server docs). **Read before writing each piece.**
- `consensus.html` — the full designed decision memo (open in a browser, toggles light/dark).

---

## The verdict

**Build it — a small, focused, cross-platform SDK.** The bar is not novelty; it's *better, cleaner, more honest* than anything shipped. "Someone already built it" is a weak veto because what exists is fragmented:

- **EvanZhouDev/openai-oauth** — web only, behind a browser extension. No mobile/native story.
- **ben-vargas/ai-sdk-provider-chatgpt-oauth** — a Node/CLI AI-SDK shim. Not cross-platform.
- **openclaw/openclaw** & **nousresearch/hermes-agent** — the best engineering, but welded inside a 27k-file agent OS and a Python monolith. You can't `npm i` either.
- **loginwithchatgpt** (Sarthak Kapila, v0.1.0) — see "Prior art" below. Cleanly covers **local-first web/Node**; this narrows the gap but does not close it.

**Naming decision (2026-07-20):** must be **standalone**, not koban-scoped. `chatgpt-oauth` is free on npm and chosen — caveat: "chatgpt" is an OpenAI trademark, some risk if this goes public/commercial. `codex-oauth` and `codex-auth` are taken (see Prior art).

**The gap = the reason to build:** a clean **web + React Native + Swift** trifecta with **`codex app-server` as a first-class transport** does not exist.

Keep the reviewers' discipline as **guardrails, not a veto**: stay small (a core + thin adapters, never a gateway), and bake correctness into the API shape so misuse is impossible.

---

## The non-negotiable (bug already shipped in ai-finances)

**One ChatGPT identity ↔ one app user.** ai-finances currently seeds ONE account for the whole app via `CHATGPT_OAUTH_TOKENS_B64` → a single global `sync_state` row. That pools your account for every visitor. Concrete failure: Bob signing in overwrites Vish's bearer; Vish's next request runs against Bob's subscription while two refreshers race on one token. The SDK's API must **force a server-derived subject** so pooling is structurally impossible.

---

## Three ways to get tokens → models

| Option | What | Verdict |
|---|---|---|
| **A — direct backend-api** | Reuse Codex CLI's `client_id` (`app_EMoamEEZ73f0CkXaXp7hrann`), POST to `chatgpt.com/backend-api/codex/responses` with `originator: codex_cli_rs`. **What all 3 of Vish's apps do now.** | Fragile, gray-area. One header change breaks it. Mobile/personal fallback only. |
| **B — codex app-server** | Run OpenAI's own binary; drive over JSON-RPC. Officially documented; 3 auth modes: `chatgpt`, `chatgptDeviceCode`, `chatgptAuthTokens`. Codex owns protocol drift + refresh. | **Target.** The tweet's method, done right. Needs a host that runs the binary. |
| **C — extension token custody** | EvanZhou v2: an open-source browser extension holds tokens; server stores **none**. | Safest multi-user **web** pattern. Chrome/Firefox, web only. |

---

## Ranked recommendation per platform

| Platform | 1st choice | Why |
|---|---|---|
| **Web (hosted)** — ai-finances | **C — extension custody** for BYO-ChatGPT | Server never holds a refresh token → deletes storage liability. Default product path stays platform API key / Ollama; OAuth is opt-in. |
| **React Native / Expo** — calorie-tracking | **A — backend-api**, device custody | Expo can't host the app-server binary. SecureStore, per install, behind a kill-switch. Add refresh quarantine. |
| **Native iOS / Swift** — music-player | **A — backend-api**, Keychain | Same as RN. Switch WebView intercept → `ASWebAuthenticationSession`; Keychain `ThisDeviceOnly`. app-server only if a Mac/local daemon ships later. |

Cross-platform ranking: **B** wins anywhere a binary runs · **A** is the mobile/Expo fallback · **C** is the multi-user-web exception.

---

## Token lifecycle (same shape everywhere; under app-server Codex does most of it)

1. **Login** — PKCE (S256) against `auth.openai.com/oauth/authorize`. Mobile: `ASWebAuthenticationSession`. Web multi-user: the extension. Validate `state` (CSRF).
2. **Access token** — short-lived JWT, ~1h TTL. Store per user, encrypted (Keychain / SecureStore / AES-GCM DB row) — never bare base64, never a global key.
3. **Refresh** — lazy, at expiry − 5min, plus reactive 401→refresh→retry. **Singleflight mutex** + **compare-and-swap** the rotated token by version so two refreshers can't clobber each other.
4. **Quarantine** — on `invalid_grant` / revoke-class 4xx, mark refresh dead, stop the loop, surface typed `ReauthRequired`. (hermes' best pattern; missing in all 3 apps.)
5. **Logout** — always delete local tokens; on app-server call `account/logout`. No reliable public revoke for the CLI client → tell the user to revoke in their OpenAI account UI.

**`chatgptAuthTokens` ownership flip:** in that mode YOUR `TokenStore` is the source of truth — you did the PKCE, you hold + refresh the token, app-server *asks you* for a fresh access token after auth errors. Don't dual-write into both your DB and the Codex home. The `chatgpt_account_id` from the JWT is unverified routing metadata — send it as a header, never trust it for authorization.

---

## The single biggest risk (technical + legal, same root)

Impersonating the Codex CLI to power non-Codex products — worst when a hosted app pools/brokers one subscription. The community libs are explicit: unofficial, credentials are passwords, **do not pool tokens**, you own compliance, OpenAI can disable it anytime. OpenAI's docs bless *embedding Codex*; they do **not** license reselling ChatGPT access as your SaaS backend. A cleaner library doesn't change the ToS posture — which is exactly why "honest by default" is a feature, not a footnote.

**Mitigations:** OAuth = personal/self-host only, never the multi-tenant default · never pool · move inference to app-server (documented protocol) · honest experimental UX/README · encrypt at rest, quarantine, logout clears · always keep API-key/Ollama fallback. **Before any commercial multi-tenant launch: get written OpenAI approval for the exact per-user hosted flow.** (Engineering/security guidance, not legal advice.)

---

## Patterns to copy from the reference repos

**openclaw (copy the architecture):** spawns the managed codex binary over stdio JSON-RPC (+ a WebSocket transport for remote app-server); never touches backend-api directly. Delegates OAuth to Codex via `CODEX_HOME`/`auth.json`; supports `chatgptAuthTokens`. Agent-scoped Codex home by default so a product identity never clobbers the user's CLI state. Redacts tokens from logs.

**hermes-agent (steal the hygiene):** a **runtime switch** — `auto` (direct backend-api, reuses `~/.codex/auth.json`) vs `codex_app_server` (spawns `codex app-server`, stdio JSON-RPC, `thread/start`+`turn/start`). Token store written **atomically via `O_EXCL`+`0o600`** (TOCTOU-safe), parent dir `0o700`, cross-process file locks, 2-min refresh skew, quarantine. Scrubs infra creds from the codex subprocess env.

Don't swallow either project's scope; you want a ~2k-line auth+transport core.

---

## The build — v0 and the shape

**v0 scope:** `core` + `web adapter` + `app-server transport`, dogfooded end-to-end on **ai-finances** — with ripping out the `CHATGPT_OAUTH_TOKENS_B64` global seed as the first visible win. Then add React Native and Swift adapters once the core is proven in a repo Vish already runs.

```ts
// Codex-specific monorepo. The auth client is NEVER the inference client.
// subject is derived server-side from the app session — clients NEVER submit
// a userId, chatgpt-account-id, or bearer. That's what makes pooling impossible.
interface CredentialStore  { load(subject); compareAndSwap(subject, version, next); delete(subject) }
interface CodexAuthClient  { beginLogin; completeLogin; getAccessToken; logout; status }
interface RuntimeTransport { connect(subject): SubscriptionAI }   // AppServer | BackendApi

packages/
  core                 PKCE · device-code · refresh singleflight · quarantine · JWT parse
  store-web            encrypted DB row, keyed by server-derived subject (never global)
  store-react-native   expo-secure-store
  store-ios            Keychain, ThisDeviceOnly (Swift port)
  transport-appserver  JSON-RPC to codex binary — the target path
  transport-backendapi direct /codex/responses — mobile, behind a kill-switch
```

Guardrails: core owns lifecycle not transport · the store key forces a subject · two transports behind one interface (`app-server` default, `backend-api` flagged fallback, never a silent downgrade) · **refer to the packages in `REFERENCES.md`, depend on none of them.**

**Build order (each dogfooded in one of our apps):**
1. `core` + `transport-backendapi` + `store-react-native` → dogfood in **calorie-tracking** (nearest RN target).
2. `store-ios` (Swift port) → dogfood in **music-player**.
3. `store-web` → dogfood in **ai-finances**, delete the `CHATGPT_OAUTH_TOKENS_B64` seed.
4. `transport-appserver` (the first-of-its-kind piece) → study openclaw's `extensions/codex/src/app-server/` + the app-server docs first.
5. Publish `chatgpt-oauth` to npm.

---

## Prior art on npm (investigated 2026-07-20)

- **`codex-auth`** (0.1.1, `Sls0n/codex-account-switcher`) — unrelated. CLI to switch between multiple Codex accounts. Not our space.
- **`codex-oauth`** (0.1.0) — just a **re-export of `loginwithchatgpt`**. No original code.
- **`loginwithchatgpt`** (Sarthak Kapila, v0.1.0, `github.com/sarthakkapila/loginwithchatgpt`) — the real prior art, close to our web plan. Ships: drop-in `<LoginWithChatGPT />` React button + `useChatGPTAuth()`, Next.js `createHandlers()`, headless engine (`login`/`getSession`/`createClient().respond()/.stream()`), **all three auth flows** (loopback, headless paste, device-code), **AES-256-GCM encrypted pluggable `TokenStore`** (key in macOS Keychain / `0600` fallback), auto-refresh + one 401 retry.
  - **Does NOT cover (our remaining gap):** no React Native · no native iOS/Swift · **backend-api only** (Codex `/responses`), no app-server transport · **local-first only** (loopback on `127.0.0.1:1455`), explicitly punts on hosted multi-user as account-sharing.
  - **Implication:** ai-finances is `loginwithchatgpt`'s exact target (local-first Next.js), so its web/Node design is the closest reference for our own web adapter — **read it, then build our own** (decision is build-not-adopt). Its edge over us today is only hygiene (encrypted pluggable store vs ai-finances' base64) — match/beat that. The genuinely unpackaged ground is **React Native, native Swift, and the app-server transport** — that's where we're first, not just cleaner.
  - Pitch for our SDK: **the cross-platform one that actually covers mobile + native + app-server**, published standalone as `chatgpt-oauth`, and we dogfood it in all three of our apps.
  - See `REFERENCES.md` for exactly what to steal from each package/repo.

## Next actions

- **Decided:** build our own, name = `chatgpt-oauth` (standalone), publish to npm, dogfood in all three apps. Build order above.
- **Immediate:** scaffold the monorepo — `packages/core` + `transport-backendapi` + `store-react-native` first (RN dogfood on calorie-tracking). Read `REFERENCES.md` → loginwithchatgpt + ben-vargas `oauth-example/` before writing the PKCE/refresh loop; hermes `auth.py` before writing the token store.
- **Still open:** whether `transport-appserver` lands in v0 or a later minor (it's the hardest, most novel piece; backend-api ships first).

## Provenance

- Reviewers who converged: a file-level audit (Fable), Codex (gpt-5.6, reasoning from findings), Grok (high effort).
- Origin: Ben Badejo tweet (run codex app-server in the cloud + "Sign in with ChatGPT", users pay via subscription).
- Reference repos inspected: ben-vargas/ai-sdk-provider-chatgpt-oauth, EvanZhouDev/openai-oauth, openclaw/openclaw, nousresearch/hermes-agent; docs at learn.chatgpt.com/docs/app-server.
- Apps audited: ai-finances (Next.js web, single-seed — fix this), calorie-tracking (Expo, per-user WebView PKCE), music-player (Swift, per-user WKWebView PKCE).

> Note: Codex reasoned from the findings (told not to clone), so any file:line/commit citations in its raw report are fabricated — this handoff uses only verified substance.
