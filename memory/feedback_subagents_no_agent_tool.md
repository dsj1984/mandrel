---
name: Sub-agents in this Claude Code lack the Agent tool
description: General-purpose sub-agents cannot spawn further sub-agents — Agent/Task is excluded from the (Tools: *) wildcard. Breaks any nested-fanout design.
type: feedback
originSessionId: 522441b7-f4c9-4d3c-b00c-6419958a754c
---

# Sub-agents in this Claude Code lack the Agent tool

General-purpose sub-agents in the operator's current Claude Code release do **not** have the `Agent` (a.k.a. `Task`) tool. Verified 2026-05-07 by direct probe: a fresh general-purpose sub-agent's tool registry is `Bash, Edit, Glob, Grep, Read, ScheduleWakeup, Skill, ToolSearch, Write` plus deferred background helpers (`TaskStop`, `Monitor`, MCP servers, web). Neither `Agent` nor `Task` appears anywhere — the platform appears to disallow nested sub-agent dispatch globally, regardless of the "(Tools: *)" agent-type description.

**Why:** The 2026-05-07 wave-0 run of Epic #1072 surfaced this. `/epic-execute` correctly spawned `/wave-execute` as a sub-agent; the wave-runner then could not fan out to per-Story Agent calls and recorded all 11 stories as `failed`. The regression-guard prompt (2026-05-07 disambiguation in `wave-execute.md`) correctly stopped it from collapsing to a single direct `/story-execute` call, so the wave-runner exited with `failed` rather than silently degrading.

**How to apply:** Treat any design that says "sub-agent X spawns sub-agents Y" as broken on this harness. The host (top-level Claude Code session) is the only layer with `Agent`. For multi-level fan-out, flatten dispatch to the host — e.g. `/epic-execute` itself emits per-wave Agent calls to `/story-execute` and treats `/wave-execute` as a procedure (manifest read + record), not as a dispatching sub-agent. Verify any contradicting design assumption (`wave-execute.md` line ~126: "Children inherit the parent's tool permissions") against this constraint before relying on it. If you ever need nested Agent dispatch to work, **probe first** with a minimal sub-agent that calls `Agent` once — don't trust spec text alone.
