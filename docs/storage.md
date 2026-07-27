---
title: Storage
description: Choosing a credential store, and writing one that is actually safe.
---

A store is three methods. That is the whole extension point, and it is deliberately small so a
correct implementation is short enough to review.

```text
load(subject)                                  -> record or null
compareAndSwap(subject, expectedVersion, next) -> { ok, current }
delete(subject)
```

## Choosing one

| Store | Port | Use for |
| --- | --- | --- |
| memory | all four | Tests and local development. Loses everything on restart. |
| file | TypeScript, Python | A single-process CLI, desktop app, or one-box service. |
| Keychain | Swift | iOS and macOS apps. |
| encrypted preferences | Kotlin (Android) | Android apps. |
| **your database** | any | **Any multi-user server.** Write it yourself; see below. |

There is no built-in database store, and that is intentional. Your schema, migrations, encryption
keys, and backup posture are yours. The [render-service example](./deploying.md) ships a PostgreSQL
implementation to copy and own.

## Writing one

Three requirements. The first is the one people get wrong.

### 1. Compare-and-swap must be atomic

Not "read then write". One atomic operation, or a transaction that behaves like one.

```sql
-- One statement. The WHERE clause is the entire safety property.
UPDATE credentials
   SET payload = $3, version = $2 + 1
 WHERE subject = $1 AND version = $2;
-- 0 rows affected -> CAS lost; re-read and return the winner as `current`.
```

If CAS is not atomic, two concurrent refreshes can each believe they won. The failure looks like
random logouts under load, which is about the worst bug to debug.

On a conflict you must return the **current winner**, not just `ok: false`. Callers adopt it
instead of issuing a second refresh.

### 2. Encrypt at rest

Refresh tokens are password-equivalent: long-lived, and enough to spend someone's subscription. The
built-in stores use AES-256-GCM with a fresh 12-byte IV per write and the envelope
`base64(iv).base64(tag).base64(ciphertext)`. Match that unless your platform gives you something
better (a Keychain, a KMS, a hardware keystore).

Key material comes from a platform keystore, a KMS, or a protected key file: never from the same
row as the ciphertext, and never checked into the repository.

### 3. Fail loudly, never emptily

A decrypt failure, a bad authentication tag, or an I/O error must raise a **store** error. Returning
`null` says "this user never signed in", which discards a live credential and re-prompts a user
whose session was fine. See [Errors](./errors.md#store--never-means-logged-out).

## Also worth getting right

- **Validate the subject.** Reject empty and blank. An empty subject would key one shared row for
  every user: the global credential row the [identity rule](./concepts.md#1-subject-keyed-custody)
  exists to prevent. The library exports a `requireSubject` helper for exactly this.
- **One row per subject**, with a unique constraint. Not one row per session, per device, or per
  token.
- **Delete means delete.** `logout` calls it, and a user asking to disconnect should end up with no
  stored credential.
- **File stores need real atomicity too.** Write to a same-directory temporary with exclusive
  creation, fsync, rename, then fsync the directory, and hold a cross-process lock across the whole
  read-check-write. Directory `0700`, files `0600`.

## Checking your implementation

Point the library's own suite at your store if you can. Otherwise, the three cases worth writing by
hand:

1. **Concurrent CAS.** Fire N simultaneous writes at the same expected version. Exactly one wins;
   the losers get the winner back.
2. **Tampered ciphertext.** Flip one byte and confirm you get a store error, not `null`.
3. **Empty subject.** Confirm it is rejected before any lookup happens.
