import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

const ALLOWED_IMAP_PORTS = new Set([143, 993]);
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

  let resolved: Array<{ address: string }>;
  try {
    resolved = await dnsLookup(host, { all: true, verbatim: true });
  } catch (error) {
    throw new HostValidationError(
      "dns_lookup_failed",
      `Could not resolve IMAP host ${host}: ${error instanceof Error ? error.message : String(error)}`
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
