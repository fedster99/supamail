#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const SELF = "scripts/check-public-content.mjs";
const forbiddenFiles = new Set(["CONTEXT.md", "SESSION_HANDOFF.md"]);
const forbiddenPhrases = [
  "supamail-cloud",
  "Signal repo",
  "Signal sync engine",
  "Signal product",
  "Signal dashboard",
  "Trigger.dev",
  "old-spec-used-to-build-original",
  "Managed Hosting",
  "BYO Supabase",
  "TURBOPUFFER_API_KEY",
  "SUPAMAIL_BODY_ENCRYPTION_KEY",
  "SUPAMAIL_SECRET_ENCRYPTION_KEY",
  "$5/month",
  "7-day no-card"
];

const publicFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" }
)
  .split("\0")
  .filter(Boolean)
  .sort();

const failures = [];

for (const file of publicFiles) {
  if (!existsSync(file)) continue;

  if (forbiddenFiles.has(file) || file.startsWith(".context/")) {
    failures.push(`${file}: private/local state must not be tracked`);
  }

  if (file === SELF) continue;

  const contents = readFileSync(file);
  if (contents.includes(0)) continue;

  const text = contents.toString("utf8");
  for (const phrase of forbiddenPhrases) {
    if (text.includes(phrase)) {
      failures.push(`${file}: contains forbidden private-context phrase ${JSON.stringify(phrase)}`);
    }
  }

  if (/\/(?:Users|home)\/[^/\s]+\//.test(text) || /[A-Za-z]:\\Users\\[^\\\s]+\\/.test(text)) {
    failures.push(`${file}: contains a machine-specific user path`);
  }
}

if (failures.length > 0) {
  console.error("Public-content hygiene check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Public-content hygiene check passed (${publicFiles.length} public files).`);
