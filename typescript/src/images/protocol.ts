/**
 * The image wire protocol on the subscription backend.
 *
 * Two endpoints sit next to `/responses` under the same base URL and take the same bearer token,
 * so nothing here needs an API key. Codex reaches them through its `image_gen.imagegen` tool, and
 * gates that tool on `current_auth_uses_codex_backend`, which is this credential.
 *
 * Every constant was read off a live Pro account, not from documentation.
 */

export const IMAGE_PROTOCOL = {
  GENERATIONS_URL: "https://chatgpt.com/backend-api/codex/images/generations",
  EDITS_URL: "https://chatgpt.com/backend-api/codex/images/edits",
  MODEL: "gpt-image-2",
} as const;

export type ImageProtocolOverrides = Partial<Record<keyof typeof IMAGE_PROTOCOL, string>>;

/** Transparency only survives formats that carry an alpha channel. */
export type ImageBackground = "transparent" | "opaque" | "auto";

export type ImageQuality = "low" | "medium" | "high" | "auto";

export interface ImageRequestOptions {
  model?: string;
  /** Count of images to generate. The backend may return fewer. */
  n?: number;
  quality?: ImageQuality;
  background?: ImageBackground;
  /**
   * Requested pixel size, e.g. `"1024x1024"`. Treat it as a hint: a live Pro account answered a
   * 1024x1024 request with a 1254x1254 image, so read {@link ImageResult.size} for what arrived
   * rather than assuming the request was honoured.
   */
  size?: string;
  fetch?: typeof fetch;
  protocol?: ImageProtocolOverrides;
  /** Edits observed at ~60s on a live account, so callers should be able to give up. */
  signal?: AbortSignal;
}

/** Token accounting the backend reports per request. Absent on older backends. */
export interface ImageUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { image_tokens?: number; text_tokens?: number };
  output_tokens_details?: { image_tokens?: number; text_tokens?: number };
}

/** Raw response body. `data[].b64_json` is the only field guaranteed present. */
export interface ImageResponseBody {
  created: number;
  data: Array<{ b64_json: string }>;
  background?: ImageBackground;
  quality?: ImageQuality;
  size?: string;
  output_format?: string;
  usage?: ImageUsage;
}

export interface GeneratedImage {
  /** Base64 PNG, exactly as the backend sent it. */
  base64: string;
  /** Decoded bytes, ready to write to disk or wrap in a Blob. */
  bytes: Uint8Array;
}

export interface ImageResult {
  images: GeneratedImage[];
  created: number;
  /** What the backend actually produced, which can differ from what was asked for. */
  size?: string;
  quality?: ImageQuality;
  background?: ImageBackground;
  outputFormat?: string;
  usage?: ImageUsage;
}

/** A reference image for editing. The backend takes a data URL, not raw bytes. */
export interface ImageReference {
  image_url: string;
}

/**
 * Wraps bytes as the data URL the edits endpoint expects.
 *
 * `mediaType` must match the actual bytes; the backend reads the payload, not the label.
 */
export function imageReference(
  data: Uint8Array | string,
  mediaType = "image/png",
): ImageReference {
  const base64 = typeof data === "string" ? data : encodeBase64(data);
  return { image_url: `data:${mediaType};base64,${base64}` };
}

/**
 * Base64 helpers that work in browsers and Node alike.
 *
 * `atob`/`btoa` are the only pair present in every target runtime this package supports, so the
 * chunking exists to keep `String.fromCharCode` under its argument-count limit on large images.
 */
export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}
