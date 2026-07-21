/** Owns subject-bound Codex processes, per-subject turn queues, and idle teardown. */
import type { AppServerClient } from "chatgpt-oauth/app-server";
import type { RateLimitSnapshot } from "chatgpt-oauth";

interface Entry {
  client: Promise<AppServerClient>;
  queue: Promise<void>;
  pendingTurns: number;
  lastUsedAt: number;
}

export interface SessionManagerOptions {
  createClient(subject: string): Promise<AppServerClient>;
  idleMs?: number;
  sweepMs?: number;
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

export class SessionManager {
  readonly #entries = new Map<string, Entry>();
  readonly #createClient: SessionManagerOptions["createClient"];
  readonly #idleMs: number;
  readonly #now: () => number;
  readonly #clearInterval: typeof globalThis.clearInterval;
  readonly #timer: ReturnType<typeof globalThis.setInterval>;
  #closed = false;

  constructor(options: SessionManagerOptions) {
    this.#createClient = options.createClient;
    this.#idleMs = options.idleMs ?? 10 * 60_000;
    this.#now = options.now ?? Date.now;
    this.#clearInterval = options.clearInterval ?? globalThis.clearInterval;
    const schedule = options.setInterval ?? globalThis.setInterval;
    this.#timer = schedule(() => { void this.evictIdle().catch(() => undefined); }, options.sweepMs ?? 60_000);
    this.#timer.unref?.();
  }

  async run<T>(subject: string, turn: (client: AppServerClient) => Promise<T>): Promise<T> {
    if (this.#closed) throw new Error("Session manager is closed.");
    let entry = this.#entries.get(subject);
    if (entry === undefined) {
      // A codex binary process is bound to exactly ONE subject for its entire life.
      // Never reuse it for another subject: that would create a token pool/broker.
      entry = {
        client: this.#createClient(subject),
        queue: Promise.resolve(),
        pendingTurns: 0,
        lastUsedAt: this.#now(),
      };
      this.#entries.set(subject, entry);
      const created = entry;
      // A failed spawn must not pin a rejected promise and block future retries.
      void created.client.catch(() => {
        if (this.#entries.get(subject) === created) this.#entries.delete(subject);
      });
    }

    entry.pendingTurns += 1;
    const result = entry.queue.then(async () => {
      entry.lastUsedAt = this.#now();
      try { return await turn(await entry.client); }
      finally {
        entry.pendingTurns -= 1;
        entry.lastUsedAt = this.#now();
      }
    });
    // The tail always settles successfully so one failed turn cannot poison the queue.
    entry.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  getRateLimits(subject: string): Promise<RateLimitSnapshot> {
    return this.run(subject, (client) => client.getRateLimits());
  }

  async drop(subject: string): Promise<void> {
    const entry = this.#entries.get(subject);
    if (entry === undefined) return;
    this.#entries.delete(subject);
    await (await entry.client).close();
  }

  async evictIdle(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [subject, entry] of this.#entries) {
      if (entry.pendingTurns !== 0 || this.#now() - entry.lastUsedAt <= this.#idleMs) continue;
      this.#entries.delete(subject);
      closing.push(entry.client.then((client) => client.close()));
    }
    await Promise.all(closing);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearInterval(this.#timer);
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map(async (entry) => (await entry.client).close()));
  }
}
