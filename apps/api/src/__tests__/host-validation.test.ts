import { describe, expect, it } from "vitest";
import {
  assertSafeImapTarget,
  assertSafeSmtpTarget,
  HostValidationError,
  isPrivateOrReservedIp
} from "../host-validation.js";

const STRICT = { allowPrivateHosts: false };
const PERMISSIVE = { allowPrivateHosts: true };

describe("isPrivateOrReservedIp", () => {
  it("flags IPv4 private and reserved ranges", () => {
    expect(isPrivateOrReservedIp("10.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedIp("172.16.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("172.31.255.255")).toBe(true);
    expect(isPrivateOrReservedIp("192.168.1.1")).toBe(true);
    expect(isPrivateOrReservedIp("100.64.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("224.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("0.0.0.0")).toBe(true);
  });

  it("allows IPv4 public ranges", () => {
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIp("172.32.0.1")).toBe(false);
    expect(isPrivateOrReservedIp("173.194.0.1")).toBe(false);
  });

  it("flags IPv6 loopback / link-local / multicast / ULA", () => {
    expect(isPrivateOrReservedIp("::1")).toBe(true);
    expect(isPrivateOrReservedIp("fe80::1")).toBe(true);
    expect(isPrivateOrReservedIp("fc00::1")).toBe(true);
    expect(isPrivateOrReservedIp("fd00::1")).toBe(true);
    expect(isPrivateOrReservedIp("ff02::1")).toBe(true);
  });

  it("flags IPv4-mapped IPv6 metadata addresses", () => {
    expect(isPrivateOrReservedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:a9fe:a9fe")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:7f00:1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:0a00:0001")).toBe(true);
    expect(isPrivateOrReservedIp("0:0:0:0:0:ffff:a9fe:a9fe")).toBe(true);
    expect(isPrivateOrReservedIp("0:0:0:0:0:ffff:127.0.0.1")).toBe(true);
  });
});

describe("assertSafeImapTarget", () => {
  it("accepts a public IP literal on a permitted port", async () => {
    await expect(assertSafeImapTarget("8.8.8.8", 993, true, STRICT)).resolves.toBeUndefined();
  });

  it("rejects non-IMAP ports (port check runs before DNS)", async () => {
    await expect(assertSafeImapTarget("8.8.8.8", 80, true, STRICT)).rejects.toBeInstanceOf(HostValidationError);
    await expect(assertSafeImapTarget("8.8.8.8", 25, true, STRICT)).rejects.toBeInstanceOf(HostValidationError);
  });

  it("rejects plaintext IMAP when allowPrivateHosts is false (TLS check runs before DNS)", async () => {
    await expect(assertSafeImapTarget("8.8.8.8", 143, false, STRICT)).rejects.toThrow(/secure=false/i);
  });

  it("rejects IP-literal private/metadata targets", async () => {
    await expect(assertSafeImapTarget("169.254.169.254", 993, true, STRICT)).rejects.toThrow(/private|reserved/i);
    await expect(assertSafeImapTarget("10.0.0.1", 993, true, STRICT)).rejects.toThrow(/private|reserved/i);
    await expect(assertSafeImapTarget("127.0.0.1", 993, true, STRICT)).rejects.toThrow(/private|reserved/i);
  });

  it("rejects localhost by name", async () => {
    await expect(assertSafeImapTarget("localhost", 993, true, STRICT)).rejects.toThrow(/localhost/);
  });

  it("permits private targets when explicitly opted in", async () => {
    await expect(assertSafeImapTarget("127.0.0.1", 143, false, PERMISSIVE)).resolves.toBeUndefined();
    await expect(assertSafeImapTarget("127.0.0.1", 33143, false, PERMISSIVE)).resolves.toBeUndefined();
    await expect(assertSafeImapTarget("localhost", 143, false, PERMISSIVE)).resolves.toBeUndefined();
  });

  it("does not do DNS when permissive (so dry-run fake hostnames are fine)", async () => {
    await expect(
      assertSafeImapTarget("fake.imap.local", 143, false, PERMISSIVE)
    ).resolves.toBeUndefined();
  });
});

describe("assertSafeSmtpTarget", () => {
  it("accepts a public IP literal on a permitted submission port (host classified public)", async () => {
    // Returns the TLS-gate classification; a public host is never private.
    await expect(assertSafeSmtpTarget("8.8.8.8", 465, true, STRICT)).resolves.toEqual({ isPrivateHost: false });
    await expect(assertSafeSmtpTarget("8.8.8.8", 587, false, STRICT)).resolves.toEqual({ isPrivateHost: false });
    await expect(assertSafeSmtpTarget("8.8.8.8", 25, false, STRICT)).resolves.toEqual({ isPrivateHost: false });
  });

  it("rejects non-SMTP ports (port check runs before DNS)", async () => {
    await expect(assertSafeSmtpTarget("8.8.8.8", 993, true, STRICT)).rejects.toBeInstanceOf(HostValidationError);
    await expect(assertSafeSmtpTarget("8.8.8.8", 80, true, STRICT)).rejects.toBeInstanceOf(HostValidationError);
  });

  it("does NOT gate STARTTLS (secure=false) the way plaintext IMAP is gated", async () => {
    // secure=false on SMTP means STARTTLS, a TLS upgrade — allowed on a public host.
    await expect(assertSafeSmtpTarget("8.8.8.8", 587, false, STRICT)).resolves.toEqual({ isPrivateHost: false });
  });

  it("rejects IP-literal private/metadata targets (SSRF guard)", async () => {
    await expect(assertSafeSmtpTarget("169.254.169.254", 465, true, STRICT)).rejects.toThrow(/private|reserved/i);
    await expect(assertSafeSmtpTarget("10.0.0.1", 465, true, STRICT)).rejects.toThrow(/private|reserved/i);
    await expect(assertSafeSmtpTarget("127.0.0.1", 587, false, STRICT)).rejects.toThrow(/private|reserved/i);
    await expect(assertSafeSmtpTarget("::1", 465, true, STRICT)).rejects.toThrow(/private|reserved/i);
  });

  it("rejects localhost by name", async () => {
    await expect(assertSafeSmtpTarget("localhost", 465, true, STRICT)).rejects.toThrow(/localhost/);
  });

  it("permits private targets when explicitly opted in and classifies them private (TLS may relax)", async () => {
    // localhost / a literal private IP under the opt-in are the only cases that
    // relax STARTTLS — they classify private.
    await expect(assertSafeSmtpTarget("127.0.0.1", 3025, false, PERMISSIVE)).resolves.toEqual({ isPrivateHost: true });
    await expect(assertSafeSmtpTarget("localhost", 465, true, PERMISSIVE)).resolves.toEqual({ isPrivateHost: true });
  });

  it("does not do DNS when permissive (so dry-run fake hostnames are fine) and keeps a hostname non-private (requireTLS stays on)", async () => {
    // A permissive hostname is NOT proven private without DNS, so the TLS gate
    // takes the safe default: not private → requireTLS stays on (decision 3).
    await expect(assertSafeSmtpTarget("fake.smtp.local", 587, false, PERMISSIVE)).resolves.toEqual({ isPrivateHost: false });
  });
});
