/** Generates browser-safe PKCE and checks OAuth state without data-dependent early exits. */
import { StateMismatchError } from "./types.js";

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function pkceChallenge(verifier: string, webCrypto: Crypto = crypto): Promise<string> {
  const digest = await webCrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function random(bytes: number, webCrypto: Crypto): string {
  return base64url(webCrypto.getRandomValues(new Uint8Array(bytes)));
}

export async function createPkce(webCrypto: Crypto = crypto): Promise<{
  verifier: string;
  challenge: string;
  state: string;
}> {
  const verifier = random(64, webCrypto);
  return { verifier, challenge: await pkceChallenge(verifier, webCrypto), state: random(32, webCrypto) };
}

export function assertState(expected: string, actual: string | null): void {
  const left = new TextEncoder().encode(expected);
  const right = new TextEncoder().encode(actual ?? "");
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  if (difference !== 0) throw new StateMismatchError();
}
