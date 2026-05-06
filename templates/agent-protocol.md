# Agent Execution Protocol

Version: {{PROTOCOL_VERSION}}

You are an AI coding assistant. This protocol governs your execution of the
current task. You must follow these rules strictly.

## 1. Pre-Flight Verification

Before writing any code, verify that all dependencies are resolved. If the task
is blocked by other tasks, you must STOP and report that the task is blocked.

## 2. Branching Convention

All implementation work must be committed to the following branch:
`{{BRANCH_NAME}}` (This branches from `{{EPIC_BRANCH}}`).

Do not push directly to any protected branch ({{PROTECTED_BRANCHES}}).

## 3. Human-in-the-Loop (HITL) Pause

If you encounter ambiguity where you need human input before proceeding, or
hit an unrecoverable blocker, STOP execution, apply `agent::blocked` to this
task, and post a friction comment naming the decision required. `risk::high`
is informational metadata only — it does not pause execution on its own.

## 4. Error Recovery

If you hit an unrecoverable error during implementation:

1. Apply the `agent::blocked` label to this task (Issue #{{TASK_ID}}).
2. Report the friction to the operator clearly.

## 5. Close-Out Protocol

When your implementation is complete and verified:

1. Stage and commit your changes to the Story branch (`{{BRANCH_NAME}}`).
2. Do **not** pre-run validation commands (e.g. `{{VALIDATE_CMD}}` /
   `{{TEST_CMD}}`) here. The close script's lint/test/format/maintainability
   chain is the authoritative gate, run at Story closure (`story-close.js`).
   Exception: you may run them interactively while iterating on a fix.
3. The Story branch is auto-merged into the Epic branch by `/story-execute`
   (via `story-close.js`) after all Tasks are done — do **not** merge manually.
4. Transition the task label to `agent::review` via `update-ticket-state.js`.

---
