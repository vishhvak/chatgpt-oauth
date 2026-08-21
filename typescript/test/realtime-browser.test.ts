/**
 * Locks the ordering the WebRTC handshake depends on. Getting it wrong fails silently at runtime:
 * a data channel created after the offer never reaches the SDP, so the session has no events.
 */
import { describe, expect, it, vi } from "vitest";
import { connectLiveCall } from "../src/realtime/browser.js";

const ANSWER_SDP = "v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n";

interface Recorder {
  order: string[];
}

/** Minimal RTCPeerConnection stand-in that records the order of the calls that matter. */
function fakePeerConnection(recorder: Recorder) {
  return class {
    localDescription: unknown = null;
    remoteDescription: unknown = null;
    listeners: Record<string, ((event: unknown) => void)[]> = {};

    addEventListener(type: string, listener: (event: unknown) => void) {
      (this.listeners[type] ??= []).push(listener);
    }
    addTrack() {
      recorder.order.push("addTrack");
    }
    createDataChannel(label: string) {
      recorder.order.push(`createDataChannel:${label}`);
      return { send: vi.fn(), addEventListener: vi.fn(), readyState: "open" };
    }
    async createOffer() {
      recorder.order.push("createOffer");
      return { type: "offer", sdp: "local-offer-sdp" };
    }
    async setLocalDescription(description: unknown) {
      this.localDescription = description;
    }
    async setRemoteDescription(description: unknown) {
      recorder.order.push("setRemoteDescription");
      this.remoteDescription = description;
    }
    close() {
      recorder.order.push("close");
    }
  };
}

function install(recorder: Recorder, options: { getUserMedia?: () => Promise<unknown> } = {}) {
  const tracks = [{ stop: vi.fn() }];
  const stream = { getAudioTracks: () => tracks, getTracks: () => tracks };
  vi.stubGlobal("RTCPeerConnection", fakePeerConnection(recorder));
  vi.stubGlobal("Audio", class { srcObject: unknown = null; async play() {} });
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: options.getUserMedia ?? (async () => stream) },
  });
  return { stream, tracks };
}

describe("connectLiveCall", () => {
  it("creates the data channel and adds the mic before the offer, or the SDP omits them", async () => {
    const recorder: Recorder = { order: [] };
    install(recorder);
    const negotiate = vi.fn(async () => ANSWER_SDP);

    await connectLiveCall({ negotiate });

    const channelIndex = recorder.order.indexOf("createDataChannel:oai-events");
    const trackIndex = recorder.order.indexOf("addTrack");
    const offerIndex = recorder.order.indexOf("createOffer");
    expect(channelIndex).toBeGreaterThanOrEqual(0);
    expect(channelIndex).toBeLessThan(offerIndex);
    expect(trackIndex).toBeLessThan(offerIndex);
    expect(recorder.order.indexOf("setRemoteDescription")).toBeGreaterThan(offerIndex);
  });

  it("hands the local offer to negotiate and applies the returned answer", async () => {
    const recorder: Recorder = { order: [] };
    install(recorder);
    const negotiate = vi.fn(async () => ANSWER_SDP);

    const call = await connectLiveCall({ negotiate });

    expect(negotiate).toHaveBeenCalledWith("local-offer-sdp");
    expect((call.connection as unknown as { remoteDescription: { sdp: string } }).remoteDescription)
      .toEqual({ type: "answer", sdp: ANSWER_SDP });
  });

  it("requests echo cancellation, since without it the model hears its own voice", async () => {
    const recorder: Recorder = { order: [] };
    const getUserMedia = vi.fn(async () => ({
      getAudioTracks: () => [{ stop: vi.fn() }],
      getTracks: () => [{ stop: vi.fn() }],
    }));
    install(recorder, { getUserMedia });

    await connectLiveCall({ negotiate: async () => ANSWER_SDP });

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  });

  it("stops the microphone and closes the connection when negotiation fails", async () => {
    const recorder: Recorder = { order: [] };
    const { tracks } = install(recorder);

    await expect(
      connectLiveCall({
        negotiate: async () => {
          throw new Error("backend refused");
        },
      }),
    ).rejects.toThrow("backend refused");

    expect(tracks[0]?.stop).toHaveBeenCalled();
    expect(recorder.order).toContain("close");
  });
});
