/**
 * The browser half of a gpt-live call: peer connection, microphone, audio sink.
 *
 * Kept apart from {@link ../realtime/call.js} on purpose. That module is transport-agnostic and
 * runs anywhere, including Node and tests with no WebRTC at all. This one touches `window`, so it
 * ships as its own entry point rather than dragging DOM types into the core.
 *
 * Audio never passes through JavaScript here. WebRTC carries it as media tracks, so the microphone
 * is attached with `addTrack` and the reply is played by pointing an audio element at the incoming
 * stream. Any PCM conversion in a gpt-live client is a sign the wrong transport is being used: the
 * chunked-audio path belongs to the WebSocket wire, which a subscription token cannot open.
 */
import { attachLiveSession, type LiveSession, type LiveSessionHandlers } from "./call.js";

export interface BrowserCallOptions extends LiveSessionHandlers {
  /**
   * Exchanges the local offer for the remote answer.
   *
   * Deliberately a callback rather than a URL: credentials belong on a server, so the browser
   * posts the SDP to an endpoint of your own that calls `createLiveCall`.
   */
  negotiate: (offerSdp: string) => Promise<string>;
  /**
   * Where the reply is played. Supply an element to control autoplay policy and volume yourself;
   * omit it and a detached element is created, which suffices once the user has interacted.
   */
  audioElement?: HTMLAudioElement;
  /** Passed to `getUserMedia`. Echo cancellation is on by default; without it the model hears itself. */
  audioConstraints?: MediaTrackConstraints;
  peerConnectionConfig?: RTCConfiguration;
}

export interface BrowserCall {
  session: LiveSession;
  connection: RTCPeerConnection;
  /** The captured microphone stream, so callers can mute without tearing the call down. */
  microphone: MediaStream;
  /** Stops the microphone, closes the peer connection, and asks the backend to end the session. */
  hangUp: () => void;
}

const DEFAULT_AUDIO: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * Opens a call from a browser and returns once the answer is applied.
 *
 * Ordering here is load-bearing and easy to get wrong: the data channel must exist *before*
 * `createOffer`, or it never appears in the SDP and the session silently has no event channel.
 * The microphone track must also be added before the offer for the same reason.
 */
export async function connectLiveCall(options: BrowserCallOptions): Promise<BrowserCall> {
  const { negotiate, audioElement, audioConstraints, peerConnectionConfig, ...handlers } = options;

  const connection = new RTCPeerConnection(peerConnectionConfig);
  const sink = audioElement ?? new Audio();
  let microphone: MediaStream | undefined;

  function hangUp(): void {
    microphone?.getTracks().forEach((track) => track.stop());
    sink.srcObject = null;
    connection.close();
  }

  try {
    connection.addEventListener("track", (event) => {
      sink.srcObject = event.streams[0] ?? null;
      void sink.play().catch(() => {
        // Autoplay can be refused until the user interacts. The call is still live; the caller
        // decides whether to surface a prompt, so a rejection here must not fail the connect.
      });
    });

    microphone = await navigator.mediaDevices.getUserMedia({
      audio: { ...DEFAULT_AUDIO, ...audioConstraints },
    });
    for (const track of microphone.getAudioTracks()) connection.addTrack(track, microphone);

    const channel = connection.createDataChannel("oai-events");
    const session = attachLiveSession(channel, handlers);

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    if (offer.sdp === undefined) throw new Error("Offer contained no SDP.");

    const answerSdp = await negotiate(offer.sdp);
    await connection.setRemoteDescription({ type: "answer", sdp: answerSdp });

    return {
      session,
      connection,
      microphone,
      hangUp() {
        session.close();
        hangUp();
      },
    };
  } catch (error) {
    hangUp();
    throw error;
  }
}
