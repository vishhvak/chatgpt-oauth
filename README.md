# chatgpt-oauth

Experimental, unofficial OAuth and subscription transport for JavaScript apps whose users bring their own ChatGPT account.

> [!WARNING]
> This package rides the Codex CLI's public OAuth client and an undocumented ChatGPT backend API. It is not an official OpenAI SDK. OpenAI can change or disable the flow at any time. Treat refresh tokens like passwords, never pool tokens or resell subscription access, use this only for personal or self-hosted software unless OpenAI approves your exact use, and keep an API-key or local-model fallback.

`chatgpt-oauth` has zero runtime dependencies, is ESM-only, and keeps platform-specific custody behind a subject-keyed store. Node 20+, browsers, React, React Native/Expo, Electron, and Tauri share the same lifecycle core.

## The identity rule

Every credential operation requires a `subject` derived by your server from its own authenticated session. Never accept that value from a request body, never use `chatgpt-account-id` as application identity, and never use a global credential row.

Concrete failure this prevents: ai-finances once seeded one global OAuth token. Bob's login could replace Vish's bearer, so Vish's next request used Bob's subscription while both requests raced to rotate the same refresh token. With this API, the only legal calls are `store.load("vish-app-user-id")` and `store.load("bob-app-user-id")`; there is no `store.load()`.

`accountId`, `planType`, and `email` are decoded from an unverified JWT. They are useful for routing and display only. They must never authorize access.

## Install

```sh
pnpm add chatgpt-oauth
```

React, React Native, and `expo-secure-store` are optional peers. Core and Node installs do not load them.

## Node / CLI quickstart

```ts
import { createAuthSession, createClient } from "chatgpt-oauth";
import { createFileCredentialStore, waitForLoopbackCallback } from "chatgpt-oauth/node";

const store = await createFileCredentialStore({
  directory: `${process.env.HOME}/.my-app/chatgpt`,
});
const auth = createAuthSession({
  store,
  disabled: () => process.env.CHATGPT_SUBSCRIPTIONS_DISABLED === "1",
});
const subject = "default"; // explicit single-user identity; never ambient

const pending = await auth.beginLogin();
console.log(`Open ${pending.url}`);
const callback = await waitForLoopbackCallback(pending);
await auth.completeLogin(subject, callback, pending);

const ai = createClient(auth, subject);
const result = await ai.respond({ model: "gpt-5.4-mini", input: "Explain CAS in one sentence." });
console.log(result.outputText);
```

Pass `onRateLimits` to observe the usage headers attached to each response, or read `ai.lastRateLimits` after a turn. The direct backend transport cannot fetch usage independently because its limits arrive only on response headers.

Run the complete streaming examples without adding a runtime dependency to your app:

```sh
pnpm dlx tsx examples/node-cli/index.ts
pnpm dlx tsx examples/node-cli/app-server.ts
```

The file store creates a `0700` directory, a `0600` AES-256-GCM key, and an atomically replaced `0600` encrypted credential file. Set `CHATGPT_OAUTH_KEY` to a base64/base64url or 64-character hex value encoding exactly 32 bytes to manage the key externally.

## Next.js / hosted web quickstart

Keep `PendingLogin` and credentials on the server, keyed by the subject from your trusted session. The browser receives only the authorize URL and safe session metadata.

```ts
// POST /api/chatgpt/login — server code
import { createAuthorizationRedirect } from "chatgpt-oauth/web";

const subject = requireAppSession(request).user.id; // server-derived
const pending = await createAuthorizationRedirect(auth, "https://app.example/api/chatgpt/callback");
await saveEncryptedPendingLogin(subject, pending); // state + verifier, short TTL
return Response.json({ url: pending.url });
```

```ts
// GET /api/chatgpt/callback — server code
import { completeAuthorizationRedirect } from "chatgpt-oauth/web";

const subject = requireAppSession(request).user.id;
const pending = await takeEncryptedPendingLogin(subject);
await completeAuthorizationRedirect(auth, subject, request.url, pending);
return Response.redirect("https://app.example/settings");
```

```tsx
import { SignInWithChatGPT } from "chatgpt-oauth/react";

<SignInWithChatGPT endpoints={{
  session: "/api/chatgpt/session",
  login: "/api/chatgpt/login",
  logout: "/api/chatgpt/logout",
}} theme="auto" />
```

