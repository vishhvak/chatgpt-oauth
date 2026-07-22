# ChatGPT OAuth v1 wire protocol

This document is a language-neutral porting specification for the `chatgpt-oauth` v1 flow. A Swift or Kotlin implementation should not need the TypeScript source.

The integration is unofficial. Tokens are credentials. One application subject owns exactly one credential generation; never pool tokens across application users.

## 1. Fixed constants

| Name | Value |
|---|---|
| OAuth client ID | `app_EMoamEEZ73f0CkXaXp7hrann` |
| Authorization | `https://auth.openai.com/oauth/authorize` |
| Token | `https://auth.openai.com/oauth/token` |
| Scope | `openid profile email offline_access` |
| Loopback callback | `http://localhost:1455/auth/callback` |
| Loopback bind | IPv4 `127.0.0.1`, TCP `1455` |
| Device user code | `https://auth.openai.com/api/accounts/deviceauth/usercode` |
| Device poll | `https://auth.openai.com/api/accounts/deviceauth/token` |
| Device verification | `https://auth.openai.com/codex/device` |
| Device exchange redirect | `https://auth.openai.com/deviceauth/callback` |
| Responses | `https://chatgpt.com/backend-api/codex/responses` |
| Refresh margin | 120,000 milliseconds |

Endpoints must be configurable for tests, but these are the production defaults.

## 2. Identity and stored record

The application supplies a nonempty `subject` from its trusted session. Example: the server session says user `usr_123`; every load/CAS/delete uses `usr_123`. A browser-provided `userId`, token, or account ID is never accepted as the subject.

Store one record per subject:

```text
accessToken: string
refreshToken: string
idToken: optional string
expiresAt: integer epoch milliseconds
accountId: optional unverified string
planType: optional unverified string
email: optional unverified string
version: monotonically increasing integer
quarantinedAt: optional epoch milliseconds
quarantineReason: optional string
```

The store has three operations only:

```text
load(subject) -> record or null
compareAndSwap(subject, expectedVersion, next) -> { ok, current }
delete(subject)
```

A missing row has version `0`. CAS persists `next` only when the current version equals `expectedVersion`; the store writes version `expectedVersion + 1`. On conflict it returns the current winner. This atomic comparison is mandatory.

## 3. Base64url and PKCE

Base64url means RFC 4648 URL-safe base64 without `=` padding: base64-encode, replace `+` with `-`, replace `/` with `_`, remove trailing `=`.

1. Generate 64 cryptographically random bytes and base64url-encode them as `code_verifier` (normally 86 characters).
2. SHA-256 the UTF-8 bytes of that verifier and base64url-encode the 32-byte digest as `code_challenge` (43 characters).
3. Generate 32 random bytes and base64url-encode them as `state` (43 characters).
4. Keep verifier, state, and redirect URI in protected short-lived application storage until callback completion.

Known vector:

```text
verifier  dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
challenge E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
```

Compare callback state in constant time: include lengths in an accumulated difference, compare every byte up to the longer length, and accept only if the final difference is zero. Validate state before reading or acting on `code` or `error`.

## 4. Browser authorization-code flow

Open the authorization endpoint with these query parameters:

```text
response_type=code
client_id=app_EMoamEEZ73f0CkXaXp7hrann
redirect_uri=<exact callback URI>
scope=openid profile email offline_access
code_challenge=<generated challenge>
code_challenge_method=S256
state=<generated state>
id_token_add_organizations=true
codex_cli_simplified_flow=true
```

After constant-time state validation, reject an OAuth `error`, require a nonempty `code`, then POST the token endpoint as `application/x-www-form-urlencoded`:

```text
grant_type=authorization_code
client_id=app_EMoamEEZ73f0CkXaXp7hrann
code=<callback code>
code_verifier=<saved verifier>
redirect_uri=<exact original redirect URI>
```

No client secret exists or is sent.

On success, require `access_token`, `refresh_token`, and numeric `expires_in`. Compute `expiresAt = currentEpochMs + expires_in * 1000`; do not subtract a margin. Extract optional metadata as described in section 7. CAS this fresh login against the subject's currently loaded version. A completed fresh login removes quarantine fields.

