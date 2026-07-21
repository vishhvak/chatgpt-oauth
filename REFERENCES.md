# References — prior art to draw from

We are **building our own** `chatgpt-oauth` from scratch (not adopting any of these). This is the study list: read them for the flow, the gotchas, and the hygiene, then implement independently. All of them ride OpenAI's public **Codex OAuth client** (`app_EMoamEEZ73f0CkXaXp7hrann`, PKCE against `auth.openai.com`) — the same mechanism we'll use.

---

## npm packages

### loginwithchatgpt — closest to what we're building (READ FIRST)
- `github.com/sarthakkapila/loginwithchatgpt` · npm `loginwithchatgpt` · v0.1.0 · MIT
- "Drop-in Login with ChatGPT button; users power your app's AI with their own subscription."
- **Steal:** the three entry points (headless engine / React component / Next.js route handlers); all three auth flows (loopback `login()`, headless paste `startLogin()`, **device-code `startDeviceLogin()`**); the **`TokenStore` interface** (pluggable) with **AES-256-GCM** at rest, key in macOS Keychain / `0600` file fallback; `createClient().respond()/.stream()` that auto-refreshes + retries once on 401; isolating the client-id/endpoints in a single file.
- **What it lacks (= our differentiators):** no React Native, no native Swift, **backend-api only** (Codex `/responses`, no app-server), local-first loopback only (punts on hosted multi-user).

### openai-oauth (EvanZhouDev) — web extension custody + AI SDK adapter
- `github.com/EvanZhouDev/openai-oauth` · npm `openai-oauth` · v2.0.0 · Apache-2.0
- v2 adds a **browser extension** that holds tokens so a hosted web server never stores them; `<SignInWithChatGPT />` React component; a dev-proxy that turns your account into an OpenAI-compatible endpoint; AI SDK + OpenAI-client adapters.
- **Steal:** the extension-custody pattern (the one clean answer to hosted-web token custody); the "OpenAI-compatible proxy" DX; the Legal/ToS section wording.

### ai-sdk-provider-chatgpt-oauth (ben-vargas) — Vercel AI SDK v5 provider
- `github.com/ben-vargas/ai-sdk-provider-chatgpt-oauth` · npm same name
- A `LanguageModelV2`/`ProviderV2` for the AI SDK that calls `chatgpt.com/backend-api/codex/responses`. `oauth-example/` has a clean, minimal reference: `oauth-client.ts` (PKCE + authorize URL + token exchange + refresh + JWT accountId extraction), `oauth-server.ts` (loopback callback server on `127.0.0.1:1455`), `token-manager.ts` (file store, 5-min refresh margin, `getValidToken()`).
- **Steal:** `oauth-example/src/*` is the cleanest small reference for the raw PKCE + loopback + refresh loop. Also: capability-negotiation (strip `reasoning`/`tools` and retry on 400 "Unsupported parameter"); the `codex_cli_simplified_flow=true` / `id_token_add_organizations=true` authorize params.

### codex-oauth / codex-auth — skip
- `codex-oauth` (0.1.0) = a **re-export of loginwithchatgpt**, no original code.
- `codex-auth` (0.1.1, `Sls0n/codex-account-switcher`) = unrelated CLI account-switcher.

---

## Full-agent implementations (best engineering, not importable)

### openclaw/openclaw — the app-server path, done right (for transport-appserver)
- `github.com/openclaw/openclaw` — an assistant OS; the relevant part is `extensions/codex/src/app-server/`.
- **Steal (for our app-server transport):** spawns the **managed codex binary over stdio JSON-RPC** (`transport-stdio.ts`) + a **WebSocket transport** for remote app-server (`transport-websocket.ts`); `managed-binary.ts` resolves the codex binary; `auth-bridge.ts` supplies **`chatgptAuthTokens`** login params + refresh via `refreshOAuthCredentialForRuntime`; delegates OAuth to Codex via `CODEX_HOME`/`auth.json`; **agent-scoped Codex home** so a product identity never clobbers the user's CLI state; **redacts tokens from logs** (regex scrubber in `client.ts`).
- Read this before writing `transport-appserver` — it's the reference for driving `codex app-server`.

### nousresearch/hermes-agent — token hygiene + a runtime switch
- `github.com/nousresearch/hermes-agent` (Python).
- A **runtime switch**: `auto` (direct backend-api, reuses `~/.codex/auth.json`) vs `codex_app_server` (spawns `codex app-server`, stdio JSON-RPC, `thread/start`+`turn/start` — see `agent/transports/codex_app_server.py`, `codex_event_projector.py`).
- **Steal (token store correctness):** `hermes_cli/auth.py` — atomic `O_EXCL`+`0o600` writes (TOCTOU-safe), parent dir `0o700`, cross-process file locks, 2-min refresh skew, **refresh-token quarantine** → typed `ReauthRequired`. Also scrubs unrelated infra creds from the codex subprocess env.

---

## Official docs

