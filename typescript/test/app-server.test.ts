/** Pins the six experimental app-server transport invariants with a scripted child process. */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { TokenRefreshError, type AuthSession, type Session } from "../src/index.js";
import { AppServerError, AppServerRpcError, createAppServerClient, type AppServerClient } from "../src/app-server/index.js";

const fakeCodex = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const subject = "app-user-42";

function authSession(overrides: Partial<AuthSession> = {}): AuthSession {
  const status: Session = {
    subject,
    status: "connected",
    expiresAt: Date.now() + 3_600_000,
    accountId: "account-old",
    planType: "pro",
  };
  return {
    async beginLogin() { throw new Error("unused"); },
    async completeLogin() { throw new Error("unused"); },
    async startDeviceLogin() { throw new Error("unused"); },
    async getAccessToken() { return "access-old"; },
    async refreshAccessToken() { return "access-fresh"; },
    async status() { return status; },
    async logout() {},
    ...overrides,
  };
}

async function workspace(): Promise<{ directory: string; codexHome: string; wireFile: string }> {
  const directory = await mkdtemp(join(tmpdir(), "chatgpt-oauth-appserver-test-"));
  return { directory, codexHome: join(directory, "codex-home"), wireFile: join(directory, "wire.jsonl") };
}

async function closeAndRemove(client: AppServerClient | undefined, directory: string): Promise<void> {
  try { await client?.close(); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function waitForDead(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (alive(pid) && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(alive(pid)).toBe(false);
}

describe("app-server invariants", () => {
  it("fails fast when the Codex CLI cannot be resolved", async () => {
    vi.stubEnv("PATH", "");
    try {
      const failure = await createAppServerClient(authSession(), subject).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AppServerError);
      expect((failure as Error).message).toBe("Codex CLI not found; install @openai/codex or pass codexBin");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("13. sends byte-exact newline JSON initialize then initialized before auth", async () => {
    const work = await workspace();
    let client: AppServerClient | undefined;
    try {
      client = await createAppServerClient(authSession(), subject, {
        codexBin: fakeCodex,
        codexHome: work.codexHome,
        env: { FAKE_WIRE_FILE: work.wireFile },
      });
      await client.close();
      client = undefined;
      const wire = await readFile(work.wireFile, "utf8");
      expect(wire.endsWith("\n")).toBe(true);
      expect(wire).not.toContain("\r");
      expect(wire).not.toContain("Content-Length");
      expect(wire).not.toContain("jsonrpc");
      const lines = wire.trimEnd().split("\n");
      expect(lines[0]).toBe(JSON.stringify({ id: 1, method: "initialize", params: {
        clientInfo: { name: "chatgpt-oauth", title: "ChatGPT OAuth App Server", version: "0.1.0" },
      } }));
      expect(JSON.parse(lines[1] ?? "null")).toEqual({ method: "initialized" });
      expect(JSON.parse(lines[2] ?? "null")).toMatchObject({ id: 2, method: "account/login/start", params: {
        type: "chatgptAuthTokens", accessToken: "access-old", chatgptAccountId: "account-old", chatgptPlanType: "pro",
      } });
    } finally { await closeAndRemove(client, work.directory); }
  });

  it("14. replies to a mid-turn token refresh and completes the turn", async () => {
    const work = await workspace();
    let refreshed = false;
    const refresh = vi.fn(async () => { refreshed = true; return "access-fresh"; });
    const auth = authSession({
      refreshAccessToken: refresh,
      async status() {
        return { subject, status: "connected", expiresAt: Date.now(), accountId: refreshed ? "account-fresh" : "account-old", planType: refreshed ? "plus" : "pro" };
      },
    });
    let client: AppServerClient | undefined;
    try {
      client = await createAppServerClient(auth, subject, {
        codexBin: fakeCodex,
        codexHome: work.codexHome,
        env: { FAKE_CODEX_SCENARIO: "refresh", FAKE_WIRE_FILE: work.wireFile },
      });
      await expect(client.respond({ model: "gpt-test", input: "hello" })).resolves.toMatchObject({ outputText: "fresh answer" });
      expect(refresh).toHaveBeenCalledOnce();
      expect(refresh).toHaveBeenCalledWith(subject);
      const messages = (await readFile(work.wireFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(messages).toContainEqual({ id: 900, result: {
        accessToken: "access-fresh", chatgptAccountId: "account-fresh", chatgptPlanType: "plus",
      } });
    } finally { await closeAndRemove(client, work.directory); }
  });

  it("15. propagates one refresh-handler failure to the active turn", async () => {
    const work = await workspace();
    const refresh = vi.fn(async () => { throw new TokenRefreshError("fixture refresh failed"); });
    let client: AppServerClient | undefined;
    try {
      client = await createAppServerClient(authSession({ refreshAccessToken: refresh }), subject, {
        codexBin: fakeCodex,
        codexHome: work.codexHome,
        env: { FAKE_CODEX_SCENARIO: "refresh-error", FAKE_WIRE_FILE: work.wireFile },
      });
      await expect(client.respond({ model: "gpt-test", input: "hello" })).rejects.toMatchObject({ code: "token_refresh" });
      expect(refresh).toHaveBeenCalledOnce();
      await expect(client.respond({ model: "gpt-test", input: "again" })).resolves.toMatchObject({ outputText: "second answer" });
      const messages = (await readFile(work.wireFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(messages.filter((message) => message.id === 900)).toHaveLength(1);
      expect(messages.find((message) => message.id === 900)).toHaveProperty("error");
    } finally { await closeAndRemove(client, work.directory); }
  });

  it.skipIf(process.platform === "win32")("16. kills the detached child process group on teardown", async () => {
    const work = await workspace();
    const pidFile = join(work.directory, "pids.json");
    let client: AppServerClient | undefined;
    try {
      client = await createAppServerClient(authSession(), subject, {
        codexBin: fakeCodex,
        codexHome: work.codexHome,
        env: { FAKE_CODEX_SCENARIO: "teardown-leader-exit", FAKE_PID_FILE: pidFile },
      });
      const pids = JSON.parse(await readFile(pidFile, "utf8")) as { parent: number; grandchild: number };
      await client.close();
      await client.close();
      client = undefined;
      await waitForDead(pids.parent);
      await waitForDead(pids.grandchild);
    } finally { await closeAndRemove(client, work.directory); }
  });

  it("17. retries -32001 three times then surfaces a typed RPC error", async () => {
    const work = await workspace();
    let client: AppServerClient | undefined;
    try {
      client = await createAppServerClient(authSession(), subject, {
        codexBin: fakeCodex,
        codexHome: work.codexHome,
        env: { FAKE_CODEX_SCENARIO: "overloaded", FAKE_WIRE_FILE: work.wireFile },
      });
      const failure = await client.respond({ model: "gpt-test", input: "hello" }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AppServerRpcError);
      expect((failure as Error).message).toContain("[REDACTED]");
      expect((failure as Error).message).not.toContain("secret-overload");
      const messages = (await readFile(work.wireFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(messages.filter((message) => message.method === "thread/start")).toHaveLength(4);
    } finally { await closeAndRemove(client, work.directory); }
  });

  it("18. passes only allowlisted parent environment variables to the child", async () => {
    const work = await workspace();
    const envFile = join(work.directory, "env.json");
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "poison-secret";
    let client: AppServerClient | undefined;
    try {
      await expect(createAppServerClient(authSession(), subject, {
        codexBin: fakeCodex,
        codexHome: join(homedir(), ".codex"),
      })).rejects.toThrow("must not use the user's real ~/.codex");
      client = await createAppServerClient(authSession(), subject, {
        codexBin: fakeCodex,
        codexHome: work.codexHome,
        env: { FAKE_CODEX_SCENARIO: "env", FAKE_ENV_FILE: envFile },
      });
      const observed = JSON.parse(await readFile(envFile, "utf8")) as { keys: string[]; githubToken: string | null; codexHome: string; argv: string[] };
      expect(observed.githubToken).toBeNull();
      expect(observed.codexHome).toBe(work.codexHome);
      expect(observed.argv).toEqual(["app-server", "-c", 'cli_auth_credentials_store="ephemeral"']);
      expect(observed.keys).not.toContain("GITHUB_TOKEN");
      const explicit = new Set(["CODEX_HOME", "FAKE_CODEX_SCENARIO", "FAKE_ENV_FILE"]);
      // macOS injects this locale hint into child processes even when it is absent from spawn env.
      const systemInjected = new Set(["__CF_USER_TEXT_ENCODING"]);
      const inherited = Object.keys(process.env).filter((key) => ["PATH", "HOME", "TMPDIR", "LANG"].includes(key) || key.startsWith("LC_"));
      expect(observed.keys.filter((key) => !explicit.has(key) && !systemInjected.has(key) && !inherited.includes(key))).toEqual([]);
      expect((await stat(work.codexHome)).mode & 0o777).toBe(0o700);
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
      await closeAndRemove(client, work.directory);
    }
  });

  it("19. maps rate-limit reads and publishes turn notifications", async () => {
    const work = await workspace();
    const onRateLimits = vi.fn();
    let client: AppServerClient | undefined;
    try {
      client = await createAppServerClient(authSession(), subject, {
        codexBin: fakeCodex,
        codexHome: work.codexHome,
        env: { FAKE_CODEX_SCENARIO: "rate-limits", FAKE_WIRE_FILE: work.wireFile },
        onRateLimits,
      });
      await expect(client.getRateLimits()).resolves.toEqual({
        primary: { usedPercent: 25, windowMinutes: 300, resetsAt: 1700003600 },
        secondary: { usedPercent: 4, windowMinutes: 10080, resetsAt: 1700604800 },
        planType: "pro",
        limitName: "Codex",
      });
      await expect(client.respond({ model: "gpt-test", input: "hello" })).resolves.toMatchObject({ outputText: "hello" });
      await vi.waitFor(() => { expect(onRateLimits).toHaveBeenCalledTimes(2); });
      expect(onRateLimits).toHaveBeenLastCalledWith({
        primary: { usedPercent: 26, windowMinutes: 300, resetsAt: 1700007200 },
        planType: "pro",
        limitName: "Codex",
      });
      const messages = (await readFile(work.wireFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(messages).toContainEqual(expect.objectContaining({ method: "account/rateLimits/read" }));
      expect(messages.find((message) => message.method === "account/rateLimits/read")).not.toHaveProperty("params");
    } finally { await closeAndRemove(client, work.directory); }
  });
});
