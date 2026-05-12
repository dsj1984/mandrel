# Loop contract comparison — homegrown vs built-in `/loop`

**Story:** [#1557](../../../) — Rebase homegrown loop on built-in `/loop` (or document divergence)
**Epic:** #1471 (v6.0.0 Epic G — Claude Code-first adoption)
**Tech Spec:** #1545 (Phase 2, Story 5)
**Snapshot date:** 2026-05-12
**Claude Code build under test:** Opus 4.7 (1M context); built-in `/loop` skill present per host skill manifest.

---

## 1. Discovery — does a homegrown `loop` skill exist?

The Tech Spec (#1545) flagged the `loop` skill location as **TBD by this Story's investigation**. The acceptance criterion is: if contracts match, thin or delete the homegrown skill; if they diverge, document the divergence.

A repository-wide audit was performed:

| Location searched                                                              | Result                                                         |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `.claude/commands/` (project slash commands)                                   | No `loop.md`. 32 commands, none match `/loop`.                 |
| `.claude/skills/`                                                              | Directory does not exist (project-level).                      |
| `.agents/skills/core/` and `.agents/skills/stack/`                             | No `loop` skill (47 SKILL.md files audited).                   |
| `~/.claude/skills/`, `~/.claude/plugins/`                                      | Not present on this host.                                      |
| Grep `^name:\s*loop` across all `**/*.md`                                      | Zero matches.                                                  |
| Grep `loop` (case-insensitive, recursive) in `.agents/`                        | 59 hits, all incidental (`while`-loops, "wave loop", `poll-loop.js` helper, ADR prose). No skill / command shape. |
| `git log --all --diff-filter=D -- "**/*loop*"`                                 | Three deleted artifacts only: `scripts/run-agent-loop.js`, `tests/run-agent-loop.test.js`, `tests/e2e/run-agent-loop-e2e.test.js`, all retired in `0d6ef1b8` (v5.0.0 architecture finalisation) and `e6a11089`. None of these were a Claude Code skill — they were an internal Node CLI for the legacy agent runner. |
| Host skill manifest (system-reminder)                                          | Lists `loop:` as a single-source skill: *"Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo). Omit the interval to let the model self-pace."* This is the **built-in** entry. |

**Conclusion of discovery:** there is **no homegrown `/loop` skill, command, or script** competing with the built-in. The historic `run-agent-loop.js` was a different concept (the framework's pre-v5 wave runner) and was deleted long before this Epic. The only "loop" in the workflow surface today is the built-in `/loop`.

This collapses the Story's three live verdicts (`rebase`, `thin-to-reference`, `delete`) into a single applicable outcome: there is nothing to rebase, thin, or delete. The remaining option, **`document-divergence`**, is therefore the active verdict — but the divergence being documented is the *absence* of a homegrown surface, which is itself the desirable end state.

---

## 2. Contract surfaces of the built-in `/loop`

For completeness — and so a future contributor reaching for "the homegrown loop" has the contract to compare against — the built-in `/loop` skill exposes the following contract surface:

| Surface              | Built-in `/loop`                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Entry point**      | Slash command: `/loop [<interval>] <prompt-or-slash-command>`                                                 |
| **Argument shape**   | Optional interval (e.g. `5m`, `30s`, `1h`) followed by the body to repeat. Omitting the interval lets the model self-pace between iterations. |
| **Body type**        | Either a freeform prompt or another slash command (e.g. `/loop 5m /babysit-prs`).                             |
| **Scheduling model** | Foreground recurrence inside the active session. Each tick re-prompts the model with the supplied body.       |
| **Concurrency**      | Single-instance per session — there is no parallel fan-out.                                                   |
| **Exit conditions**  | Operator interrupt (Ctrl+C / session end), or the model deciding to stop when self-paced.                     |
| **State / artifacts**| None persisted by the skill; any state lives in whatever the looped command itself writes.                    |
| **Permissions**      | Inherits the active session's tool permissions; does not request new ones per tick.                           |
| **Cross-session**    | Does **not** survive session restart. For cron-style durability, the host exposes a separate `schedule:` skill (see system-reminder; out of scope for this comparison). |
| **Failure semantics**| A failing tick does not abort the loop — the next tick still fires.                                           |

For comparison purposes, the **homegrown side** of every row is N/A: there is no homegrown `/loop` to compare. The framework does have *internal* loops (e.g. `lib/util/poll-loop.js`, the wave-runner tick in `lib/orchestration/epic-runner/phases/iterate-waves.js`) but these are programmatic library helpers, not user-facing skills, and they are out of scope for an "operator-facing loop skill" comparison.

---

## 3. Surface-by-surface verdict

| Contract surface     | Match?                | Action                                                                                  |
| -------------------- | --------------------- | --------------------------------------------------------------------------------------- |
| Entry point          | N/A — no homegrown    | Adopt built-in as-is.                                                                   |
| Argument shape       | N/A                   | Adopt built-in as-is.                                                                   |
| Body type            | N/A                   | Adopt built-in as-is.                                                                   |
| Scheduling model     | N/A                   | Adopt built-in as-is. For durable cron-like jobs, use the separate `schedule:` skill.   |
| Concurrency          | N/A                   | Single-instance is acceptable for the framework's cadence-poll use cases.               |
| Exit conditions      | N/A                   | Operator-interrupt + model self-pace are sufficient.                                    |
| State / artifacts    | N/A                   | The framework's recurring tasks (cadence polls, dashboard regen) already own their own artifacts via the underlying scripts; `/loop` adds nothing to manage. |
| Permissions          | N/A                   | Session inheritance matches the framework's existing permission model.                  |
| Cross-session        | N/A                   | Out of scope — `schedule:` covers this if needed in a follow-on Epic.                   |
| Failure semantics    | N/A                   | The looped command (e.g. `/babysit-prs`) is responsible for its own retry / backoff.    |

---

## 4. Verdict

**`document-divergence` — but the "divergence" is intentional and trivial: the project has no homegrown `loop` skill to reconcile. The built-in `/loop` is adopted as the sole surface.**

Rationale:

1. The discovery audit found zero homegrown `/loop` artifacts in `.claude/commands/`, `.agents/skills/`, or any historical location that matches the *skill / slash-command* shape.
2. The deleted `run-agent-loop.js` was a different concept (legacy wave runner) and is not a candidate for "thinning to reference" — it was already deleted in v5.0.0 and superseded by the current `iterate-waves.js` phase logic.
3. Therefore there is no surface to **rebase** (nothing to point at the built-in), nothing to **thin** (no skill body to shrink), and nothing to **delete** (no committed file to remove).
4. The remaining outcome — **document the divergence** — is satisfied by this comparison file plus the follow-on ADR entry the t-implement-loop-decision Task (#1574) will land in `docs/decisions.md` recording the "no homegrown surface; adopt built-in" stance.

This verdict feeds directly into Story #1574's implementation: it will append a short ADR entry to `docs/decisions.md` capturing the audit result, link this comparison file as the supporting evidence, and add the `loop` row to the upcoming `docs/claude-code-catalog.md` (Story 8) with the classification **`adopt`**.
