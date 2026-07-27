---
title: Security
description: What the library guarantees, what it does not, and what to check before shipping.
---

## What the library handles

- **Tokens never appear in errors or logs.** `Bearer` values, the four JSON and form token fields,
  and bare JWTs are redacted before truncation, so a cut string cannot defeat the scrubber. Enforced
  by tests in every port; [Errors](./errors.md#errors-never-contain-secrets) lists the surfaces.
- **Callback state is compared in constant time**, and validated before the `code` or `error`
  parameter is read at all.
- **The loopback listener binds `127.0.0.1` only**, never `0.0.0.0`. It accepts one path, stops after
  the first result, times out after five minutes, and never interpolates callback values into its
  HTML response.
- **Credentials are encrypted at rest** in every built-in store, with a typed error on
  authentication failure rather than a silent empty read.
- **PKCE with S256.** No client secret exists, because this is a public client.

## What is yours

**Deriving the subject.** The library takes whatever you pass. If that comes from a request body, you
have built a way for one user to spend another's subscription. See
[Concepts](./concepts.md#1-subject-keyed-custody).

**Your credential store**, if you wrote one. Atomic CAS, encryption at rest, and loud failures.
See [Storage](./storage.md).

**Session and CSRF protection on your own routes.** The login and logout routes you expose are
state-changing endpoints in your application, and they need whatever protection the rest of your
app uses.

**Transport to your own server.** HTTPS, and `Secure`, `HttpOnly` and `SameSite` on whichever cookie
carries the session your subjects are derived from.

## JWT claims are unverified, by design

`accountId`, `planType` and `email` are read from the token payload **without signature
verification**, because this client has no trusted verification step in the protocol.

They are safe for exactly two things: routing metadata (`chatgpt-account-id` on outbound requests)
and display. They must never determine identity, permissions, row ownership, or any authorization
decision. `extractUnverifiedClaims` is named the way it is on purpose.

## Threats worth thinking about

**A stolen refresh token is a stolen subscription.** It is long-lived and, until revoked, sufficient.
Encrypt at rest, keep it off logs, and scope database access accordingly.

**Local processes on a developer machine** can reach the loopback listener during the five-minute
sign-in window. It refuses to settle on a callback whose `state` does not match, so a process that
cannot guess a 32-byte secret cannot complete or cancel a sign-in.

**A compromised dependency** in your build can read anything your process can. The TypeScript
package ships **zero runtime dependencies** for this reason, and the repository pins a minimum
release age and refuses provenance downgrades for its own build tooling.

**Multi-tenant pooling is the failure this design exists to prevent.** One subject, one credential
row, one app-server process. Do not build a shared pool or resell subscription access.

## Before you ship

- [ ] The subject comes from your session, never from the request.
- [ ] Your store's CAS is one atomic operation, and returns the winner on conflict.
- [ ] Credentials are encrypted at rest with a key that is not stored beside them.
- [ ] A `store` error is surfaced as an error, not as "logged out".
- [ ] `reauth_required` prompts a fresh sign-in rather than retrying.
- [ ] No JWT claim is used for an authorization decision.
- [ ] You have an API-key or local-model fallback for when this breaks.
- [ ] Your logs have been checked for token-shaped strings.

## Reporting something

Open an issue for anything non-sensitive. For a vulnerability, use GitHub's private security
advisory reporting on the repository rather than a public issue.
