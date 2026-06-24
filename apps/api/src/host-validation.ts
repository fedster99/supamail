import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

const ALLOWED_IMAP_PORTS = new Set([143, 993]);
// SMTP submission: 465 = implicit TLS, 587 = STARTTLS submission, 25 = relay/MTA.
const ALLOWED_SMTP_PORTS = new Set([25, 465, 587]);
const IPV4_MAPPED_IPV6_PREFIX = "::ffff:";

export interface HostValidationOptions {
  allowPrivateHosts: boolean;
}

export class HostValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HostValidationError";
    this.code = code;
  }
}

function ipv4FromMappedIpv6(ip: string): string | null {
  const lower = ip.toLowerCase();
  let suffix: string | null = null;

  if (lower.startsWith(IPV4_MAPPED_IPV6_PREFIX)) {
    suffix = lower.slice(IPV4_MAPPED_IPV6_PREFIX.length);
  } else {
    const hextets = lower.split(":");
    const leadingZeros = hextets.slice(0, 5).every((part) => /^[0]+$/.test(part));
    if (leadingZeros && hextets[5] === "ffff") {
      if (hextets.length === 7) suffix = hextets[6];
      if (hextets.length === 8) suffix = `${hextets[6]}:${hextets[7]}`;
    }
  }

  if (!suffix) return null;
  if (isIP(suffix) === 4) return suffix;

  const hextets = suffix.split(":");
  if (hextets.length !== 2) return null;

  const [highRaw, lowRaw] = hextets;
  if (!/^[0-9a-f]{1,4}$/.test(highRaw) || !/^[0-9a-f]{1,4}$/.test(lowRaw)) return null;

  const high = Number.parseInt(highRaw, 16);
  const low = Number.parseInt(lowRaw, 16);
  const value = ((high << 16) | low) >>> 0;

  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ].join(".");
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;

  if (family === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
  if (lower.startsWith("ff")) return true;
  const mappedV4 = ipv4FromMappedIpv6(lower);
  if (mappedV4) return isPrivateOrReservedIp(mappedV4);
  return false;
}

export async function assertSafeImapTarget(
  host: string,
  port: number,
  secure: boolean,
  options: HostValidationOptions
): Promise<void> {
  if (typeof host !== "string" || host.length === 0 || host.length > 255) {
    throw new HostValidationError("invalid_host", "IMAP host must be a non-empty string under 255 chars");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HostValidationError("invalid_port", "IMAP port must be an integer from 1 to 65535");
  }
  if (!options.allowPrivateHosts && !ALLOWED_IMAP_PORTS.has(port)) {
    throw new HostValidationError("invalid_port", `IMAP port must be one of: ${[...ALLOWED_IMAP_PORTS].join(", ")}`);
  }
  if (!secure && !options.allowPrivateHosts) {
    throw new HostValidationError(
      "tls_required",
      "Plaintext IMAP (secure=false) requires IMAP_ALLOW_PRIVATE_HOSTS=true"
    );
  }

  const lowerHost = host.toLowerCase();
  if (lowerHost === "localhost") {
    if (!options.allowPrivateHosts) {
      throw new HostValidationError("private_host_denied", "localhost is not an allowed IMAP host");
    }
    return;
  }

  const literalFamily = isIP(host);
  if (literalFamily !== 0) {
    if (isPrivateOrReservedIp(host) && !options.allowPrivateHosts) {
      throw new HostValidationError("private_host_denied", `Refusing to connect to private/reserved IP ${host}`);
    }
    return;
  }

  // With private hosts allowed (dev/self-hosted), skip DNS-resolution checks
  // entirely — the operator has opted into trusting whatever the OS resolves.
  if (options.allowPrivateHosts) return;

  await assertHostResolvesPublicly(host, "IMAP");
}

