/**
 * Full-duplex voice (gpt-live) over a ChatGPT subscription.
 *
 * Deliberately a separate entry point from `chatgpt-oauth/ai-sdk`. The AI SDK's realtime interface
 * (`RealtimeModelV4`) requires an ephemeral client secret and a WebSocket URL; the subscription
 * backend mints no such secret and refuses WebSocket realtime on a subscription token, so
 * implementing that interface would typecheck and then fail at connect time.
 *
 * What is shared with the AI SDK is the shape of the client surface: connect, exchange events,
 * handle work the model hands back. `onDelegate` plays the role `onToolCall` plays there.
 */
export {
  LIVE_PROTOCOL,
  LIVE_VOICES,
  delegationPrompt,
  liveSessionBody,
  liveText,
  callsUrl,
} from "./protocol.js";
export type {
  LiveChannel,
  LiveClientEvent,
  LiveDelegationItem,
  LiveProtocolOverrides,
  LiveServerEvent,
  LiveSessionConfig,
  LiveTextContent,
  LiveTranscriptItem,
  LiveTurn,
  LiveVoice,
} from "./protocol.js";

export { attachLiveSession, createLiveCall } from "./call.js";
export type {
  LiveCallOptions,
  LiveCallResult,
  LiveChannelLike,
  LiveSession,
  LiveSessionHandlers,
} from "./call.js";
