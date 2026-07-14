# Agent Execution Protocol

Version: {{PROTOCOL_VERSION}}

You are an AI coding assistant. This protocol governs your execution of the
current work unit. You must follow these rules strictly.

> **Hierarchy shape.** Mandrel uses a **Story-only** model. The work unit
> is the `type::story` issue itself, with acceptance criteria and
> verification inlined on the Story body and the folded Tech Spec in
> `## Spec`. There is no per-Task sub-loop; the agent authors commit
> subjects directly per `.agents/rules/git-conventions.md` and
> references the Story via `(refs #<storyId>)`. Branch naming
> (`{{BRANCH_NAME}}` from `{{EPIC_BRANCH}}` / base), the PR target
> (`main`), and the close protocol are as documented below.

## 1. Pre-Flight Verification

Before writing any code, verify that all dependencies are resolved. If the
Story is blocked by other Stories, you must STOP and report that the Story is
blocked.

## 2. Branching Convention

All implementation work must be committed to the following branch:
`{{BRANCH_NAME}}` (This branches from `{{EPIC_BRANCH}}`).

Do not push directly to any protected branch ({{PROTECTED_BRANCHES}}).

## 3. Human-in-the-Loop (HITL) Pause

If you encounter ambiguity where you need human input before proceeding, or
hit an unrecoverable blocker, STOP execution, apply `agent::blocked` to this
Story, and post a friction comment naming the decision required. `risk::high`
is informational metadata only — it does not pause execution on its own.

## 4. Error Recovery

If you hit an unrecoverable error during implementation:

1. Apply the `agent::blocked` label to this Story (Issue #{{TASK_ID}}).
2. Report the friction to the operator clearly.

## 5. Close-Out Protocol

When your implementation is complete and verified:

1. Stage and commit your changes to the Story branch (`{{BRANCH_NAME}}`).
2. Do **not** pre-run validation commands (e.g. `{{VALIDATE_CMD}}` /
   `{{TEST_CMD}}`) here. The close script's lint/test/format/maintainability
   chain is the authoritative gate, run at Story closure (`story-close.js`).
   Exception: you may run them interactively while iterating on a fix.
3. The Story branch is opened as a PR to `main` by `helpers/deliver-story`
   (via `single-story-close.js`) — do **not** merge manually.

## 6. Definition of Done

### Code Quality

Every Story that touches production source must satisfy the numeric
guardrails in
[`helpers/code-quality-guardrails.md`](../workflows/helpers/code-quality-guardrails.md):
cyclomatic complexity ceilings (flag > 8, must-fix > 12), the same-commit
sibling-test convention, the per-file Maintainability-Index drop ceiling
(refactor when > 1.5pt), and the rename = baseline-refresh rule. Verify
at-keyboard with `npm run quality:preview` (the same diff-scoped MI + CRAP
preview the `.husky/pre-commit` hook runs) **before** committing. The
thresholds are tunable via `agentSettings.quality.codingGuardrails` in
`.agentrc.json` — never fork the helper to change a number.

---