// Shared SSRF host check: literal-IP and DNS-resolution rejection of
// private/reserved ranges. Used by both the IMAP and SMTP guards. Throws if ANY
// resolved address is private/reserved (the SSRF rejection); returning normally
// therefore means every address resolved public — so a host that reaches here is
// never private (the SMTP TLS gate relies on that).
//
// !!! SSRF GUARD IS CHECK-TIME, NOT CONNECT-TIME (DNS-rebinding TOCTOU) !!!
// This resolves the host and rejects private/reserved IPs, but it does NOT pin
// the resolved IP — connectImap/deliverSmtp re-resolve at socket time, so a
// low-TTL DNS record can return public-at-check and private-at-connect (e.g.
// 169.254.169.254 / a cloud metadata endpoint). In the single-tenant OSS host
// the SMTP/IMAP target is operator-controlled, so this is acceptable. The CLOUD
// MULTI-TENANT LAYER, where a tenant supplies the host, MUST close this window:
// resolve once here, then connect to the LITERAL resolved IP with
// `tls.servername = host` for SNI/cert validation (so check and connect see the
// same address). Do NOT rely on this check alone for untrusted hosts. See ADR
// 0022 (shared connect prelude) and ADR 0017 (send primitive).
async function assertHostResolvesPublicly(host: string, label: string): Promise<void> {
  let resolved: Array<{ address: string }>;
  try {
    resolved = await dnsLookup(host, { all: true, verbatim: true });
  } catch (error) {
    throw new HostValidationError(
      "dns_lookup_failed",
      `Could not resolve ${label} host ${host}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (resolved.length === 0) {
    throw new HostValidationError("dns_no_records", `No DNS records for ${host}`);
  }
  for (const entry of resolved) {
    if (isPrivateOrReservedIp(entry.address)) {
      throw new HostValidationError(
        "private_host_denied",
        `Host ${host} resolves to private/reserved IP ${entry.address}`
      );
    }
  }
}

/** The result of the SMTP target check. `isPrivateHost` is true only when the
 * resolved target is actually private/loopback — it gates whether deliverSmtp may
 * relax STARTTLS enforcement (decision 3): a PUBLIC host always keeps requireTLS,
 * even under IMAP_ALLOW_PRIVATE_HOSTS. */
export interface SmtpTargetCheck {
  isPrivateHost: boolean;
}

// SSRF guard for the send path, mirroring assertSafeImapTarget. SMTP differs in
// two ways: the allowed ports are the submission/relay ports (25/465/587), and
// `secure=false` here means STARTTLS (a TLS upgrade), not plaintext — so it is
// NOT gated behind allowPrivateHosts the way plaintext IMAP is. Returns whether
// the resolved target is private so the caller can decide STARTTLS enforcement.
export async function assertSafeSmtpTarget(
  host: string,
  port: number,
  _secure: boolean,
  options: HostValidationOptions
): Promise<SmtpTargetCheck> {
  if (typeof host !== "string" || host.length === 0 || host.length > 255) {
    throw new HostValidationError("invalid_host", "SMTP host must be a non-empty string under 255 chars");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HostValidationError("invalid_port", "SMTP port must be an integer from 1 to 65535");
  }
  if (!options.allowPrivateHosts && !ALLOWED_SMTP_PORTS.has(port)) {
    throw new HostValidationError("invalid_port", `SMTP port must be one of: ${[...ALLOWED_SMTP_PORTS].join(", ")}`);
  }

  const lowerHost = host.toLowerCase();
  if (lowerHost === "localhost") {
    if (!options.allowPrivateHosts) {
      throw new HostValidationError("private_host_denied", "localhost is not an allowed SMTP host");
    }
    return { isPrivateHost: true };
  }

  const literalFamily = isIP(host);
  if (literalFamily !== 0) {
    const isPrivate = isPrivateOrReservedIp(host);
    if (isPrivate && !options.allowPrivateHosts) {
      throw new HostValidationError("private_host_denied", `Refusing to connect to private/reserved IP ${host}`);
    }
    return { isPrivateHost: isPrivate };
  }

  // allowPrivateHosts (dev/self-hosted), hostname (not localhost / literal IP):
  // skip DNS entirely (dry-run fake hostnames stay cheap). We CANNOT cheaply
  // prove the host is private, so the TLS gate takes the safe default —
  // isPrivateHost = false keeps requireTLS ON even under the opt-in (decision 3).
  // Only localhost and literal private IPs (handled above) relax STARTTLS.
  if (options.allowPrivateHosts) {
    return { isPrivateHost: false };
  }

  // Production path: reject private resolutions. Returning normally means the host
  // resolved public, so it is not private and requireTLS stays on.
  await assertHostResolvesPublicly(host, "SMTP");
  return { isPrivateHost: false };
}
