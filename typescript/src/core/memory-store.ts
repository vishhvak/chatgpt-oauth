/** Provides a deliberately ephemeral subject-keyed store for tests and local development. */
import type { CredentialStore, TokenSet } from "./types.js";

export function createMemoryStore(initial: Readonly<Record<string, TokenSet>> = {}): CredentialStore {
  const records = new Map(Object.entries(initial).map(([subject, token]) => [subject, structuredClone(token)]));
  return {
    async load(subject) { return structuredClone(records.get(subject) ?? null); },
    async compareAndSwap(subject, expectedVersion, next) {
      const current = records.get(subject) ?? null;
      if ((current?.version ?? 0) !== expectedVersion) return { ok: false, current: structuredClone(current) };
      const stored = { ...next, version: expectedVersion + 1 };
      records.set(subject, structuredClone(stored));
      return { ok: true, current: structuredClone(stored) };
    },
    async delete(subject) { records.delete(subject); },
  };
}