The zero-config shell injects one scoped stylesheet, opens login in a popup, and polls until the safe session metadata becomes connected. Use `mode="redirect"` when popups are unsuitable. The experimental ToS disclaimer is visible by default; set `showDisclaimer={false}` only when your host UI presents the warning elsewhere.

Customize it with `label`, `theme="auto" | "light" | "dark"`, `className`, `style`, `onConnected`, and `onError`. Host CSS can override `--cgpt-bg`, `--cgpt-fg`, `--cgpt-border`, `--cgpt-radius`, `--cgpt-accent`, and `--cgpt-muted`. The `render={(auth) => ...}` prop remains the complete headless escape hatch. Your session route must return only `{ status, email?, planType? }`, never access or refresh tokens.

This component is web-only. React Native and native Swift/Kotlin apps should use the device flow and their platform-owned login UI rather than embedding this DOM component.

### SQL store shape

The database adapter is application-owned. Use an encrypted column keyed by a server-derived subject and make the version comparison part of the same update:

```sql
UPDATE chatgpt_credentials
SET encrypted_tokens = :aes_gcm_envelope, version = version + 1
WHERE subject = :server_derived_subject AND version = :expected_version
RETURNING encrypted_tokens, version;
```

If no row exists, define its expected version as `0` and use a uniqueness constraint on `subject`. If the update affects zero rows, reload and return the winner. Encryption keys belong in a KMS or server secret store, not in the row.

## React Native / Expo quickstart

Device flow avoids custom-scheme redirect custody. Inject Expo SecureStore so the package has no hard dependency:

```ts
import * as SecureStore from "expo-secure-store";
import { createAuthSession } from "chatgpt-oauth";
import { createSecureStoreCredentialStore } from "chatgpt-oauth/react-native";

const subject = authenticatedProfile.id; // app-owned identity
const auth = createAuthSession({ store: createSecureStoreCredentialStore(SecureStore) });
const login = await auth.startDeviceLogin(subject);
openBrowser(login.verificationUrl);
showCode(login.userCode);
await login.wait();
```

React Native must provide standards-compliant `fetch`, `crypto.getRandomValues`, `crypto.subtle`, `atob`, and `btoa` (Expo runtime support or a platform polyfill). For an authorization-session flow, call `beginLogin(customRedirectUri)`, open the URL with `expo-web-browser`, then pass the returned callback to `completeLogin`.

The injected SecureStore adapter serializes CAS and logout inside one JavaScript runtime. An app that runs multiple JS runtimes against the same native vault must supply a native `CredentialStore` whose CAS is atomic across those runtimes.

## Electron quickstart

Run auth in the main process and send only safe status/output over IPC:

```ts
import { shell } from "electron";

const pending = await auth.beginLogin();
const callbackPromise = waitForLoopbackCallback(pending);
await shell.openExternal(pending.url);
const callback = await callbackPromise;
await auth.completeLogin(mainProcessSession.userId, callback, pending);
```

Never send access or refresh tokens to the renderer.

## Tauri quickstart

Use device flow with a native secure-store bridge, or keep the complete Node flow in a sidecar:

```ts
const store = createTauriSecureCredentialStore(invoke); // native encrypted CAS
const auth = createAuthSession({ store });
const login = await auth.startDeviceLogin(appSession.userId);
await openUrl(login.verificationUrl);
showVerificationCode(login.userCode);
await login.wait();
```

The webview receives only the URL, code, and safe status metadata—never credentials or `localStorage` tokens.

## App-server transport (experimental)

`chatgpt-oauth/app-server` runs the official `codex app-server` binary behind the same `SubscriptionAI` interface. Prefer it on desktop or server hosts that can run Codex: the binary owns backend protocol drift while this package retains subject-scoped token custody.

> [!CAUTION]
> This transport is experimental because codex-rs stamps `chatgptAuthTokens` as **“[UNSTABLE] FOR OPENAI INTERNAL USE ONLY”**. Its method or token contract may change without notice. Keep the direct transport or API-key path available.

```ts
import { createAppServerClient } from "chatgpt-oauth/app-server";

const ai = await createAppServerClient(auth, serverSession.userId, {
  codexHome: "/var/lib/my-app/codex/user-isolated-home",
  onRateLimits: (snapshot) => console.log(snapshot.primary?.usedPercent),
});
try {
  console.log(await ai.getRateLimits());
  const result = await ai.respond({ model: "gpt-5.4-mini", input: "Hello" });
  console.log(result.outputText);
} finally {
  await ai.close();
}
```

