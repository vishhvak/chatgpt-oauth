# gpt-live over ChatGPT OAuth

Full-duplex voice on a ChatGPT subscription, with the frontier model wired in behind it.

```sh
cd typescript && pnpm dlx tsx examples/verify.ts   # sign in once, if you have not
cd examples/gpt-live && pnpm install && pnpm dev
```

If you signed in through a different example, point this one at that subject:
`CHATGPT_OAUTH_SUBJECT=default pnpm dev`.

Open http://localhost:3000, allow the microphone, and talk. Ask it something that needs a real
lookup and watch the orb turn amber: that is `gpt-5.6-sol` answering in the background while
gpt-live keeps talking to you.

## Why this is not a turn-based voice demo

`gpt-live-1-boulder-alpha` is full-duplex. It listens and speaks at the same time and makes an
interaction decision many times per second: speak, keep listening, pause, interrupt, or delegate.
There is no request and no response, so there is nothing to hang a send button on. Concretely,
from a captured session:

```
turn.created  [assistant]  start_ms 8600     <- it starts talking
turn.done     [user]       end_ms   8800     <- while the user turn is still open
```

The assistant began speaking 200ms before the user's turn closed. A turn-based client cannot
express that, which is why this example has no push-to-talk and no "send" affordance. The mic
opens on connect and stays open until you hang up.

## The delegation loop

This is the part worth copying. The session declares:

```json
{ "delegation": { "type": "client" } }
```

which makes **this app** the background model. When gpt-live decides a question needs real work,
it does not reason about it. It emits:

```json
{"type": "delegation.created", "offset_ms": 6200,
 "item": {"id": "item_…", "type": "delegation", "target": "client",
          "content": [{"type": "input_text", "text": "Can you look up how many people live in Tokyo right now"}]}}
```

`app/api/delegate/route.ts` runs that prompt through `createClient` against `/responses`, and the
browser feeds the result back on one of two channels:

| channel | when | effect |
| --- | --- | --- |
| `commentary` | while the work is still running | spoken as a progress aside, so the call does not go silent |
| `speakable` | when the answer is ready | spoken as the answer |
| `analysis` | any time | added as context, never voiced |

So both legs of the loop ride the same OAuth token: the voice leg on `/realtime/calls`, the
reasoning leg on `/responses`. That is the entire architecture of the announcement, reproduced on
a subscription credential.

## The wire protocol

The protocol lives in the library, at `chatgpt-oauth/realtime`. This app imports `createLiveCall`
and `attachLiveSession` from it and never restates the wire format. Three things must be right
together or the call is rejected, and the library gets them right for you:

1. Query `?intent=quicksilver&architecture=avas`. Both. Dropping `architecture` returns
   `400 Header 'OpenAI-Alpha' requires 'intent=quicksilver&architecture=avas'`.
2. Header `openai-alpha: quicksilver=v2`. The `v2` in this value selects the wire that Codex's
   own source calls v3. The naming genuinely is inconsistent upstream.
3. A session body with **no `type` field** and no `audio.input` block, carrying
   `delegation: {"type": "client"}` instead.

Getting item 3 wrong is the interesting failure: sending `{"type": "quicksilver"}` returns
`403 Voice session access denied` on an account that the shape above works on. The 403 reads like
an entitlement problem and is not one.

Client events are limited to five, and the server names them if you send anything else:
`session.update`, `session.context.append`, `delegation.context.append`,
`delegation.function_call_output.create`, `session.close`. In particular
`conversation.item.create` and `response.create` do not exist here.

Server events are also their own vocabulary. Transcript text lives at `item.text`, not `delta`:

| this wire | the turn-based wire |
| --- | --- |
| `session.started` | `session.created` |
| `turn.created` / `turn.delta` / `turn.done` | `response.created` / `response.done` |
| `output_transcript.added` | `response.output_audio_transcript.delta` |
| `input_transcript.added` | `conversation.item.input_audio_transcription.delta` |
| `delegation.created` | (no equivalent) |

Turns carry `start_ms` / `end_ms` and a rolling `transcript`, which is a better shape than
accumulating deltas: you get both sides of the conversation as completed turns.

## Layout

| file | role |
| --- | --- |
| `lib/auth.ts` | one server-side session; the browser never sees a token |
| `app/api/call/route.ts` | `createLiveCall` from `chatgpt-oauth/realtime` |
| `app/api/delegate/route.ts` | `streamText` over `chatgpt-oauth/ai-sdk`, streamed back as NDJSON |
| `components/live-call.tsx` | the peer connection and the UI; `attachLiveSession` runs the event loop |
| `components/fluid-orb.tsx` | WebGL orb, colour driven by call phase |

The delegate deliberately goes through the AI SDK provider rather than the raw client. That is
what makes the two halves compose: add tools or swap `streamText` for `generateObject` and the
delegate gains those abilities without the voice layer knowing anything about it.

## Why not the AI SDK's own realtime interface

`RealtimeModelV4` requires `doCreateClientSecret()` to mint an ephemeral token and
`getWebSocketConfig()` to return a WebSocket URL. The subscription backend mints no such secret,
and Codex's own source refuses WebSocket realtime on a subscription token
(`realtime conversation requires API key auth`). Implementing that interface would typecheck and
then fail at connect time, so `chatgpt-oauth/realtime` is a sibling of the AI SDK realtime surface
rather than a provider for it. It borrows the shape: `onDelegate` is the `onToolCall` role.

## Caveats

The WebSocket transport does not work on a subscription token. Codex's own client requires an API
key for it and errors `realtime conversation requires API key auth`. WebRTC is the only path here,
so this example needs a browser or another real WebRTC stack.

Everything above was read off a live Pro account in August 2026. It is an undocumented backend and
can change without notice. The warning at the top of the repo README applies in full.
