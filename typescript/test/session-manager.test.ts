/** Verifies subject isolation, client reuse, queueing, and idle teardown. */
import { describe, expect, it, vi } from "vitest";
import type { AppServerClient } from "../src/app-server/index.js";
import { SessionManager } from "../examples/render-service/src/session-manager.js";

function fakeClient(label: string): AppServerClient {
  return {
    async respond() { return { outputText: label, events: [] }; },
    async *stream() { yield { type: "test", data: label }; },
    async getRateLimits() { return { primary: { usedPercent: 25 } }; },
    close: vi.fn(async () => undefined),
  };
}

describe("render-service SessionManager", () => {
  it("reuses only a subject's client, queues its turns, and closes idle clients", async () => {
    let now = 0;
    const created: Array<{ subject: string; client: AppServerClient }> = [];
    const manager = new SessionManager({
      now: () => now,
      idleMs: 1_000,
      sweepMs: 60_000,
      async createClient(subject) {
        const client = fakeClient(subject);
        created.push({ subject, client });
        return client;
      },
    });

    try {
      const order: string[] = [];
      let releaseFirst: (() => void) | undefined;
      const first = manager.run("subject-a", async (client) => {
        order.push("first:start");
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        order.push("first:end");
        return client;
      });
      const second = manager.run("subject-a", async (client) => {
        order.push("second:start");
        return client;
      });
      await vi.waitFor(() => { expect(releaseFirst).toBeTypeOf("function"); });
      expect(created.map(({ subject }) => subject)).toEqual(["subject-a"]);
      expect(order).toEqual(["first:start"]);
      releaseFirst?.();
      const [clientA1, clientA2] = await Promise.all([first, second]);
      expect(clientA2).toBe(clientA1);
      expect(order).toEqual(["first:start", "first:end", "second:start"]);

      const clientB = await manager.run("subject-b", async (client) => client);
      expect(clientB).not.toBe(clientA1);
      expect(created.map(({ subject }) => subject)).toEqual(["subject-a", "subject-b"]);
      await expect(manager.getRateLimits("subject-a")).resolves.toEqual({ primary: { usedPercent: 25 } });
      expect(created.map(({ subject }) => subject)).toEqual(["subject-a", "subject-b"]);

      now = 1_001;
      await manager.evictIdle();
      expect(clientA1.close).toHaveBeenCalledOnce();
      expect(clientB.close).toHaveBeenCalledOnce();

      const clientA3 = await manager.run("subject-a", async (client) => client);
      expect(clientA3).not.toBe(clientA1);
      expect(created.map(({ subject }) => subject)).toEqual(["subject-a", "subject-b", "subject-a"]);
    } finally {
      await manager.close();
    }
  });
});
