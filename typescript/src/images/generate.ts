/**
 * Image generation and editing over a ChatGPT subscription.
 *
 * Both calls are plain JSON POSTs that return base64 PNGs, which makes this the simplest surface
 * in the library: no streaming, no peer connection, no event vocabulary. The interesting part is
 * the failure modes, documented on {@link generateImage}.
 */
import { parseRateLimitHeaders, withAuthRetry } from "../core/client.js";
import { redactedResponseSnippet } from "../core/redact.js";
import { retryAfter } from "../core/oauth.js";
import {
  AuthError,
  RateLimitError,
  TransportError,
  type AuthSession,
  type RateLimitSnapshot,
} from "../core/types.js";
import {
  decodeBase64,
  IMAGE_PROTOCOL,
  type ImageReference,
  type ImageRequestOptions,
  type ImageResponseBody,
  type ImageResult,
} from "./protocol.js";

export interface ImageResultWithLimits extends ImageResult {
  rateLimits: RateLimitSnapshot;
}

function requestBody(
  prompt: string,
  options: ImageRequestOptions,
  images?: ImageReference[],
): string {
  return JSON.stringify({
    ...(images === undefined ? {} : { images }),
    prompt,
    model: options.model ?? options.protocol?.MODEL ?? IMAGE_PROTOCOL.MODEL,
    ...(options.n === undefined ? {} : { n: options.n }),
    ...(options.quality === undefined ? {} : { quality: options.quality }),
    ...(options.background === undefined ? {} : { background: options.background }),
    ...(options.size === undefined ? {} : { size: options.size }),
  });
}

async function post(
  auth: AuthSession,
  subject: string,
  endpoint: string,
  body: string,
  options: ImageRequestOptions,
): Promise<ImageResultWithLimits> {
  const request = options.fetch ?? fetch;
  // Correlates the request with the turn that asked for it; codex sends one per tool call.
  const turnId = crypto.randomUUID();

  const response = await withAuthRetry(auth, subject, async (tokenSet) => {
    try {
      return await request(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenSet.accessToken}`,
          ...(tokenSet.accountId === undefined ? {} : { "chatgpt-account-id": tokenSet.accountId }),
          "x-codex-image-turn-id": turnId,
          originator: "codex_cli_rs",
          "content-type": "application/json",
        },
        body,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TransportError(`Image request failed: ${message}`);
    }
  });

  if (response.status === 429) throw new RateLimitError(retryAfter(response));
  if (response.status === 401 || response.status === 403) {
    // Codex refuses image generation on Free plans before it ever reaches the network, so a 403
    // here most likely means the same thing server-side rather than a bad credential.
    throw new AuthError(
      `Image request rejected (${response.status}). Image generation requires a paid ChatGPT ` +
        "plan; it is unavailable on Free.",
    );
  }
  if (!response.ok) {
    throw new TransportError(
      `Image request failed (${response.status}): ${await redactedResponseSnippet(response)}`,
    );
  }

  const parsed = (await response.json()) as ImageResponseBody;
  return {
    images: (parsed.data ?? []).map((entry) => ({
      base64: entry.b64_json,
      bytes: decodeBase64(entry.b64_json),
    })),
    created: parsed.created,
    ...(parsed.size === undefined ? {} : { size: parsed.size }),
    ...(parsed.quality === undefined ? {} : { quality: parsed.quality }),
    ...(parsed.background === undefined ? {} : { background: parsed.background }),
    ...(parsed.output_format === undefined ? {} : { outputFormat: parsed.output_format }),
    ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
    rateLimits: parseRateLimitHeaders(response.headers),
  };
}

/**
 * Generates images from a text prompt.
 *
 * Two behaviours to expect, both observed live rather than documented: the backend may return a
 * different `size` and `quality` than requested, and generation is slow enough (tens of seconds,
 * longer for edits) that any interactive caller should pass `signal` and show progress.
 */
export async function generateImage(
  auth: AuthSession,
  subject: string,
  prompt: string,
  options: ImageRequestOptions = {},
): Promise<ImageResultWithLimits> {
  const endpoint = options.protocol?.GENERATIONS_URL ?? IMAGE_PROTOCOL.GENERATIONS_URL;
  return post(auth, subject, endpoint, requestBody(prompt, options), options);
}

/**
 * Edits or recombines reference images under a prompt.
 *
 * Build each reference with `imageReference(bytes)`; the endpoint takes data URLs, not raw bytes.
 * Passing several lets the model compose them into one result.
 */
export async function editImage(
  auth: AuthSession,
  subject: string,
  images: ImageReference[],
  prompt: string,
  options: ImageRequestOptions = {},
): Promise<ImageResultWithLimits> {
  if (images.length === 0) {
    throw new TransportError("editImage requires at least one reference image.");
  }
  const endpoint = options.protocol?.EDITS_URL ?? IMAGE_PROTOCOL.EDITS_URL;
  return post(auth, subject, endpoint, requestBody(prompt, options, images), options);
}
