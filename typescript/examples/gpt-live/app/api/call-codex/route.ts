/**
 * Opens the realtime call through a codex app-server instead of signalling directly.
 *
 * Same browser, same offer, different owner: codex holds the realtime session and its own thread
 * answers the call, so the "brain" is the coding agent itself and `/api/delegate` is not involved.
 * The credential is still this library's; codex receives host-managed tokens and never touches
 * disk. One app-server serves the whole app and calls arrive as threads on it.
 */
import { NextResponse } from "next/server";
import { createAppServerClient, type AppServerClient, type AppServerLiveCall } from "chatgpt-oauth/app-server";
import { auth, SUBJECT } from "@/lib/auth";

export const runtime = "nodejs";

const INSTRUCTIONS = [
  "You are answering a live voice call about this repository. Keep replies short and spoken.",
  "You can read files and run commands through your own tools; do that instead of guessing.",
].join(" ");

let clientPromise: Promise<AppServerClient> | undefined;
let activeCall: AppServerLiveCall | undefined;

function client(): Promise<AppServerClient> {
  clientPromise ??= createAppServerClient(auth, SUBJECT, { realtime: true });
  return clientPromise;
}

export async function POST(request: Request): Promise<Response> {
  let sdp: string;
  let voice: string | undefined;
  try {
    const body = (await request.json()) as { sdp?: unknown; voice?: unknown };
    if (typeof body.sdp !== "string" || body.sdp === "") {
      return NextResponse.json({ error: "sdp is required" }, { status: 400 });
    }
    sdp = body.sdp;
    voice = typeof body.voice === "string" ? body.voice : undefined;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    // One call at a time in this example; a new offer replaces the previous session.
    await activeCall?.close();
    activeCall = undefined;

    const call = await (await client()).startLiveCall({
      offerSdp: sdp,
      cwd: process.cwd(),
      instructions: INSTRUCTIONS,
      ...(voice === undefined ? {} : { voice }),
      onTranscript(delta, role) {
        // Server-side view of the conversation; the browser shows its own via the data channel.
        process.stdout.write(`[voice:${role}] ${delta}`);
      },
      onTranscriptDone() {
        process.stdout.write("\n");
      },
    });
    activeCall = call;
    return NextResponse.json({ sdp: call.answerSdp, threadId: call.threadId });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  }
}

export async function DELETE(): Promise<Response> {
  await activeCall?.close();
  activeCall = undefined;
  return NextResponse.json({ ok: true });
}