### Loopback

Bind only `127.0.0.1:1455`, never `0.0.0.0`, `::`, or a public interface. Accept only `/auth/callback`. Validate state before code. Stop after the first callback result and after a maximum of five minutes. Return small self-contained, non-cached HTML; do not interpolate callback values into it.

### iOS and Android

- iOS: use `ASWebAuthenticationSession`, not `WKWebView`. Store credentials in Keychain with a ThisDeviceOnly accessibility class.
- Android: use Custom Tabs. Store credentials in EncryptedSharedPreferences or an equivalently hardware-backed encrypted store.
- Never use an embedded web view to capture passwords or session cookies.

If a mobile app has multiple processes or JavaScript runtimes sharing one vault, implement CAS in the native storage layer. A JavaScript mutex is sufficient only for a single runtime.

## 5. Device flow

POST JSON to the device user-code endpoint:

```json
{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann"}
```

Require `device_auth_id` and `user_code` (accept legacy `usercode`). Present the fixed verification URL and the user code. Convert response `interval` seconds to milliseconds; default to five seconds. Respect `expires_in`; default to 900 seconds.

After each interval, POST JSON to the device poll endpoint:

```json
{"device_auth_id":"<id>","user_code":"<code>"}
```

State transitions:

```text
authorization_pending -> wait current interval -> poll
HTTP 403 or 404 with no success -> wait current interval -> poll
slow_down -> add 5 seconds to interval -> wait increased interval -> poll
success -> require authorization_code + code_verifier -> exchange
deadline -> AuthError(device authorization expired)
other failure -> typed AuthError/TransportError with no credentials persisted
```

Exchange the successful authorization code using the section 4 form, with the returned `code_verifier` and redirect URI `https://auth.openai.com/deviceauth/callback`. Persist only after exchange succeeds.

## 6. Refresh, singleflight, CAS, and quarantine

A token is stale when `expiresAt - currentEpochMs < 120000`.

For each `(store instance, subject)`, all callers join one in-process refresh promise. Clear that exact promise in `finally`. Inside the promise, load the record again and re-check staleness because another process may have rotated while this process waited.

POST refresh as form data:

```text
grant_type=refresh_token
client_id=app_EMoamEEZ73f0CkXaXp7hrann
refresh_token=<current refresh token>
scope=openid profile email offline_access
```

Require `access_token` and `expires_in`. If `refresh_token` is absent, retain the old refresh token. Compute raw expiry. CAS using the pre-request version:

- CAS success: use the refreshed generation.
- CAS conflict: discard this HTTP response and use the returned winner. Never issue a second refresh merely because CAS lost.
- Record deleted: require reauthentication.

### Terminal classification

Quarantine only a token-endpoint response that is:

- an OAuth error code `invalid_grant`, `invalid_token`, or `invalid_request`; or
- any bare HTTP 401 or 403.

CAS `quarantinedAt` and `quarantineReason` against the exact failed generation. If CAS conflicts with a healthy newer token, adopt the healthy winner and do not quarantine it. If the marker wins, every later access-token request throws `ReauthRequiredError(subject, reason)` without network access.

Never quarantine HTTP 429, any 5xx response, timeout, DNS failure, or other network error. Retry transient refresh failures at most three total attempts: honor `Retry-After` for 429 and otherwise use bounded exponential backoff. After the final attempt, a 429 is `RateLimitError`; other transient refresh failures are `TokenRefreshError`.

Only successful fresh login or `logout` clears quarantine. Logout always deletes the subject record. There is no dependable public revoke endpoint for this OAuth client.

## 7. JWT metadata

Prefer `id_token`; if it is absent or malformed, try `access_token`. Split on `.`, base64url-decode segment 2, UTF-8 decode, and parse JSON. Do not verify a signature because the client has no trusted verification step in this protocol.

Read:

```text
payload["https://api.openai.com/auth"].chatgpt_account_id -> accountId
payload["https://api.openai.com/auth"].chatgpt_plan_type   -> planType
payload.email                                              -> email
```

All three are unverified metadata. `accountId` may be sent as request routing metadata, but no claim may determine the application subject, permissions, row ownership, or authorization.

## 8. Responses transport

