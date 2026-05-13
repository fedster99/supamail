import { describe, expect, it } from "vitest";
import { decryptPassword, encryptPassword } from "../crypto.js";

const NULL_POOL = null as never;
const KEY = "a".repeat(32);

describe("password encryption", () => {
  it("round-trips ascii passwords", async () => {
    const enc = await encryptPassword(NULL_POOL, "hunter2-secret", KEY);
    expect(Buffer.isBuffer(enc)).toBe(true);
    expect(await decryptPassword(NULL_POOL, enc, KEY)).toBe("hunter2-secret");
  });

  it("round-trips unicode passwords", async () => {
    const enc = await encryptPassword(NULL_POOL, "пароль🔐", KEY);
    expect(await decryptPassword(NULL_POOL, enc, KEY)).toBe("пароль🔐");
  });

  it("produces a distinct ciphertext on each encryption (random IV)", async () => {
    const a = await encryptPassword(NULL_POOL, "same-secret", KEY);
    const b = await encryptPassword(NULL_POOL, "same-secret", KEY);
    expect(a.equals(b)).toBe(false);
  });

  it("rejects decryption with the wrong key (auth tag mismatch)", async () => {
    const enc = await encryptPassword(NULL_POOL, "hunter2", KEY);
    await expect(decryptPassword(NULL_POOL, enc, "b".repeat(32))).rejects.toThrow();
  });

  it("rejects a tampered ciphertext", async () => {
    const enc = await encryptPassword(NULL_POOL, "hunter2", KEY);
    enc[enc.length - 1] ^= 0xFF;
    await expect(decryptPassword(NULL_POOL, enc, KEY)).rejects.toThrow();
  });

  it("rejects a malformed payload", async () => {
    await expect(decryptPassword(NULL_POOL, Buffer.alloc(4), KEY)).rejects.toThrow(/malformed/);
  });

  it("rejects an unsupported version byte", async () => {
    const enc = await encryptPassword(NULL_POOL, "hunter2", KEY);
    enc[0] = 0x99;
    await expect(decryptPassword(NULL_POOL, enc, KEY)).rejects.toThrow(/version/);
  });
});
