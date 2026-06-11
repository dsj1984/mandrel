---
name: analyze-execution
description: >-
  Aggregate per-Story or per-Epic execution signals into a structured
  perf-summary or perf-report and upsert it onto the corresponding GitHub
  ticket. Use after a Story closes (Story mode) or as part of
  `/deliver` Phase 6 (Epic mode). Reads NDJSON via
  `lib/signals/read` and writes a single structured comment.
allowed_tools:
  - Read
  - Bash
---

# analyze-execution

## Policy Capsule

- Invoke via the wrapping CLI `node .agents/scripts/analyze-execution.js`; do not duplicate the read/write logic from this Skill body.
- Resolve mode strictly by flags: `--story <sid> --epic <eid>` → Story mode; `--epic <eid>` alone → Epic mode.
- Read NDJSON signals only through `lib/signals/read` (the async-iterator entry point). Never open `<tempRoot>/epic-<eid>/story-<sid>/signals.ndjson` directly — the reader owns the warn-once malformed-JSON policy.
- Emit a single structured GitHub comment per ticket (`<!-- structured:story-perf-summary -->` or `<!-- structured:epic-perf-report -->`); rely on `upsertStructuredComment` for idempotence — never post duplicates.
- Never rename or alter the structured-marker IDs; the retro composer and Epic dashboard grep them verbatim.
- Validate the structured payload against `docs/data-dictionary.md §StoryPerfSummary` or `§EpicPerfReport` before posting. Schema violations exit non-zero.
- Soft-fail (exit 0 with a warning) when NDJSON is missing for a Story or an Epic has no children — observability output MUST NOT block the close pipeline.
- Do not write to disk. Persistence is GitHub; the Skill is read-NDJSON + post-comment only.

## Role

Observability writer. Composes the structured `story-perf-summary` /
`epic-perf-report` comment bodies the retro composer downstream renders
into the Epic dashboard.

## When to use

- **Story mode** — after `story-close.js` finishes, the post-merge
  pipeline dispatches this Skill (or the wrapping script) to roll up the
  Story's NDJSON signals into a single `<!-- structured:story-perf-summary -->`
  marker comment on the Story ticket.
- **Epic mode** — during `/deliver` Phase 6.0 (or the retro
  composer), the Skill fans out across every Story under the Epic,
  reads each Story's structured perf summary, and posts a single
  `<!-- structured:epic-perf-report -->` marker on the Epic ticket.

## Inputs

The Skill reads (never writes) the NDJSON signal stream at:

```text
<tempRoot>/epic-<eid>/story-<sid>/signals.ndjson
```

Use the `lib/signals/read` async-iterator entry point — never open the
file directly. Story mode also reads `phase-timings.json` written by
`post-merge-close.js`.

## Outputs

A single upserted GitHub comment per ticket. The Skill writes nothing to
disk — the persist path is GitHub. Idempotence: the underlying script's
`upsertStructuredComment` helper deletes any prior marker before posting
the new one.

## Procedure

### Step 1 — Resolve mode

If both `--story <sid>` and `--epic <eid>` are supplied → Story mode.
If only `--epic <eid>` is supplied → Epic mode. The script
`analyze-execution.js` is the dispatcher today; this Skill documents the
contract the dispatcher implements.

### Step 2 — Read signals via lib/signals/read

```bash
node .agents/scripts/analyze-execution.js --story <sid> --epic <eid>
# or
node .agents/scripts/analyze-execution.js --epic <eid>
```

### Step 3 — Validate the structured payload before posting

The payload must conform to `docs/data-dictionary.md §StoryPerfSummary`
or §EpicPerfReport. Schema violations exit non-zero — the close
pipeline treats that as a non-fatal warning, but the smoke spec pins
the contract so we never silently emit malformed comments.

## Constraints

- Do **not** open `signals.ndjson` outside `lib/signals/read` — the
  reader handles the warn-once policy for malformed JSON lines and
  the streaming-iteration contract.
- Do **not** rename the structured-marker IDs
  (`<!-- structured:story-perf-summary -->`,
  `<!-- structured:epic-perf-report -->`); the retro composer and the
  Epic dashboard both grep for them verbatim.
- Soft-failure mode is intentional: missing NDJSON for a Story or no
  children for an Epic returns exit 0 with a warning so close pipelines
  never block on observability output.
