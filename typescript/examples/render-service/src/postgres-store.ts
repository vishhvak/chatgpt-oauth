/** Persists one encrypted token record per server-derived subject with SQL CAS. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import { StoreError, type CredentialStore, type TokenSet } from "chatgpt-oauth";

interface CredentialRow extends QueryResultRow {
  encrypted_tokens: string;
  version: string;
}

export const CREATE_CREDENTIALS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS chatgpt_credentials (
  subject TEXT PRIMARY KEY,
  encrypted_tokens TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (subject)
)`;

function parseKey(value: string): Buffer {
  const bytes = /^[0-9a-f]{64}$/iu.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
  if (bytes.length !== 32) throw new StoreError("CHATGPT_OAUTH_KEY must encode exactly 32 bytes.");
  return bytes;
}

function encrypt(token: TokenSet, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(token), "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${ciphertext.toString("base64")}`;
}

function decrypt(envelope: string, key: Buffer, version: number): TokenSet {
  try {
    const [ivText, tagText, ciphertextText, extra] = envelope.split(".");
    if (ivText === undefined || tagText === undefined || ciphertextText === undefined || extra !== undefined) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64")), decipher.final()]);
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return { ...(parsed as TokenSet), version };
  } catch (cause) {
    throw new StoreError("Credential data failed authentication or is malformed.", { cause });
  }
}

function rowToken(row: CredentialRow, key: Buffer): TokenSet {
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1) throw new StoreError("Credential version is invalid.");
  return decrypt(row.encrypted_tokens, key, version);
}

export async function createPostgresCredentialStore(options: {
  connectionString: string;
  encryptionKey: string;
}): Promise<CredentialStore & { close(): Promise<void> }> {
  const pool = new Pool({ connectionString: options.connectionString });
  const key = parseKey(options.encryptionKey);
  await pool.query(CREATE_CREDENTIALS_TABLE_SQL);

  async function load(subject: string): Promise<TokenSet | null> {
    const result = await pool.query<CredentialRow>(
      "SELECT encrypted_tokens, version FROM chatgpt_credentials WHERE subject = $1",
      [subject],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToken(row, key);
  }

  return {
    load,
    async compareAndSwap(subject, expectedVersion, next) {
      const stored = { ...next, version: expectedVersion + 1 };
      const envelope = encrypt(stored, key);
      const result = expectedVersion === 0
        ? await pool.query<CredentialRow>(`
            INSERT INTO chatgpt_credentials (subject, encrypted_tokens, version)
            VALUES ($1, $2, 1)
            ON CONFLICT (subject) DO NOTHING
            RETURNING encrypted_tokens, version`, [subject, envelope])
        : await pool.query<CredentialRow>(`
            UPDATE chatgpt_credentials
            SET encrypted_tokens = $1, version = version + 1, updated_at = NOW()
            WHERE subject = $2 AND version = $3
            RETURNING encrypted_tokens, version`, [envelope, subject, expectedVersion]);
      const winner = result.rows[0];
      if (winner !== undefined) return { ok: true, current: rowToken(winner, key) };
      // CAS lost: return the winner so AuthSession can discard its rotated token.
      return { ok: false, current: await load(subject) };
    },
    async delete(subject) {
      await pool.query("DELETE FROM chatgpt_credentials WHERE subject = $1", [subject]);
    },
    async close() { await pool.end(); },
  };
}
