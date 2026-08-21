/** Spawns an isolated Codex app-server and owns its process-group teardown. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { constants as fsConstants } from "node:fs";
import { AppServerError } from "./errors.js";

const ALLOWED_ENVIRONMENT = new Set(["PATH", "HOME", "TMPDIR", "LANG"]);

export interface AppServerProcessOptions {
  codexBin?: string;
  codexHome?: string;
  env?: Record<string, string>;
  /** Launches codex with its realtime feature, which is off by default. */
  realtime?: boolean;
}

export interface AppServerProcess {
  child: ChildProcessWithoutNullStreams;
  close(): Promise<void>;
}

async function isExecutable(path: string): Promise<boolean> {
  try { await access(path, fsConstants.X_OK); return true; }
  catch { return false; }
}

async function resolveBinary(explicit?: string, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (explicit !== undefined) return explicit;
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, process.platform === "win32" ? "codex.cmd" : "codex");
    if (await isExecutable(candidate)) return candidate;
  }
  const local = join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex");
  if (await isExecutable(local)) return local;
  throw new AppServerError("Codex CLI not found; install @openai/codex or pass codexBin");
}

function minimalEnvironment(overrides: Record<string, string> | undefined, codexHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (ALLOWED_ENVIRONMENT.has(key) || key.startsWith("LC_")) environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (key !== "__proto__" && key !== "constructor" && key !== "prototype") environment[key] = value;
  }
  environment.CODEX_HOME = codexHome;
  return environment;
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    const onExit = () => { cleanup(); resolve(true); };
    const cleanup = () => { clearTimeout(timeout); child.off("exit", onExit); };
    child.once("exit", onExit);
  });
}

function isWithin(path: string, parent: string): boolean {
  const remainder = relative(parent, path);
  return remainder === "" || (!remainder.startsWith(`..${sep}`) && remainder !== "..");
}

async function assertIsolatedHome(codexHome: string): Promise<void> {
  const userCodexHome = resolve(homedir(), ".codex");
  if (isWithin(resolve(codexHome), userCodexHome)) {
    throw new AppServerError("codexHome must not use the user's real ~/.codex directory.");
  }
  async function resolveThroughExistingAncestor(path: string): Promise<string> {
    let cursor = resolve(path);
    const missing: string[] = [];
    for (;;) {
      try { return resolve(await realpath(cursor), ...missing); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(cursor);
        if (parent === cursor) throw error;
        missing.unshift(basename(cursor));
        cursor = parent;
      }
    }
  }
  const [candidate, actualUserHome] = await Promise.all([
    resolveThroughExistingAncestor(codexHome),
    resolveThroughExistingAncestor(userCodexHome),
  ]);
  if (isWithin(candidate, actualUserHome)) {
    throw new AppServerError("codexHome must not resolve into the user's real ~/.codex directory.");
  }
}

async function killProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolveKill) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("error", () => { child.kill("SIGKILL"); resolveKill(); });
      killer.once("exit", () => { resolveKill(); });
    });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
  }
}

export async function spawnAppServer(options: AppServerProcessOptions): Promise<AppServerProcess> {
  const binary = await resolveBinary(options.codexBin);
  const temporaryHome = options.codexHome === undefined;
  const codexHome = options.codexHome ?? await mkdtemp(join(tmpdir(), "chatgpt-oauth-codex-"));
  await assertIsolatedHome(codexHome);
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await chmod(codexHome, 0o700);
  const child = spawn(
    binary,
    [
      "app-server",
      "-c",
      'cli_auth_credentials_store="ephemeral"',
      ...(options.realtime === true ? ["--enable", "realtime_conversation"] : []),
    ],
    {
      detached: process.platform !== "win32",
      env: minimalEnvironment(options.env, codexHome),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdin.on("error", () => undefined);

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    child.stdin.end();
    await waitForExit(child, 1_000);
    // Kill the detached group even if its leader exited during grace; descendants may remain.
    await killProcessTree(child);
    await waitForExit(child, 1_000);
    if (temporaryHome) await rm(codexHome, { recursive: true, force: true });
  }

  child.once("error", () => { void close(); });
  if (child.pid === undefined) {
    await close();
    throw new AppServerError("Codex app-server failed to start.");
  }
  return { child, close };
}
