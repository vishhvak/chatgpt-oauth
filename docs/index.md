---
title: chatgpt-oauth
description: OAuth and subscription transport for apps whose users bring their own ChatGPT account.
---

Let your users spend their own ChatGPT subscriptions inside your application instead of you paying
per token: one OAuth flow, four language ports, one shared wire protocol.

> **Unofficial.** Every port rides the Codex CLI's public OAuth client and an undocumented ChatGPT
> backend. OpenAI can change or disable it without notice. Treat refresh tokens like passwords,
> never pool them across users, and keep an API-key or local-model fallback.

## Start here

| If you want to | Read |
| --- | --- |
| Install and make a first request | your port's README, [TypeScript](https://github.com/vishhvak/chatgpt-oauth/tree/main/typescript), [Python](https://github.com/vishhvak/chatgpt-oauth/tree/main/python), [Swift](https://github.com/vishhvak/chatgpt-oauth/tree/main/swift), [Kotlin](https://github.com/vishhvak/chatgpt-oauth/tree/main/kotlin) |
| Understand the custody model before you design | [Concepts](./concepts.md) |
| Know what an error means and what to do | [Errors](./errors.md) |
| Store credentials for real users | [Storage](./storage.md) |
| Review this before shipping | [Security](./security.md) |
| Implement a fifth port, or check one | [The protocol](https://github.com/vishhvak/chatgpt-oauth/blob/main/PROTOCOL.md) |
| Work on this repo | [Contributing](./contributing.md) |
| Deploy the hosted template | [Deploying](./deploying.md) |

## The one rule

Every credential operation takes a `subject` that **your application derives from its own
authenticated session**. Never from a request body, a query parameter, or a JWT claim.

```ts
// Right: the subject comes from your session.
const token = await auth.getAccessToken(session.userId);

// Wrong: the caller chose whose credentials to use.
const token = await auth.getAccessToken(request.body.userId);
```

Get this wrong and one user spends another user's ChatGPT subscription.
[Concepts](./concepts.md) explains the custody model that prevents it.

## What maturity to expect

TypeScript runs in production in several applications. Python, Swift and Kotlin are ports of the
same specification, checked against mocks and against each other, with no known production use yet.
The repository README keeps a per-surface breakdown, and each port ships an `examples/verify` you
can run against your own account.