### Codex App Server — `learn.chatgpt.com/docs/app-server`
- The documented JSON-RPC protocol for embedding Codex (`initialize` → `thread/start` → `turn/start`). Transports: stdio (default), WebSocket (experimental), Unix socket. WebSocket auth flags for remote (`--ws-auth capability-token` / `signed-bearer-token`).
- **Auth modes** (the heart of `transport-appserver`): `apiKey` · `chatgpt` (Codex owns + refreshes tokens) · `chatgptDeviceCode` · **`chatgptAuthTokens`** (host owns tokens; app-server *requests* a fresh access token via `account/chatgptAuthTokens/refresh` after auth errors) · `amazonBedrock`.
- Auth endpoints: `account/read`, `account/login/start`, `account/login/completed` (notify), `account/logout`, `account/updated` (notify), plus rate-limit reads.
- Codex app-server is open source: `openai/codex` → `codex-rs/app-server`.

---

## Our own apps (audit these for what NOT to repeat)

- **ai-finances** (`~/Repos/projects/ai-finances`) — Next.js. `lib/ai/chatgpt-oauth.ts`, `app/api/auth/chatgpt/*`. Single-seed via `CHATGPT_OAUTH_TOKENS_B64` (the pooling bug to kill); tokens base64-not-encrypted. Local-first → a good first web dogfood.
- **calorie-tracking** (`~/Repos/projects/calorie-tracking`) — Expo/React Native. `src/lib/ai/chatgptAuth*.ts`, `ChatGptLoginSheet.tsx` (WebView PKCE, per-user, expo-secure-store). **First RN dogfood target.**
- **music-player** (`~/Repos/projects/music-player`) — Swift/iOS. `Services/Auth/ChatGPTAuthService.swift` (WKWebView PKCE, Keychain `ThisDeviceOnly`). **First Swift dogfood target.** Note: it decodes the JWT accountId without signature verification — don't copy that; treat accountId as untrusted routing metadata.

---

## The Codex `/responses` contract — VERIFIED WORKING (2026-07-20)

Battle-tested end to end against a live subscription while fixing ai-finances. This is the exact wire contract the SDK's `transport-backendapi` must implement — every item below was a real HTTP 400 until fixed.

**Endpoint:** `POST https://chatgpt.com/backend-api/codex/responses?client_version=<v>`
- The `client_version` **query param is required** — without it: `400 {"detail":"[{'type':'missing','loc':('query','client_version')...}]"}`. Use the installed Codex CLI version (e.g. `0.144.6`); isolate it in one constant.

**Required headers** (missing any → 400):
- `Authorization: Bearer <access_token>`
- `chatgpt-account-id: <id>` — extract from the access-token JWT claim `https://api.openai.com/auth.chatgpt_account_id` (untrusted routing metadata, don't verify-and-trust).
- `OpenAI-Beta: responses=experimental`
- `originator: codex_cli_rs`
- `session_id: <uuid>` (random per request)
- `Content-Type: application/json`

**Body:**
- `stream: true` is **mandatory** — `stream:false` → `400 {"detail":"Stream must be set to true"}`. The response is SSE; reassemble it.
- **Strip-and-retry unsupported params.** The backend rejects platform-Responses params it doesn't accept, e.g. `400 {"detail":"Unsupported parameter: max_output_tokens"}`. Parse `Unsupported parameter: X`, delete `X` from the body, retry (bounded, ≤4). ben-vargas does the same for `reasoning`/`tools`.
- Structured output: `text.format = { type:"json_schema", name, schema, strict:true }` works. `store:false` fine. `temperature` fine on non-reasoning models.
- Request body input shape: `input: [{ role, content:[{ type:"input_text", text }] }]`, system prompt → `instructions`.

**SSE parsing:** the text arrives as `event: response.output_text.delta` / `data:{"type":"response.output_text.delta","delta":"..."}` — **accumulate the deltas**. The terminating `response.completed` event carries the full response object (for finish reason) but often **without inline text**, so prefer the accumulated deltas for the actual content; use the completed object for metadata/finish-reason.

**Model discovery:** `GET /backend-api/codex/models?client_version=<v>` (same headers) returns the account's models. For this Pro account: `gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex-spark, codex-auto-review`. (Any of these work — the 400s were never about the model.)

**Reuse an existing Codex CLI session:** `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) has `tokens.{access_token, refresh_token, account_id, id_token}` + `last_refresh`. Import once for a local dev instance so users don't re-sign-in; the store then owns + refreshes it. A stale access token is fine — the refresh_token renews it. This is the openclaw/hermes pattern, now verified in ai-finances.

**Reference implementation:** the working code is in ai-finances `apps/web/lib/ai/provider.ts` (`callChatGptResponses`, `readFinalResponsesEvent`) and `lib/ai/chatgpt-oauth.ts` (`chatGptAccountIdFromToken`, `readCodexHomeTokens`, `codexClientVersion`), commit `f1d5a85`. Port these into `transport-backendapi` + `core`.
