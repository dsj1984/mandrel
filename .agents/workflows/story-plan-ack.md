---
description: >-
  Apply the plan::acknowledged label to a Story and resume its gated
  story-deliver worker. Use after reviewing the story-plan structured comment
  posted by the worker before its first commit.
---

# /story-plan-ack \<storyId\>

## Overview

When `delivery.storyPlan.requireAcknowledgement` is `true` in `.agentrc.json`,
the standalone Story worker (`helpers/single-story-deliver`) emits a
`story-plan` structured comment after calculating its implementation plan, then
**pauses** — it polls for the `plan::acknowledged` label before making its
first commit. This prevents unreviewed agentic changes from landing when the
operator wants a manual checkpoint between plan and execution.

`/story-plan-ack` is the operator-facing command that closes the gate:

1. Read the `story-plan` comment on the Story to confirm the plan is
   reasonable.
2. Run `/story-plan-ack <storyId>` — the command applies `plan::acknowledged`
   and the worker resumes on its next poll cycle.

> **When gating is off.** If `requireAcknowledgement` is `false` (the
> default), the worker proceeds to implementation without waiting. Applying
> `plan::acknowledged` manually in that case is a no-op — the label is not
> checked during an ungated run.

---

## Arguments

```text
/story-plan-ack <storyId>
```

- `storyId` — GitHub issue number carrying `type::story` and `agent::executing`.

---

## Steps

### Step 1 — Verify preconditions

Confirm the Story:

1. Exists and carries `type::story`.
2. Carries `agent::executing` (the worker is running).
3. Does **not** already carry `plan::acknowledged` (idempotency guard).

If the Story already carries `plan::acknowledged`, print a notice and exit 0 —
the label is already set and the worker will pick it up on its next poll.

### Step 2 — Apply the label

```bash
node .agents/scripts/update-ticket-state.js \
  --ticket <storyId> \
  --add-label plan::acknowledged
```

Confirm the label appears on the issue before proceeding. If the command
fails, report the error and exit non-zero — do not declare success on a
failed label write.

### Step 3 — Confirm to the operator

Print a confirmation:

```text
✅ plan::acknowledged applied to Story #<storyId>.
   The gated worker will resume on its next poll (up to ackPollIntervalMs ms).
```

---

## What happens next

The story-deliver worker is polling for `plan::acknowledged` up to
`delivery.storyPlan.ackTimeoutMs` (default 30 min). On the next poll it
detects the label and proceeds to its first commit on `story-<storyId>`.

If the timeout expired before you ran this command, the Story is already at
`agent::blocked`. In that case:

1. Apply the label manually via `gh issue edit <storyId> --add-label
   "plan::acknowledged"`.
2. Re-dispatch the worker via `update-ticket-state.js --ticket <storyId>
   --state agent::executing` and re-run the delivery command for the Story.

---

## Constraints

- **Never** apply `plan::acknowledged` to a Story that is `agent::done` or
  `agent::blocked` without first confirming the Story should be re-executed.
  The label is a resumption signal — applying it to an already-closed Story is
  a no-op, but applying it mid-block without intent to re-dispatch is
  confusing.
- **Always** read the `story-plan` comment before acknowledging. The purpose
  of the gate is human review of the plan, not rubber-stamping.
- The label constant is exported from
  `.agents/scripts/lib/label-constants.js` as `PLAN_LABELS.ACKNOWLEDGED` /
  `PLAN_ACKNOWLEDGED`. Scripts MUST reference it by symbol, never as the
  string `'plan::acknowledged'` directly.

---

## See also

- [`helpers/single-story-deliver`](helpers/single-story-deliver.md) — the
  worker that emits the plan and polls for this label.
- [`/story-deliver`](story-deliver.md) — the operator-facing command that
  fans out standalone Story delivery.
- `delivery.storyPlan` configuration keys in `docs/configuration.md`.
