import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { PgPool } from "./db.js";
import { getConfig } from "./config.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const VERSION_BYTE = 0x01;

export function requireEncryptionKey(key = getConfig().IMAP_ENCRYPTION_KEY): string {
  if (!key || key.length < 16) {
    throw new Error("IMAP_ENCRYPTION_KEY must be set to at least 16 characters");
  }
  return key;
}

function deriveKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

export async function encryptPassword(
  _pool: PgPool,
  plaintext: string,
  key = requireEncryptionKey()
): Promise<Buffer> {
  const derived = deriveKey(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, derived, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION_BYTE]), iv, authTag, ciphertext]);
}

export async function decryptPassword(
  _pool: PgPool,
  encrypted: Buffer,
  key = requireEncryptionKey()
): Promise<string> {
  if (!Buffer.isBuffer(encrypted) || encrypted.length < 1 + IV_LENGTH + TAG_LENGTH) {
    throw new Error("Encrypted password payload is malformed");
  }
  const version = encrypted[0];
  if (version !== VERSION_BYTE) {
    throw new Error(`Unsupported encrypted password version: ${version}`);
  }
  const iv = encrypted.subarray(1, 1 + IV_LENGTH);
  const authTag = encrypted.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const ciphertext = encrypted.subarray(1 + IV_LENGTH + TAG_LENGTH);

  const derived = deriveKey(key);
  const decipher = createDecipheriv(ALGORITHM, derived, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
