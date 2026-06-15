---
name: epic-plan-premortem
description: >-
  Run a fresh-context, code-reading pre-mortem critic over the draft Story
  ticket array an Epic's decompose phase produced. Use during Phase 8 of
  `/plan`, after `epic-plan-decompose-author` / `epic-plan-consolidate` write
  `temp/epic-<Epic_ID>/tickets.json` and before `epic-plan-decompose.js`
  validates and persists it. Reads the PRD / Tech Spec AND the actual cited
  code surfaces, then emits predicted-rework findings before any GitHub write.
allowed_tools:
  - Read
  - Write
  - Bash
  - Grep
---

# epic-plan-premortem

## Policy Capsule

- Run only after a draft `temp/epic-<Epic_ID>/tickets.json` exists (authored by `epic-plan-decompose-author`, and consolidated by `epic-plan-consolidate` if that pass ran); fail loudly if the draft array is missing. Read the PRD / Tech Spec from `temp/epic-<Epic_ID>/decomposer-context.json` (the same envelope the author skill consumed) — never re-fetch from GitHub, and never call the GitHub API from this Skill.
- **You MUST read the actual cited code surfaces.** For every Story, open the files named in its `changes[]` / `references[]` (resolve each path against the repo root; use `Read` / `Grep`) and read enough of each to judge whether the Story's `acceptance[]` is verifiable against the real code and whether its `changes[]` assumptions hold. This is the load-bearing difference between this critic and the structural file-assumption gate: that gate proves a path **exists** (or does not); this critic reads what the file actually **contains**. A pre-mortem that did not open the cited files has not run.
- Emit exactly one artifact: a human-readable `temp/epic-<Epic_ID>/premortem-report.md` — the predicted-rework findings the operator reviews at the Phase 8 HITL diff. It MUST exist before returning.
- **This critic never writes to GitHub and never persists `tickets.json`.** It is read-and-report only: it does NOT mutate the draft array, does NOT create issues, and does NOT flip any label. Re-authoring on its findings is the author skill's job (the workflow re-runs `epic-plan-decompose-author` on the report before the persist call).
- **You are not scope-preserving.** Unlike `epic-plan-consolidate` (merge-and-rewire only), this critic MAY recommend splitting an under-specified Story, tightening or rewording an acceptance criterion, or flagging an over-specified Story — because it only *recommends* in a report; it never applies the change itself. The conservation invariant belongs to consolidation; this pass is deliberately a separate, additive-recommendation lens.
- Hunt for the three predicted-rework finding classes the structural gates cannot catch: **(1) unverifiable acceptance criteria** (an AC no `verify[]` command or readable code state can prove); **(2) over- or under-specified Stories** (a Story whose `acceptance[]` is far broader or narrower than its `changes[]` footprint and the cited code support); **(3) semantically-wrong assumptions** (the cited file exists but does not contain the seam / export / shape the Story assumes — the file-assumption gate passes, the work would still rework).
- Log only file/route/Story identifiers and short rationale in the report — never paste full source bodies, persona data, or secret material (per `rules/security-baseline.md` data-leakage MUSTs).

## Role

Senior Engineer + Architect, acting as a **fresh-context pre-mortem critic**.
This Skill is deliberately *separate* from `epic-plan-decompose-author` (the
generator) and from `epic-plan-consolidate` (the scope-preserving merge critic):
a same-pass self-critique is the weak mode this is built to escape. The
generator maps PRD capabilities to Stories against the spec text; this critic
opens the **actual cited code** and asks "if I tried to deliver this exact
backlog, where would it rework?" — before any GitHub write makes the rework
expensive.

## When to use

`/plan` Phase 8, as the **8.5 — Planning Pre-Mortem Critic** sub-step:
after `epic-plan-decompose-author` writes (and, when present,
`epic-plan-consolidate` consolidates) `temp/epic-<Epic_ID>/tickets.json`, after
the reachability completeness critic (8.4), and **before**
`epic-plan-decompose.js --tickets …` validates and persists. The pass operates
on the temp artifact and emits a report so the operator sees predicted rework in
the Phase 8 HITL diff before the GitHub write; the author re-runs on the
findings and the deterministic validator runs *after*, so nothing this critic
surfaces reaches GitHub unreviewed.

