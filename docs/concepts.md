---
title: Concepts
description: "The custody model: subjects, generations, singleflight refresh, and quarantine."
---

Four ideas carry the whole design. They are worth twenty minutes before you write an integration,
because each one is a decision you cannot easily reverse later.

## 1. Subject-keyed custody

There is no `store.load()`. Only `store.load(subject)`.

A **subject** is a stable identifier for one user of *your* application, derived from *your*
authenticated session. `usr_8f21`, a database primary key, a tenant id: whatever your app already
trusts. The library never invents one and never reads one off the wire.

This is enforced structurally rather than by convention: every store method and every session method
takes the subject as its first argument, so there is no API shape that could read an ambient
credential. An empty or blank subject is rejected outright.

Three things are **not** subjects, no matter how convenient they look:

- **`chatgpt-account-id`** is an unverified JWT claim. It identifies the ChatGPT account, not your
  user, and two of your users could present the same one.
- **Anything from the request**: body, query, header, or a cookie value you did not sign.
- **The email claim** is unverified, and users change emails.

## 2. Generations and compare-and-swap

Each stored record carries a monotonically increasing `version`. Writes are compare-and-swap:

```text
compareAndSwap(subject, expectedVersion, next) -> { ok, current }
```

The write lands only if the stored version still equals `expectedVersion`; otherwise it fails and
hands back the winner. A missing record is version `0`.

This exists because refresh is a read-modify-write across a network call, and two processes can
easily overlap. Without CAS, the slower one overwrites a newer token with an older one and the user
gets logged out for no reason. With CAS, the loser adopts the winner and moves on.

If you write a custom store, **this atomicity is your responsibility** and it is the one thing that
must not be approximated. See [Storage](./storage.md).

## 3. Singleflight refresh

Access tokens are short-lived and refreshed when they come within 120 seconds of expiry. If twenty
concurrent requests all notice staleness at once, you want one refresh, not twenty: a refresh token
may rotate, and spending it twenty times is how you end up with nineteen failures.

So refreshes are deduplicated per `(store, subject)`. Every caller joins the one in-flight refresh.
Note the key: it is scoped to the **store instance**, not to a session object, so building a fresh
session per request over a shared store still collapses correctly.

The deduplication is in-process. Multiple server replicas can still refresh concurrently: that is
what CAS is for, and it is why the refresh re-reads the record inside the critical section rather
than trusting what it read before waiting.

## 4. Quarantine

A terminal rejection means the refresh token was revoked, or rotated away by a sign-in elsewhere.
The credential is dead. No amount of retrying fixes it; only a fresh sign-in
does.

Rather than throwing the same error forever, that generation is marked **quarantined**, and every
later request for that subject fails immediately with `reauth_required` and no network call. Your
application's job is to notice that status and prompt the user to sign in again.

The classification is deliberately narrow. Only a terminal OAuth error code or a bare `401`/`403`
quarantines. A `429`, any `5xx`, a timeout, or a DNS failure **never** does: those are transient,
and destroying a user's session because of a blip would be far worse than the blip.

Quarantine clears on exactly two events: a successful fresh login, or a logout.

```ts
const session = await auth.status(subject);
if (session?.status === "quarantined") {
  // Prompt re-authentication. session.reason carries OpenAI's own error code.
}
```

## How they compose

A request for an access token walks all four:

1. Reject an empty **subject** (1).
2. Load that subject's record and check the **quarantine** marker (4), if set, fail fast.
3. If the token is fresh, return it. Otherwise join the **singleflight** refresh (3).
4. Inside the refresh, re-read, call OpenAI, then **compare-and-swap** the result (2). If CAS loses,
   adopt the winner rather than refreshing again.
5. If OpenAI's rejection was terminal, CAS a **quarantine** marker against that exact generation (4)
   If a healthy newer generation won the race, adopt it and quarantine nothing.

Every port implements exactly this. A behaviour difference between them is a bug.