Each client uses an isolated `CODEX_HOME`; the child receives a minimal environment and ephemeral credential-store configuration. See `examples/node-cli/app-server.ts` for the runnable login-to-stream flow.

## Deploy

[`examples/render-service`](examples/render-service/README.md) is a copy-and-own template that packages OAuth, a subject-keyed PostgreSQL store, and the Codex binary into one deployable. There is no separate app-server URL.

A Codex child process is bound to exactly one server-derived application subject for its entire life. Reuse it only for that subject, close it on logout or idle eviction, and never turn the example into a shared process/token pool or subscription broker. See the [deployment guide](docs/DEPLOY.md) for the lifecycle rule and provider setup.

## Streaming

```ts
for await (const event of ai.stream({ model: "gpt-5.4-mini", input: "Count to three." })) {
  if (event.type === "response.output_text.delta") process.stdout.write(event.delta ?? "");
  else handleFutureEvent(event); // unknown event types are forwarded
}
```

Every request streams. `respond()` uses the same stream and collects output-text deltas plus the completed response metadata.

## API

### `chatgpt-oauth`

- `createAuthSession({ store, disabled?, fetch?, crypto?, now?, sleep?, protocol? })` returns `beginLogin`, `completeLogin`, `startDeviceLogin`, `getAccessToken`, `refreshAccessToken`, `status`, and `logout`.
- `createClient(auth, subject, { onRateLimits?, ...options })` returns `respond()`, `stream()`, and the latest response-header snapshot as `lastRateLimits`. It has no standalone usage read.
- `CredentialStore` requires `load(subject)`, `compareAndSwap(subject, expectedVersion, next)`, and `delete(subject)`.
- `createMemoryStore()` is for tests and development only.
- Typed failures: `StateMismatchError`, `ReauthRequiredError`, `TokenRefreshError`, `RateLimitError`, `AuthError`, `TransportError`, `DisabledError`, and `StoreError`. All inherit `ChatGPTOAuthError` and carry a `code` discriminant.

### `chatgpt-oauth/node`

- `createFileCredentialStore({ directory, keyFile?, env? })`
- `waitForLoopbackCallback(pending, { port?, timeoutMs? })`

### `chatgpt-oauth/app-server` (experimental)

- `createAppServerClient(auth, subject, { codexBin?, codexHome?, env?, onNotification?, onRateLimits? })` returns the shared AI seam plus `getRateLimits()` and `close()`.
- `AppServerError` and `AppServerRpcError`

### `chatgpt-oauth/web`

- `createAuthorizationRedirect(auth, redirectUri)`
- `parseAuthorizationCallback(callback, expectedState)`
- `completeAuthorizationRedirect(auth, subject, callback, pending)`

### `chatgpt-oauth/react`

- `useChatGPTAuth({ endpoints, mode? })` — `loading | signed-out | connecting | connected | error`
- `<SignInWithChatGPT endpoints label? theme? showDisclaimer? mode? className? style? onConnected? onError? render? />`
- `<ChatGPTUsage endpoints={{ usage }} theme? refreshIntervalMs? className? style? render? />` fetches a safe `RateLimitSnapshot` from an application-owned, subject-bound GET route.

### `chatgpt-oauth/react-native`

- `createSecureStoreCredentialStore(injectedSecureStore, options?)`

## Lifecycle and operational posture

Access tokens refresh inside a 120-second margin. In-process callers join one promise per `(store, subject)`; stores with cross-process atomic CAS make refreshers adopt the winner. A token-endpoint `invalid_grant`, `invalid_token`, `invalid_request`, bare 401, or bare 403 quarantines only that subject. A 429, 5xx, or network error gets bounded backoff and never destroys credentials. Only a fresh login or `logout()` clears quarantine.

Inference retries exactly once after a 401. `disabled()` is checked before network access so a remote flag can stop subscription traffic immediately.

`logout(subject)` always deletes local credentials. There is no reliable public revoke endpoint for this client. Users can review sessions and sign out at [OpenAI account security](https://auth.openai.com/account).

Keep an API-key or local-model transport ready. Do not silently downgrade between transports or identities.

## License

MIT