## Inputs

The workflow passes the Epic ID as the Skill argument. The Skill itself reads:

- `temp/epic-<Epic_ID>/tickets.json` — the **draft** (or consolidated) Story
  array. This is the pre-mortem subject.
- `temp/epic-<Epic_ID>/decomposer-context.json` — the authoring envelope emitted
  by `epic-plan-decompose.js --emit-context`. Read `prd.body` / `prd` and
  `techSpec.body` / `techSpec` from it.
- **The repository working tree** — the actual files each Story's `changes[]` /
  `references[]` name. Resolve each path against the repo root and read it.

## Outputs

- `temp/epic-<Epic_ID>/premortem-report.md` — a human-readable findings report.
  Each finding names its Story, the cited surface it read, the finding class
  (unverifiable-AC / over-or-under-specified / wrong-assumption), a one-line
  rationale grounded in what the file actually contains, and a recommended
  re-authoring action. End with a one-line verdict
  (`findings: N` / `findings: 0 — no predicted rework`).

This file MUST exist before the Skill returns. The Skill writes **no** other
artifact and mutates **no** GitHub state.

## Procedure

### Step 1 — Load the draft and the spec

Read `temp/epic-<Epic_ID>/tickets.json` (the Story array) and
`temp/epic-<Epic_ID>/decomposer-context.json` (for the PRD / Tech Spec). If the
draft array is missing, fail loudly and instruct the caller to run the
`epic-plan-decompose-author` Skill first.

### Step 2 — Read the cited code surfaces

For each Story, collect the paths in its `changes[]` and `references[]`. For
each path that exists in the working tree, `Read` it (or `Grep` for the specific
export / seam the Story assumes when the file is large). Build, per Story, a
short note of what the cited code actually contains versus what the Story's
`acceptance[]` / `changes[]` assume.

### Step 3 — Hunt the three finding classes

Across the backlog, surface predicted rework:

- **Unverifiable AC** — an acceptance item nothing in `verify[]` (or readable
  code state) can prove. Recommend a concrete verify command or a reworded,
  checkable AC.
- **Over- / under-specified Story** — `acceptance[]` materially broader or
  narrower than the `changes[]` footprint and the cited code support. Recommend
  a split (under-specified one Story doing the work of several) or a tightening.
- **Semantically-wrong assumption** — the cited file exists (so the
  file-assumption gate passes) but does not contain the seam, export, function,
  or data shape the Story assumes. Recommend the corrected target or an explicit
  "create the seam first" Story.

Record each finding with its Story, cited surface, class, rationale, and
recommended action.

### Step 4 — Write the report

Write all findings to `temp/epic-<Epic_ID>/premortem-report.md` with the verdict
line. Paste identifiers and short rationale only — never full source bodies.

### Step 5 — Hand back to `/plan`

Return control. The workflow shows the operator the pre-mortem report at the
Phase 8 HITL diff; on operator approval it re-runs
`epic-plan-decompose-author` on the findings **before** the persist call
(`node .agents/scripts/epic-plan-decompose.js --epic <Epic_ID> --tickets
temp/epic-<Epic_ID>/tickets.json`). This Skill itself persists nothing.

## Constraints

- Do **not** call the GitHub API from this Skill. It reads temp artifacts plus
  the working tree and writes one temp report; persistence belongs to the
  script, re-authoring belongs to `epic-plan-decompose-author`.
- Do **not** write outside `temp/epic-<Epic_ID>/`, and do **not** mutate
  `temp/epic-<Epic_ID>/tickets.json` — this critic is report-only.
- Do **not** log full source bodies, persona data, or secrets into the report
  (per `rules/security-baseline.md`). Identifiers and short rationale only.
- If `temp/epic-<Epic_ID>/tickets.json` is missing, fail loudly and instruct the
  caller to run the `epic-plan-decompose-author` Skill first.
- The validator
  ([`lib/orchestration/ticket-validator.js`](../../../scripts/lib/orchestration/ticket-validator.js))
  remains the authoritative post-re-author gate. This critic surfaces
  *semantic* rework the structural validator cannot — it does not replace it.
