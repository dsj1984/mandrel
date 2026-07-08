# Parallel Tooling — Inline Helper

Procedural module read **inline** by workflows that perform context-gathering,
long-running shell work, or independent unit fan-out. This is **not** a slash
command — it is not projected into the flat `.claude/commands/` tree, so there
is no `/parallel-tooling`. Callers reference this file at the top of their first
scan / read instruction so the parallelism conventions land before the work
does.

The three rules below are the canonical dispatch shape for this codebase.
Apply them in order: a workflow that observes Rule 1 but ignores Rule 3
serialises its fan-out unnecessarily; a workflow that reaches for Rule 3
before exhausting Rule 1 spawns sub-agents to do work the host could have
batched in a single turn.

## Rule 1 — Batch independent reads in a single turn

When the next N tool calls do **not** depend on each other's results, issue
them in one assistant turn rather than serially. The host runtime executes
the batch in parallel; serial calls cost N round-trips for no gain.

- **Tool primitives:** `Read`, `Grep`, `Glob`, MCP `list_*` / `get_*` calls.
- **When:** reading the Epic body (with its folded Tech Spec sections)
  and Story body up front; grepping
  for multiple unrelated patterns; globbing several directory trees;
  fetching independent GitHub tickets.
- **Anti-pattern:** sequential `Read` → wait → `Read` → wait → `Grep` chains
  when none of the later calls reference earlier output.
- **Bounded fan-out:** keep the batch ≤ 10 calls per turn. Larger batches
  blow the context budget and obscure the failure surface if one call errors.

## Rule 2 — `run_in_background` + `Monitor` for long shells

Shell commands that exceed roughly 30 seconds (test suites, installs,
multi-file lints, `git fetch --all`, container builds) **must** use the
`Bash` tool's `run_in_background: true` flag and stream events via the
`Monitor` tool. A synchronous `Bash` call holds the assistant turn open for
the full duration and blocks every other parallel opportunity.

- **Tool primitives:** `Bash(run_in_background: true)` + `Monitor`.
- **When:** `npm test`, `npm ci`, full-repo `eslint`/`biome` runs, long
  fetches, anything you would have prefixed with `nohup` in a terminal.
- **Anti-pattern:** synchronous `Bash` with a 600 000 ms timeout used as a
  blocker — that pattern is reserved for scripts whose exit is the
  signal-to-proceed (e.g., `story-init.js`'s per-tree install, which the
  parent skill calls out explicitly).
- **Don't poll with `sleep`:** `Monitor` returns on each stdout line. Loop
  on `until <condition>; do sleep 2; done` only when no event stream is
  available — never as a substitute for the event channel.

## Rule 3 — N parallel `Agent` calls in one turn for N independent units

When a workflow fans out across N independent units of work — N Stories in
a wave, N audit dimensions, N decomposition slices — dispatch all N
sub-agents in a **single assistant turn** by issuing N `Agent` tool calls
together. The host executes the calls concurrently; one turn per unit is
the same shape as Rule 1 but at the sub-agent layer.

- **Tool primitives:** `Agent` (one call per independent unit, all in one
  turn).
- **When:** wave-level Story fan-out from `/deliver`, per-dimension
  audit dispatch, any "for each X in Xs run /Y X" loop where the Xs do not
  share write paths.
- **Anti-pattern:** serial `Agent` calls (`Agent` → wait → `Agent` → wait)
  for units that have no dependency edge between them. The wave aggregator
  is designed for the parallel shape — the serial shape is strictly slower
  and offers no isolation benefit.
- **Concurrency cap:** respect `delivery.deliverRunner.concurrencyCap` (or the
  caller's wave-slot budget) — beyond that cap you starve other waves, not
  speed up your own. When N exceeds the cap, slice into batches of `cap`
  and dispatch each batch in its own turn.

## When the rules conflict

If a unit of work is both long (Rule 2) and independent (Rule 1 or 3),
prefer the higher-numbered rule — the parallelism gain compounds the
background-shell gain. Concretely: dispatch the `Agent` calls in one turn
(Rule 3), and **inside** each sub-agent let it apply Rule 2 to its own
long-running shells — and, within the supported nesting depth budget
(verified depth 2, announced max depth 5; see
[#2870](https://github.com/dsj1984/mandrel/issues/2870)), let it apply
**Rule 3** to its own independent sub-units as well, not only Rule 2
background shells. A sub-agent is a full orchestrator at its own level:
recursive `Agent` fan-out is available to it, so the host does not need to
micromanage the child's shell **or** dispatch strategy. Mind the depth
budget and the compounding cost — every nesting level re-pays the
always-loaded context (see [`instructions.md` § 4](../../instructions.md)).

## Constraints

- **Never** chain serial calls when the host can batch them — the rules
  above are about correctness of dispatch shape, not optimisation.
- **Never** use `run_in_background` for short commands (< 5 s). The
  notification overhead exceeds the wall-clock savings.
- **Always** keep dependent calls sequential — Rule 1 is "batch
  independent reads," not "batch everything."
