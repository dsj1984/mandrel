---
description: >-
  Reference sibling for helpers/qa-run-scenario.md — the spec-only, not-yet-
  enabled batched sub-agent dispatch mode. Read only when turning that mode on.
caller: qa-run-scenario.md
---

# helpers/qa-run-scenario — reference: batched sub-agent dispatch (spec-only)

> **Not yet enabled.** This section specifies a future execution mode; the
> current `/qa-run` sweep calls [`qa-run-scenario`](qa-run-scenario.md)
> **inline**, one scenario at a time, in the orchestrator's own turn. The
> batched mode below is documented so the contract is stable when it is turned
> on — do not implement it as live behavior from this spec alone.

In the deferred mode, the orchestrator MAY dispatch scenarios to fresh-context
sub-agents to keep its own context window focused, under these hard rules:

- **Sequential, never parallel.** Sub-agents run **one at a time**, never
  concurrently. A live browser surface is a single shared resource; parallel
  drivers would race on navigation and cross-contaminate evidence. (This
  sequential-only rule is live today and stated in
  [`qa-run-scenario.md`](qa-run-scenario.md) — it is not deferred.)
- **One sub-agent per persona group.** Scenarios are grouped by persona and a
  single sub-agent drives all of one persona's scenarios, so the persona is
  signed in once per group rather than per scenario.
- **Re-verify auth on entry.** Each sub-agent MUST re-verify the
  authenticated-session precondition (a `take_snapshot` confirming the persona
  badge) when it starts, because it does not share the orchestrator's live
  session state.
- **Same input/output contract.** Each sub-agent consumes the input contract
  and returns the per-scenario result shape from
  [`qa-run-scenario.md`](qa-run-scenario.md) for every scenario it drove — the
  orchestrator aggregates identically whether the helper ran inline or via a
  batched sub-agent.
