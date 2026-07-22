/** Persists subject-keyed credentials with AES-GCM, atomic replacement, strict modes, and CAS. */
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { StoreError, type CredentialStore, type TokenSet } from "../core/types.js";

export interface FileStoreOptions {
  directory: string;
  keyFile?: string;
  env?: NodeJS.ProcessEnv;
}

type Records = Record<string, TokenSet>;

function emptyRecords(): Records {
  return Object.create(null) as Records;
}

function parseKey(value: string): Uint8Array {
  const bytes = /^[0-9a-f]{64}$/iu.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
  if (bytes.length !== 32) throw new StoreError("CHATGPT_OAUTH_KEY must encode exactly 32 bytes.");
  return bytes;
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, fsConstants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["EINVAL", "ENOTSUP", "EISDIR"].includes(code ?? "") || (process.platform === "win32" && code === "EPERM")) return;
    throw error;
  }
}

async function atomicWrite(path: string, value: Uint8Array | string): Promise<void> {
  const temporary = `${path}.tmp.${process.pid}.${randomBytes(12).toString("hex")}`;
  let handle;
  try {
    // Exclusive 0600 creation closes the brief plaintext/permission TOCTOU window.
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function resolveKey(directory: string, keyFile: string, env: NodeJS.ProcessEnv): Promise<Uint8Array> {
  if (env.CHATGPT_OAUTH_KEY !== undefined) return parseKey(env.CHATGPT_OAUTH_KEY);
  try {
    const key = await readFile(keyFile);
    if (key.length !== 32) throw new StoreError("The credential key file is malformed.");
    await chmod(keyFile, 0o600);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = randomBytes(32);
  try {
    const handle = await open(keyFile, "wx", 0o600);
    try { await handle.writeFile(key); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(directory);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const deadline = Date.now() + 1_000;
    while (true) {
      const winner = await readFile(keyFile);
      if (winner.length === 32) return winner;
      if (winner.length > 32 || Date.now() >= deadline) throw new StoreError("The credential key file is malformed.");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}

function encrypt(records: Records, key: Uint8Array): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(records), "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${ciphertext.toString("base64")}`;
}

function decrypt(envelope: string, key: Uint8Array): Records {
  try {
    const [ivText, tagText, ciphertextText, extra] = envelope.split(".");
    if (ivText === undefined || tagText === undefined || ciphertextText === undefined || extra !== undefined) throw new Error();
    const iv = Buffer.from(ivText, "base64");
    const tag = Buffer.from(tagText, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64")), decipher.final()]);
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const records = emptyRecords();
    for (const [subject, token] of Object.entries(parsed)) records[subject] = token as TokenSet;
    return records;
  } catch (cause) {
    throw new StoreError("Credential data failed authentication or is malformed.", { cause });
  }
}

async function staleLock(path: string): Promise<boolean> {
  try {
    const [pidText] = (await readFile(path, "utf8")).split(":");
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid <= 0) return Date.now() - (await stat(path)).mtimeMs > 1_000;
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function tryAcquireLock(path: string, owner: string): Promise<boolean> {
  const claim = `${path}.claim.${process.pid}.${randomBytes(12).toString("hex")}`;
  try {
    const handle = await open(claim, "wx", 0o600);
    try { await handle.writeFile(owner); await handle.sync(); } finally { await handle.close(); }
    try { await link(claim, path); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await rm(claim, { force: true });
  }
}

async function releaseLock(path: string, owner: string): Promise<void> {
  const currentOwner = await readFile(path, "utf8").catch(() => "");
  if (currentOwner === owner) await rm(path, { force: true });
}

async function reapStaleLock(path: string, owner: string): Promise<boolean> {
  const reaper = `${path}.reaper`;
  const reaperOwner = `${owner}:reaper`;
  if (!await tryAcquireLock(reaper, reaperOwner)) {
    // A crashed reaper must not make the credential store permanently unavailable.
    if (await staleLock(reaper)) await rm(reaper, { force: true });
    return false;
  }
  try {
    if (await readFile(reaper, "utf8").catch(() => "") !== reaperOwner) return false;
    if (!await staleLock(path)) return false;
    if (await readFile(reaper, "utf8").catch(() => "") !== reaperOwner) return false;
    await rm(path, { force: true });
    return true;
  } finally {
    await releaseLock(reaper, reaperOwner);
  }
}

async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 5_000;
  const owner = `${process.pid}:${randomBytes(12).toString("hex")}`;
  while (!await tryAcquireLock(path, owner)) {
    if (await reapStaleLock(path, owner)) continue;
    if (Date.now() >= deadline) throw new StoreError("Timed out waiting for the credential store lock.");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  try { return await operation(); }
  finally { await releaseLock(path, owner); }
}

export async function createFileCredentialStore(options: FileStoreOptions): Promise<CredentialStore> {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  await chmod(options.directory, 0o700);
  const dataFile = join(options.directory, "credentials.enc");
  const lockFile = join(options.directory, "credentials.lock");
  const keyFile = options.keyFile ?? join(options.directory, "credentials.key");
  const key = await resolveKey(options.directory, keyFile, options.env ?? process.env);

  async function read(): Promise<Records> {
    try { return decrypt(await readFile(dataFile, "utf8"), key); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRecords();
      throw error;
    }
  }

  return {
    async load(subject) { return structuredClone((await read())[subject] ?? null); },
    async compareAndSwap(subject, expectedVersion, next) {
      return withLock(lockFile, async () => {
        const records = await read();
        const current = Object.hasOwn(records, subject) ? records[subject] ?? null : null;
        if ((current?.version ?? 0) !== expectedVersion) return { ok: false, current: structuredClone(current) };
        const stored = { ...next, version: expectedVersion + 1 };
        records[subject] = stored;
        await atomicWrite(dataFile, encrypt(records, key));
        return { ok: true, current: structuredClone(stored) };
      });
    },
    async delete(subject) {
      await withLock(lockFile, async () => {
        const records = await read();
        delete records[subject];
        await atomicWrite(dataFile, encrypt(records, key));
      });
    },
  };
}
