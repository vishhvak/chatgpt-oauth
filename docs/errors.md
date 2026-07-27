---
title: Errors
description: The eight typed failures, what causes each, and what your application should do.
---

Every public failure carries a stable `code`. **Branch on the code, never on the message text.**
Messages are redacted, truncated, and free to change. Codes are contract.

## The table

| Code | Retry? | What your app should do |
| --- | --- | --- |
| `reauth_required` | Never | Prompt a fresh sign-in. The credential is dead. |
| `rate_limit` | After the delay | Back off, honour `Retry-After`, surface a wait to the user. |
| `token_refresh` | Yes, later | Transient refresh failure after internal retries. Fail the request, keep the credential. |
| `transport` | Maybe | Network or non-2xx from the backend. Treat like any upstream failure. |
| `auth` | No | Rejected after a refresh retry, or a rejected authorization callback. |
| `state_mismatch` | No | The OAuth callback did not match. Discard it; do not exchange the code. |
| `disabled` | No | Your own kill switch returned true. Nothing was read and no network was touched. |
| `store` | Depends | Your credential store failed: decrypt, I/O, or an empty subject. Do **not** treat as logged out. |

Class names per port: TypeScript and Kotlin use `ReauthRequiredError`, Swift uses
`ChatGPTOAuthError.reauthRequired`, and Python names it `ReauthRequired`, the one class in that port
without an `Error` suffix. The wire code is `reauth_required` everywhere, which is why matching on
the code rather than the class is the portable habit.

## The two that matter most

### `reauth_required`: the credential is gone

This is the only failure that ends the user's session, and the only one where retrying is actively
harmful. It means either no credential was ever stored for that subject, or the stored one was
[quarantined](./concepts.md#4-quarantine).

`reason` carries OpenAI's own error code. Two you will actually see:

- **`invalid_grant`**. The refresh token was rejected.
- **`refresh_token_invalidated`**. The same ChatGPT account signed in somewhere else and rotated
  the token away. Common for users who also run the Codex CLI. Nothing is wrong with your
  integration; the user just needs to sign in again.

Handle it once, centrally:

```ts
try {
  const token = await auth.getAccessToken(subject);
} catch (error) {
  if (error instanceof ChatGPTOAuthError && error.code === "reauth_required") {
    return promptSignIn();       // the only correct response
  }
  throw error;
}
```

A quarantined subject fails without a network call, so this path is cheap: you do not need to cache
the fact yourself.

### `store`: never means "logged out"

If decryption fails, or the authentication tag does not verify, or the disk is unreadable, you get
`store`. It is deliberately **not** a null record, because the difference matters enormously: a null
record means "this user never signed in", and treating a corrupted vault as a null record silently
discards a live credential and re-prompts a user who was fine.

Surface it as an operational error. Do not delete, and do not re-prompt.

## What is retried for you

You do not need to build these; the library already does:

- **Refresh** retries up to three total attempts, honouring `Retry-After` on `429` and using bounded
  exponential backoff otherwise. Only after the last attempt do you see `rate_limit` or
  `token_refresh`.
- **Requests** retry exactly once on a `401`, forcing a refresh first. A second `401` is `auth` and
  is not retried again.

By the time an error reaches you the sensible recovery has already been tried, so your own retry
loop around `rate_limit` or `token_refresh` mostly adds load.

## Errors never contain secrets

Tokens are stripped before truncation from every thrown message, log line, and nested transport
diagnostic. `Bearer` values, the four JSON/form token fields, and bare JWTs. Enforced by tests in
every port.

The corollary is that error messages are lossy on purpose. If a message looks unhelpfully vague,
that is the redaction working; use the `code` and the `reason` for logic and keep the message for
humans.
