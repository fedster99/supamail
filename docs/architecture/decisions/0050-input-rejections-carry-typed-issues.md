# ADR 0050: An input rejection names its rule and field as typed data

Status: Accepted

## Problem

ADR 0035 made malformed caller input one typed error, `InvalidInputError`, with
a readable message (`to.0.email: Invalid email`). The message is for the caller.
A host that counts rejections cannot record it: it can echo a caller-supplied
value, and it changes with the validation library's wording. The hosted ledger
therefore matched the fixed rule messages with regular expressions and filed
every other rejection as one generic category, which could not say whether an
agent sent an unknown field, a wrong type, or a value out of range, nor which
argument. Fixing a recurring schema or tool-description mismatch needs exactly
that.

## Decision

- **A fixed, library-independent vocabulary.** `errors.ts` exports
  `INPUT_ISSUE_RULES`: `missing`, `type`, `value`, `unknown_key`, `too_small`,
  `too_big`, `format`, `constraint`. An `InputIssue` is one rule and the `path`
  of the rejected field as the schema declares it (object keys and array
  indexes; the whole input is `[]`). A path never carries caller text: an
  unrecognized key is reported at its object's path, never by the key.
- **Every `invalid_input` carries issues.** `InvalidInputError` takes them as a
  second constructor argument; `toolError` takes them as a fourth and includes
  `issues` in the envelope only when given; `searchInputError` always includes
  them. `inputIssues(zodError)` derives them from a schema failure with the
  same issues, order and cap of five as `formatZodIssues`, mapping Zod's codes
  (`invalid_type` with nothing received is `missing`; an `expected: undefined`
  field, such as draft Bcc, is `unknown_key`). Hand-written rules name their
  rule and field in code: the read_thread selector rules, inline image and
  custom header checks, the sender name limit, and move targets.
- **The message is unchanged.** Codes, hints and readable messages stay as they
  were. `issues` is additive: the HTTP API's 400 body for an engine
  `InvalidInputError` gains it beside `error` and `message`.

## Consequences

- A host records `rule` and, when the tool declares that argument, `path[0]`,
  and never the message. Counting rejections by rule and argument needs no
  text matching and survives a validation library change.
- An agent gets a machine-readable reason beside the readable one. Clients
  that cached a strict tool output schema before extra properties were allowed
  may reject the new field; published schemas no longer forbid it.
- A new rejection must name its rule and field, or carry no issues and be
  counted as a bare `invalid_input`. The default is empty, not a guess.

## Verification

- `errors.test.ts`: each Zod failure maps to its rule with the schema path; an
  unknown key names the object, not the key; typed and readable issues agree
  in order and cap; `parseInput` attaches issues to the thrown error.
- `read-message.test.ts`, `read-thread.test.ts`, `search-tool.test.ts`: the
  envelopes carry `issues` beside the unchanged message; `api-safety.test.ts`:
  the HTTP 400 body carries them too.