Create one UUID v4 `session_id` per client instance and reuse it for that instance's requests.

POST `https://chatgpt.com/backend-api/codex/responses?client_version=<version>` with the headers below. The `client_version` query parameter is required: the backend rejects requests without it (`400` missing query param). Track the Codex CLI's released version in one constant (currently `0.144.6`).

```text
authorization: Bearer <access token>
chatgpt-account-id: <accountId>       # omit when unavailable
openai-beta: responses=experimental
originator: codex_cli_rs
content-type: application/json
session_id: <client UUID>
```

The body is:

```json
{
  "model": "<required>",
  "instructions": "<optional>",
  "input": ["<response input items>"],
  "tools": ["<optional tool objects>"],
  "tool_choice": "<optional>",
  "parallel_tool_calls": false,
  "store": false,
  "stream": true,
  "reasoning": {"<optional>": "<object>"},
  "include": ["<optional strings>"]
}
```

Always set the three fixed fields exactly as shown. Both streaming and collected APIs use `stream: true`.

`input` must be a list — the backend rejects a bare string with `400 {"detail":"Input must be a list"}`. Client APIs that accept plain text must wrap it as one user message before sending: `[{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<text>"}]}]`.

Response handling:

- First 401: force refresh through the same singleflight path and retry the request once.
- Second 401: throw typed `AuthError`; do not retry again.
- 429: throw `RateLimitError` with parsed `Retry-After` where available.
- Other non-2xx: read a bounded body snippet, redact it, then throw `TransportError`.

## 9. SSE framing

Decode UTF-8 incrementally. Normalize CRLF/CR to LF. Buffer until a blank line. For each block:

1. Ignore comment lines beginning with `:`.
2. The last `event:` field is the event name; default to `message`.
3. Collect every `data:` field and join values with a literal newline.
4. If joined data equals `[DONE]`, stop.
5. Otherwise parse JSON when possible; opaque text is still valid.
6. Use JSON `type` when it is a string, otherwise the SSE event name.
7. Forward unknown types unchanged.
8. For `response.output_text.delta`, expose and accumulate string `delta`.
9. Retain `response.completed` data as response metadata. Text usually comes from accumulated deltas.
10. At EOF, parse a nonempty trailing block even without a final blank line.

Concrete split example: one network chunk may end at `response.output_` and the next begin with `text.delta`; the parser must emit one event, not two or zero.

## 10. Redaction

No token may appear in a thrown message or log. Redact before truncation:

- `Bearer <value>` -> `Bearer [REDACTED]`
- JSON values for `access_token`, `refresh_token`, `id_token`, and `authorization`
- form/key-value values for the same names

Apply this to every external response body, OAuth error description, parse error preview, and nested transport diagnostic. Do not log request headers or stored records.

## 11. Storage requirements

At rest, encrypt each record or store envelope with AES-256-GCM:

- 32-byte key from a platform keystore, KMS, or protected key file
- fresh 12-byte random IV per write
- 16-byte authentication tag
- envelope `base64(iv).base64(tag).base64(ciphertext)`

Authentication/tag failure is a typed store error, not “logged out” and not an empty record.

On POSIX Node-like systems, the parent directory is mode `0700`; key/data/temp files are `0600`. Create a same-directory unpredictable temporary with exclusive creation, write, flush, fsync, close, atomically rename, fsync the directory when supported, and remove leftovers. Hold a cross-process lock across CAS read/check/write. Database stores use one unique subject row, encrypted credentials, and `UPDATE ... WHERE subject=? AND version=?`.

## 12. Kill switch and error model

Check a runtime `disabled()` callback before loading/refreshing credentials or touching the network. When true, throw `DisabledError`.

Every public failure extends a common error and carries a stable code:

| Error | Code |
|---|---|
| `StateMismatchError` | `state_mismatch` |
| `ReauthRequiredError` | `reauth_required` |
| `TokenRefreshError` | `token_refresh` |
| `RateLimitError` | `rate_limit` |
| `AuthError` | `auth` |
| `TransportError` | `transport` |
| `DisabledError` | `disabled` |
| `StoreError` | `store` |

Do not decide behavior by matching human-readable error strings.
