# Claude Code mods (beta)

> **Beta, optional, read-only.** Mandrel works the same with or without a
> mod. Nothing in Mandrel loads, references or depends on one, and no
> `.agentrc.json` key turns one on. The decision record is
> [ADR `20261002-5544`](https://github.com/dsj1984/mandrel/blob/main/docs/decisions.md#adr-20261002-5544-claude-code-mods-are-a-beta-optional-read-only-add-on).

A Claude Code mod is a plugin of function hooks: a module that draws on
Claude Code's own surfaces (a band above the prompt, a pane, a toast) and
reacts to session events. Mandrel ships its mods under `.agents/mods/`, so
`mandrel sync` copies them into every consumer checkout. A mod stays inert
until a developer loads it. This runbook is listed at the end of every
`mandrel sync`, `init` and `update`, like every file in `docs/runbooks/`.

## `mandrel-status`

[`mods/mandrel-status/`](../../mods/mandrel-status/) draws a short band
above the prompt while you work in a Mandrel checkout. It follows one
Story: the newest one in flight (a `.worktrees/story-<id>/` with no newer
terminal envelope), otherwise the newest
`story-deliver-terminal-<id>.json` on disk. A `landed` result shows for 10
minutes; any other result shows for 2 hours. With neither, or with no
`.agents/` in the checkout, it draws nothing.

The band is **one quiet line while the Story is healthy**. A second line
appears only when the Story needs a look, and it never repeats line 1:

```text
● #5552 mandrel-status band v2   ▰▰▰▰▰▱ close · gate lint   1:10 / ~1:30
▲ #5552 mandrel-status band v2   ▰▰▰▰▰▱ close · code-review   6:12 / ~2:00
↳ 3.1× usual · gate log quiet 4m · last gate test
◆ #5552 mandrel-status band v2   needs you at check · acceptance-unmet
↳ /mandrel-deliver 5552 --resume   AC-3, AC-5                     [Copy]
```

**Attention.** One value picks the glyph, the color and whether line 2
shows:

| Attention | When | Glyph | Color | Line 2 |
| --- | --- | --- | --- | --- |
| working | in flight, on pace | `●` | dim | none |
| slow | in flight and past its usual time | `▲` | yellow | the ratio to usual, how long the close-gates log has been quiet, the last gate |
| needs you | a `blocked` result: the HITL pause | `◆` | magenta | `↳ <nextCommand>`, plus the unmet acceptance ids when it stopped at check; a `Copy` button copies the command |
| failed | a `failed` or `escalated` result, or a PR whose checks are red | `✗` | red | `↳ <nextCommand>`, or `↳ PR #<n> checks failing` with an `Open PR` link |
| landed | a `landed` result | `✓` | green | none |

**Line 1** is the glyph, `#<id>`, the title cut to 30 columns, then:

- **in flight:** a six-cell meter (`▰` per finished or current stage, `▱`
  per stage to come), the current step, and the time in the current phase
  against its usual time (`2:00 / ~1:30`; `/ ~<usual>` is left out until
  there are 3 samples). A pending result shows `pending` in place of the
  time.
- **stopped:** `needs you at <stage> · <blockClass>` or
  `failed at <stage> · <failure.reason>`.
- **landed:** `landed in <elapsed> · PR #<n> · <k> follow-ups`, where `k`
  counts the bullets in `follow-ups-rollup-<id>.md`.

Times read `m:ss`, or `h:mm:ss` past an hour.

**Stages and steps.** Each stage comes from a file delivery already writes,
and the latest evidence wins. The step names the stage, plus what it is
doing when that is known:

| Stage | Evidence | Step shown |
| --- | --- | --- |
| `start` | `<tempRoot>/orchestration/story-init-result-<id>.log` | `start`; the Story title on line 1 comes from this log |
| `build` | `commit…` lines in the worktree's reflog (`logs/HEAD` under its gitdir) | `build · <n> commits` |
| `check` | the highest `<tempRoot>/scratch/story-<id>/acceptance-verdict-round-<n>.json` | `check · round <n> · <met>/<total> met` |
| `handoff` | the newest `story-handoff-<id>-<step>.log`; `story-handoff-<id>.json` ends the stage | `handoff · <step>` |
| `close` | `close-gates-<id>.log` | `close · gate <name>` from its last line's `[name]` prefix, or the close phase |
| `merge` | a terminal envelope with `status` `pending`, or a progress file in `auto-merge` / `confirm-merge` | `merge · PR #<n> · <phase>` |

A commit made after the last verdict round puts the Story back in `build`.
When `story-progress-<id>.json` is present and newer than everything else,
it decides the stage, the step or close phase and the PR number. The band
never needs it: without it, every stage still shows, and only the close
sub-phase after validation is unknown.

**Usual times.** Close and merge phases use the median of `phaseDurations`
over the newest 30 terminal envelopes on disk, recomputed at most every 10
minutes. Start, build, check and handoff have no recorded durations once
temp is purged, so the band learns them itself. Each time the Story it
follows moves past one of those stages, it keeps how long the stage took
(the newest 30 per stage, in the mod's own state). Each median counts once
it has 3 samples, so these usual times start empty on a new machine and
fill in as you deliver. A phase or stage is **slow** when its elapsed time
passes the larger of twice the median and 2 minutes. With fewer samples, a
close whose gate log has been quiet for 10 minutes is slow instead.
Elapsed time runs from the progress file's `phaseStartedAt` when it is
there, else from when the stage's evidence began.

**Run chips.** When a `<tempRoot>/run-<id>/ledger.json` was updated in the
last 2 hours, line 1 ends with `run <landed>/<total>` and one chip per
ledger Story, in ledger order: `✓` landed, `◆` needs you, `✗` failed, `●`
the Story the band follows, `◐` another dispatched Story, `○` not
dispatched yet. The followed Story is always its own chip, so the band
never names two Stories without showing how they relate.

**Run roll-up.** Once every ledger Story has a result, the band shows one
line for the run instead:
`◆ run 2/3 landed in 35:00 · #5545 needs you at confirm-merge   ✓5543 ✓5544 ◆5545`.
It leads with the first Story that did not land and takes that Story's
color. A run that landed whole shows in green for 10 minutes; a run with a
Story that did not land stays while its ledger is live.

**Width.** Under 80 body columns, line 1 drops the title and the run chips.
An attention state keeps its second line. Long text is cut short with
`…`, never wrapped.

**Buttons.** `Hide` hides the band for this Story and attention state.
The band comes back when either changes, so hiding a healthy band never
hides a later slow, needs-you or failed state. `Details` opens the
`mandrel-status` pane:

- a header with the Story, its attention and its total time;
- a `NEEDS ATTENTION` block when the Story is slow, needs you or failed,
  with the slow phase's time, usual time and ratio, or the problem, the
  unmet acceptance ids and the next command;
- a `TIMELINE`, one row per stage with its start time, its duration and a
  bar, plus the close phases indented under close. Every bar shares one
  scale, and `▏` marks the usual time;
- the run chips, when a run is live.

**Toasts.** The band toasts once for each result (`landed`, `blocked`,
`failed`, `escalated`) and once the first time a Story turns slow. Results
already on disk when the session starts are not toasted, and a hot reload
does not repeat one.

**Where it reads.** Every path is relative to the main checkout. A session
running in a linked worktree (for example `.claude/worktrees/<name>`, which
holds no `temp/` or `.worktrees/`) has a `.git` file reading
`gitdir: <main>/.git/worktrees/<name>`, and the band reads from that
`<main>`. `tempRoot` is `project.paths.tempRoot` from
`.agentrc.local.json`, then `.agentrc.json`, and defaults to `temp`. The
`Open PR` link uses the envelope's `pr.url`, else
`https://github.com/<github.owner>/<github.repo>/pull/<n>` from the same
config. The band refreshes on session start, after each turn and every 15
seconds.

### Turn it on

Per developer, per machine. Pick one:

- **Every session:** add the folder's absolute path to
  `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`
  (separate several paths with the platform's path-list separator):

  ```json
  {
    "env": {
      "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/project/.agents/mods/mandrel-status"
    }
  }
  ```

  Claude Code reads this variable from the process environment or from user
  settings, never from a project's `.claude/settings.json`. A committed file
  cannot switch the mod on for anyone else. In a directory with no `.agents/`
  folder the mod draws nothing, so a user-wide entry is harmless elsewhere.

- **One session:** `claude --plugin-dir .agents/mods/mandrel-status`.

Turn it off by removing the entry or the flag.

### The read-only invariant

A Mandrel mod may only read files (`$.fs.read`, `list`, `stat`, `exists`),
draw and open its own pane (`$.ui.*`), keep session state (`$.state`) and keep time (`$.clock`).
It hooks only `session.start`, `turn.complete` and `ui.render` (the
`AbovePrompt` band and its own `Pane`), and its buttons only change
`$.state` or call `$.ui.open`. It hooks no `tool.call`, `prompt.submit`,
`command.run` or `session.append` event. It never writes files, spawns processes, calls the network or the
model. Guardrails stay in `.claude/settings.json` command hooks, which load
in environments where plugins do not. `claude plugin validate` lists every
hook and `$` call a mod makes. Check that list against this invariant when
you change one.

### Develop and test

```bash
claude plugin validate .agents/mods/mandrel-status
```

```bash
claude plugin test .agents/mods/mandrel-status
```

The tests live in `__tests__/*.test.ts`. They answer the mod's file reads
from an in-memory checkout and drive the clock by hand. `npm test` does not
run them, since its tiers collect `*.test.js` only, and CI has no `claude`
binary. Run both commands locally before you push a change to a mod. The
npm package excludes `__tests__/`.

## Removing mods

Delete `.agents/mods/`, this runbook, and its two rows in `.agents/README.md`. Then
mark the ADR Superseded. No other file references a mod, so no other gate
changes. Consumers lose the folder on their next `mandrel sync`, which
prunes files that are no longer in the payload. Anyone who set
`CLAUDE_CODE_PLUGIN_DIRS` should remove that entry.
