# Loop units (`.agents/workflows/loops/`)

A **loop unit** is a markdown file that defines one unit of *recurring* work
with a checkable definition of done. Each file's leading YAML frontmatter
carries a `loop:` block — a cadence, a goal, an optional `verify` oracle, a
round cap, and an exhaustion policy — validated against
[`.agents/schemas/loop-unit.schema.json`](../../schemas/loop-unit.schema.json)
by `node .agents/scripts/check-loop-units.js` (wired into `npm run lint`).

This directory is the **one** namespaced exception to the flat slash-command
projection. Files here project to `.claude/commands/loops/<name>.md` and are
invoked as the namespaced `/loops:<name>` command (flat fallback
`/loops-<name>` on hosts that flatten subdirectory commands). Every other
top-level workflow projects flat as `/<name>`; `helpers/` is not projected at
all.

## What a loop unit is — and is not

A loop unit ships **content and contract**, not a runner. It declares:

- **the action** — what one round does;
- **the goal** — the standing objective each round works toward;
- **the `verify` oracle** — the runnable check that proves a round is complete
  (required for `self-paced` cadence, optional for `interval` / `cron`); and
- **the observability / escalation contract** — the `maxRounds` backstop, the
  `onExhaust` policy, and the explicit "stop & escalate" conditions in the body.

It does **not** ship the loop driver. **Cadence and iteration are owned by the
host** — Claude Code's built-in `/loop` (self-paced or interval) and
`/schedule` (cron). Mandrel deliberately ships **no** `/goal` or `/loop`
runner of its own. The full rationale, and why this division exists, is fixed
in the ADR:

> [`docs/decisions/loop-units-division-of-labor.md`](../../../docs/decisions/loop-units-division-of-labor.md)
> — *Loop units: mandrel owns content + oracle + contract; the host owns
> cadence + iteration; no runner shipped.*

Read that ADR before adding a runner, a scheduler, or a `/goal` command to the
framework — the decision to **not** build one is deliberate.

## Cadence → host mapping

| Cadence       | `verify` | Driven by                         | Starter unit                                                   |
| ------------- | -------- | --------------------------------- | -------------------------------------------------------------- |
| `self-paced`  | required | `/loop` (no interval)             | [`fix-failing-tests.md`](fix-failing-tests.md) — red → green   |
| `interval`    | optional | `/loop <interval>` (e.g. `/loop 5m`) | [`watch-ci.md`](watch-ci.md) — poll a PR's checks          |
| `cron`        | optional | `/schedule` (cron-driven)         | [`nightly-audit.md`](nightly-audit.md) — nightly audit sweep   |

A `self-paced` unit **must** carry a `verify` oracle because nothing external
paces it — the oracle is the only signal that tells the host when to stop.
`interval` and `cron` units are paced by an external scheduler, so a
terminating oracle is optional; they observe, report, and yield each tick.

## Authoring a new loop unit

1. Create `.agents/workflows/loops/<name>.md` with a `loop:` frontmatter block
   (`cadence` + `goal` required; add `verify` for `self-paced`).
2. Give it a `description:` so it shows up in the generated catalog
   ([`.agents/docs/workflows.md`](../../docs/workflows.md), **Loops namespace**).
3. Body sections: **Action** (what one round does), **Goal & done-signal** (the
   objective and the oracle/stop check), **Stop & escalate** (when to hand back
   rather than loop).
4. Run `node .agents/scripts/check-loop-units.js` (or `npm run lint`) to
   validate the frontmatter, then `npm run sync:commands` to project it to
   `/loops:<name>` and `npm run docs:gen` to refresh the catalog.
