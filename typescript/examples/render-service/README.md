# Render service template

This directory is a copy-and-own deployment template, not a server framework exported by `chatgpt-oauth`. It hosts **your application** with the `codex app-server` binary embedded in the same container. There is no separate app-server URL to configure or share.

> [!WARNING]
> This example uses the Codex CLI's public OAuth client and an undocumented ChatGPT backend API. It is not an official OpenAI SDK. Use it only for personal or self-hosted software unless OpenAI approves your exact use. Never pool tokens, broker access, or resell ChatGPT subscription capacity; keep an API-key or local-model fallback.

## The identity and process rules

The signed cookie in this example is deliberately tiny demo authentication. Replace it with your product's real server-side session before deployment. The authenticated `subject` must be derived by the server and must never come from a request body, query string, or browser-selected account ID.

This prevents the classic pooling bug: one global OAuth row lets Bob's login replace Alice's bearer, so Alice's next request could run on Bob's subscription. Here, credentials, pending logins, and processes are all keyed by your application's authenticated subject.

Every Codex child process is bound to exactly one subject for its entire life. `SessionManager` may reuse that process for later requests by the same subject, but it must never route another subject through it. Idle processes are closed and evicted after 10 minutes by default, and all processes close during container shutdown. Turns for one subject queue rather than sharing its process concurrently.

## Configuration

- `DATABASE_URL` — PostgreSQL connection string. Use TLS settings appropriate for your provider.
- `CHATGPT_OAUTH_KEY` — exactly 32 bytes encoded as base64/base64url or 64 hex characters. Keep it in a KMS or platform secret store; changing it makes existing credential rows unreadable.
- `SESSION_SECRET` — high-entropy secret used to sign the demo app-session cookie. Generate it independently from `CHATGPT_OAUTH_KEY`.
- `PUBLIC_URL` — the service's public origin, such as `https://your-service.onrender.com`; defaults to `http://localhost:$PORT` locally.
- `PORT` — HTTP port; defaults to `3000`. Render and Railway provide this automatically.

Do not commit any of these values. The database stores AES-256-GCM envelopes under a unique server-derived subject and uses a versioned compare-and-swap update, so concurrent refreshes adopt one winner instead of overwriting each other.

## Run locally

Node 20+, pnpm, PostgreSQL, and a locally available `codex` binary are required. Install the repository and binary once:

```sh
pnpm install
npm install --global @openai/codex
```

Then start the service with one command (replace the sample secrets and database URL):

```sh
DATABASE_URL=postgresql://localhost/chatgpt_oauth \
CHATGPT_OAUTH_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
SESSION_SECRET=replace-with-a-long-random-secret \
PUBLIC_URL=http://localhost:3000 \
pnpm render-service
```

Open `http://localhost:3000/` for the bundled React demo—there is no CDN, font, icon, or stylesheet fetch. The button opens ChatGPT in a popup and becomes an identity chip when polling sees the completed login; use the component's `mode="redirect"` option when popups are unsuitable. `GET /auth/session` returns status, email, and plan metadata only; it never returns access or refresh tokens. `GET /api/chatgpt/usage` reads that same server-derived subject's limits from its isolated Codex process for `<ChatGPTUsage>`. `POST /chat` streams the subject's answer, and `POST /auth/logout` deletes that subject's credentials and closes its process.

## Deploy on Render

1. Create a PostgreSQL database and a new **Web Service** from your copy of this repository.
2. Choose the Docker runtime, keep the repository root as the build context, and set the Dockerfile path to `examples/render-service/Dockerfile`.
3. Add `DATABASE_URL`, `CHATGPT_OAUTH_KEY`, and `SESSION_SECRET` as secrets, plus `PUBLIC_URL` set to the service's HTTPS origin. Do not bake them into the image.
4. Deploy, then use the service's HTTPS origin for browser requests. The container listens on Render's `PORT`.

## Deploy on Railway

1. Create a project from your copy of this repository and add a PostgreSQL service.
2. Configure the app service to build `examples/render-service/Dockerfile` from the repository root.
3. Set `DATABASE_URL` from the PostgreSQL service reference, then add `CHATGPT_OAUTH_KEY` and `SESSION_SECRET` as sealed variables and `PUBLIC_URL` as the generated HTTPS origin.
4. Generate a public HTTPS domain and deploy. Railway supplies `PORT`; no app-server URL is needed.

For either provider, use one service replica unless you extend the template with explicit cross-replica ownership. Database CAS protects credential updates, but it does not turn per-process Codex children into a shared multi-tenant pool.
