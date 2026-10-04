import { describe, expect, it } from "vitest";
import { structuredEvidenceSha256 } from "../delivery-evidence.js";

const attachment = {
  kind: "attachment_content",
  namespace: "sha256",
  evidence_key_sha256: "a".repeat(64),
  metadata: { filename: "image001.png", sizeBytes: 3070 }
};
const resource = {
  kind: "provider_resource",
  namespace: "github_issue",
  evidence_key_sha256: "b".repeat(64),
  metadata: { provider: "github", number: 42 }
};

describe("structured evidence digest", () => {
  it("is the same for every stored copy of one email", () => {
    // Evidence rows carry the id of the message that holds them.
    const firstRow = { ...attachment, message_id: "00000000-0000-4000-8000-000000000001" };
    const secondRow = { ...attachment, message_id: "00000000-0000-4000-8000-000000000002" };
    const first = structuredEvidenceSha256([firstRow, resource]);
    const second = structuredEvidenceSha256([resource, secondRow]);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the evidence changes", () => {
    expect(structuredEvidenceSha256([attachment])).not.toBe(structuredEvidenceSha256([
      { ...attachment, metadata: { ...attachment.metadata, sizeBytes: 3071 } }
    ]));
    expect(structuredEvidenceSha256([])).not.toBe(structuredEvidenceSha256([attachment]));
  });
});
