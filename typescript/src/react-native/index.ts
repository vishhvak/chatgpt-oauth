/** Adapts an injected SecureStore-compatible implementation without importing Expo at runtime. */
import type { CredentialStore, TokenSet } from "../core/types.js";
import { base64url } from "../core/pkce.js";

export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: { keychainAccessible?: number }): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface SecureStoreOptions {
  prefix?: string;
  setOptions?: { keychainAccessible?: number };
}

const locksByStore = new WeakMap<SecureStoreLike, Map<string, Promise<void>>>();

function keyFor(prefix: string, subject: string): string {
  return `${prefix}.${base64url(new TextEncoder().encode(subject))}`;
}

export function createSecureStore(
  secureStore: SecureStoreLike,
  options: SecureStoreOptions = {},
): CredentialStore {
  const prefix = options.prefix ?? "chatgpt-oauth";
  const locks = locksByStore.get(secureStore) ?? new Map<string, Promise<void>>();
  locksByStore.set(secureStore, locks);

  async function serialized<T>(subject: string, operation: () => Promise<T>): Promise<T> {
    const previous = locks.get(subject) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    locks.set(subject, tail);
    await previous;
    try { return await operation(); }
    finally { release(); if (locks.get(subject) === tail) locks.delete(subject); }
  }

  return {
    async load(subject) {
      const value = await secureStore.getItemAsync(keyFor(prefix, subject));
      return value === null ? null : JSON.parse(value) as TokenSet;
    },
    async compareAndSwap(subject, expectedVersion, next) {
      return serialized(subject, async () => {
        const value = await secureStore.getItemAsync(keyFor(prefix, subject));
        const current = value === null ? null : JSON.parse(value) as TokenSet;
        if ((current?.version ?? 0) !== expectedVersion) return { ok: false, current };
        const stored = { ...next, version: expectedVersion + 1 };
        await secureStore.setItemAsync(keyFor(prefix, subject), JSON.stringify(stored), options.setOptions);
        return { ok: true, current: stored };
      });
    },
    async delete(subject) {
      await serialized(subject, () => secureStore.deleteItemAsync(keyFor(prefix, subject)));
    },
  };
}
