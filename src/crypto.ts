import type { PgPool } from "./db.js";
import { getConfig } from "./config.js";

export function requireEncryptionKey(key = getConfig().IMAP_ENCRYPTION_KEY): string {
  if (!key || key.length < 16) {
    throw new Error("IMAP_ENCRYPTION_KEY must be set to at least 16 characters");
  }
  return key;
}

export async function encryptPassword(
  pool: PgPool,
  plaintext: string,
  key = requireEncryptionKey()
): Promise<Buffer> {
  const result = await pool.query<{ encrypted: Buffer }>(
    "SELECT public.imap_encrypt_password($1, $2) AS encrypted",
    [plaintext, key]
  );
  return result.rows[0].encrypted;
}

export async function decryptPassword(
  pool: PgPool,
  encrypted: Buffer,
  key = requireEncryptionKey()
): Promise<string> {
  const result = await pool.query<{ plaintext: string }>(
    "SELECT public.imap_decrypt_password($1, $2) AS plaintext",
    [encrypted, key]
  );
  return result.rows[0].plaintext;
}
