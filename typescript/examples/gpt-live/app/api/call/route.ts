/**
 * Opens the realtime call.
 *
 * The browser owns the RTCPeerConnection and produces the offer SDP; this route attaches the
 * credential and returns the answer, so the refresh token never reaches the client.
 */
import { NextResponse } from "next/server";
import { createLiveCall, type LiveVoice } from "chatgpt-oauth/realtime";
import { auth, SUBJECT } from "@/lib/auth";

export const runtime = "nodejs";

const INSTRUCTIONS = [
  "You are on a live call. Speak naturally and keep replies short.",
  "You have a client-side delegate that can search and reason. When the user asks anything",
  "needing lookup, current facts, or real thinking, delegate it rather than guessing.",
  "While the delegate works, stay in the conversation instead of going silent.",
].join(" ");

export async function POST(request: Request): Promise<Response> {
  let sdp: string;
  let voice: LiveVoice;
  try {
    const body = (await request.json()) as { sdp?: unknown; voice?: unknown };
    if (typeof body.sdp !== "string" || body.sdp === "") {
      return NextResponse.json({ error: "sdp is required" }, { status: 400 });
    }
    sdp = body.sdp;
    voice = typeof body.voice === "string" ? (body.voice as LiveVoice) : "cove";
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const call = await createLiveCall(auth, SUBJECT, sdp, { instructions: INSTRUCTIONS, voice });
    return NextResponse.json({ sdp: call.answerSdp, callId: call.callId });
  } catch (error) {
    // Library errors are already redacted and typed, so this message is safe to forward.
    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  }
}
