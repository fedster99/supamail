import { describe, expect, it } from "vitest";
import { z } from "zod";
import { INPUT_ISSUE_RULES, InvalidInputError, formatZodIssues, inputIssues } from "../errors.js";
import { DRAFT_INPUT_SCHEMA, parseInput } from "../compose-schema.js";

const schema = z
  .object({
    id: z.string().uuid(),
    limit: z.number().int().min(1).max(100).optional(),
    sort: z.enum(["recent", "oldest"]).optional(),
    tags: z.array(z.string()).min(1).optional(),
    nested: z.object({ flag: z.boolean() }).optional()
  })
  .strict()
  .refine((value) => value.limit === undefined || value.sort !== undefined, { message: "limit needs sort" });

const issuesFor = (input: unknown) => {
  const parsed = schema.safeParse(input);
  if (parsed.success) throw new Error("expected a rejection");
  return parsed.error;
};

describe("inputIssues", () => {
  it.each([
    ["a missing required field", {}, [{ rule: "missing", path: ["id"] }]],
    ["a wrong type", { id: 5 }, [{ rule: "type", path: ["id"] }]],
    ["a value outside the enum", { id: "00000000-0000-4000-8000-000000000000", sort: "SECRET" }, [{ rule: "value", path: ["sort"] }]],
    ["a key the schema does not accept, named by the object, not the key", { id: "00000000-0000-4000-8000-000000000000", SECRET: 1 }, [{ rule: "unknown_key", path: [] }]],
    ["a number below its minimum", { id: "00000000-0000-4000-8000-000000000000", limit: 0, sort: "recent" }, [{ rule: "too_small", path: ["limit"] }]],
    ["an array above its maximum", { id: "00000000-0000-4000-8000-000000000000", limit: 101, sort: "recent" }, [{ rule: "too_big", path: ["limit"] }]],
    ["a string that is not a uuid", { id: "SECRET" }, [{ rule: "format", path: ["id"] }]],
    ["a rule across fields", { id: "00000000-0000-4000-8000-000000000000", limit: 5 }, [{ rule: "constraint", path: [] }]],
    ["a nested field by its full path", { id: "00000000-0000-4000-8000-000000000000", nested: { flag: "no" } }, [{ rule: "type", path: ["nested", "flag"] }]]
  ])("types %s", (_label, input, expected) => {
    const error = issuesFor(input);
    expect(inputIssues(error)).toEqual(expected);
    for (const issue of inputIssues(error)) expect(INPUT_ISSUE_RULES).toContain(issue.rule);
  });

  it("reports the same issues, in order and capped, as the readable message", () => {
    const error = issuesFor({ id: 1, limit: "x", sort: "y", tags: [], nested: { flag: 1 }, extra: true });
    const typed = inputIssues(error);
    expect(typed).toHaveLength(5);
    expect(formatZodIssues(error).split("; ")).toHaveLength(5);
    expect(typed.map((issue) => issue.path[0] ?? "input")).toEqual(formatZodIssues(error).split("; ").map((line) => line.split(/[.:]/)[0]));
  });

  it("names a field the operation does not accept as unknown_key", () => {
    const parsed = DRAFT_INPUT_SCHEMA.safeParse({ accountId: "00000000-0000-4000-8000-000000000000", body: { format: "plain", text: "x" }, bcc: [{ email: "x@example.test" }] });
    if (parsed.success) throw new Error("expected a rejection");
    expect(inputIssues(parsed.error)).toEqual([{ rule: "unknown_key", path: ["bcc"] }]);
  });
});

describe("InvalidInputError", () => {
  it("carries the typed issues of a schema failure beside the readable message", () => {
    expect.assertions(3);
    try {
      parseInput(DRAFT_INPUT_SCHEMA, { accountId: "SECRET", body: { format: "plain", text: "x" } });
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidInputError);
      expect((error as InvalidInputError).message).toBe("accountId: Invalid uuid");
      expect((error as InvalidInputError).issues).toEqual([{ rule: "format", path: ["accountId"] }]);
    }
  });

  it("has no issues for a rule that no field owns", () => {
    expect(new InvalidInputError("retired option").issues).toEqual([]);
  });
});
