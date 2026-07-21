# chatgpt-oauth

Experimental, unofficial OAuth and subscription transport for JavaScript apps whose users bring their own ChatGPT account.

> [!WARNING]
> This package rides the Codex CLI's public OAuth client and an undocumented ChatGPT backend API. It is not an official OpenAI SDK. OpenAI can change or disable the flow at any time. Treat refresh tokens like passwords, never pool tokens or resell subscription access, use this only for personal or self-hosted software unless OpenAI approves your exact use, and keep an API-key or local-model fallback.

`chatgpt-oauth` has zero runtime dependencies, is ESM-only, and keeps platform-specific custody behind a subject-keyed store. Node 20+, browsers, React, React Native/Expo, Electron, and Tauri share the same lifecycle core. Native Swift and Kotlin ports can follow [PROTOCOL.md](./PROTOCOL.md) without reading TypeScript.

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
}} />
```

The component ships no CSS. Its `render={(auth) => ...}` prop exposes the full loading/error/session/actions state. Your session route must return only metadata such as `{ status, email, planType }`, never access or refresh tokens.

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

Run auth and the encrypted file store in the main process. Send only `pending.url`, status metadata, and generated model output over IPC. Never send refresh tokens to the renderer. The Node quickstart works unchanged in the main process; use `shell.openExternal(pending.url)` before awaiting the loopback callback.

## Tauri quickstart

Use device flow in the webview with an injected secure native store, or run the Node flow in a sidecar. The sidecar owns `CredentialStore` and `AuthSession`; the webview receives the verification URL/code and safe status metadata. Do not put credentials in `localStorage`.

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
- `createClient(auth, subject, options?)` returns the `SubscriptionAI` seam: `respond()` and `stream()`.
- `CredentialStore` requires `load(subject)`, `compareAndSwap(subject, expectedVersion, next)`, and `delete(subject)`.
- `createMemoryStore()` is for tests and development only.
- Typed failures: `StateMismatchError`, `ReauthRequiredError`, `TokenRefreshError`, `RateLimitError`, `AuthError`, `TransportError`, `DisabledError`, and `StoreError`. All inherit `ChatGPTOAuthError` and carry a `code` discriminant.

### `chatgpt-oauth/node`

- `createFileCredentialStore({ directory, keyFile?, env? })`
- `waitForLoopbackCallback(pending, { port?, timeoutMs? })`

### `chatgpt-oauth/web`

- `createAuthorizationRedirect(auth, redirectUri)`
- `parseAuthorizationCallback(callback, expectedState)`
- `completeAuthorizationRedirect(auth, subject, callback, pending)`

### `chatgpt-oauth/react`

- `useChatGPTAuth({ endpoints })`
- `<SignInWithChatGPT endpoints render? />`

### `chatgpt-oauth/react-native`

- `createSecureStoreCredentialStore(injectedSecureStore, options?)`

## Lifecycle and operational posture

Access tokens refresh inside a 120-second margin. In-process callers join one promise per `(store, subject)`; stores with cross-process atomic CAS make refreshers adopt the winner. A token-endpoint `invalid_grant`, `invalid_token`, `invalid_request`, bare 401, or bare 403 quarantines only that subject. A 429, 5xx, or network error gets bounded backoff and never destroys credentials. Only a fresh login or `logout()` clears quarantine.

Inference retries exactly once after a 401. `disabled()` is checked before network access so a remote flag can stop subscription traffic immediately.

`logout(subject)` always deletes local credentials. There is no reliable public revoke endpoint for this client. Users can review sessions and sign out at [OpenAI account security](https://auth.openai.com/account).

Keep an API-key or local-model transport ready. Do not silently downgrade between transports or identities.

## Native ports

[PROTOCOL.md](./PROTOCOL.md) defines every endpoint, parameter, claim path, state transition, retry rule, header, SSE frame, and security control for Swift/Kotlin implementations.

## License

MIT
