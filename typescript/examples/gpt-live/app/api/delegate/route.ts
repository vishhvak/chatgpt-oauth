/**
 * Runs one delegated task on the frontier model and streams it back as NDJSON.
 *
 * This uses the AI SDK provider rather than the raw client, which is the point: the voice model
 * handles conversation, and anything needing real work goes through the same tooling the rest of
 * an app already uses. Swap `streamText` for `generateObject` or add tools and the delegate gains
 * those abilities without the voice layer knowing anything about it.
 */
import { streamText } from "ai";
import { createChatGPT } from "chatgpt-oauth/ai-sdk";
import { auth, SUBJECT } from "@/lib/auth";

export const runtime = "nodejs";

const DELEGATE_MODEL = "gpt-5.6-sol";

export async function POST(request: Request): Promise<Response> {
  let prompt: string;
  try {
    const body = (await request.json()) as { prompt?: unknown };
    if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
      return Response.json({ error: "prompt is required" }, { status: 400 });
    }
    prompt = body.prompt;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const chatgpt = createChatGPT(auth, SUBJECT);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const line = (value: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      try {
        const result = streamText({
          model: chatgpt(DELEGATE_MODEL),
          system:
            "You are the research half of a live voice call. Answer in at most three sentences, " +
            "written to be spoken aloud: no lists, no markdown, no citations.",
          prompt,
        });
        let full = "";
        for await (const delta of result.textStream) {
          full += delta;
          line({ type: "delta", text: delta });
        }
        line({ type: "done", text: full });
      } catch (error) {
        line({ type: "error", text: (error as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}
