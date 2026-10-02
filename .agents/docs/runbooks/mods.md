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
`story-deliver-terminal-<id>.json` from the last 2 hours. With neither, or
with no `.agents/` in the checkout, it draws nothing.

**Line 1** is an outcome glyph (none, `✓` or `✗`), then
`mandrel · #<id> <title>`, with the PR and its checks on the right when
they are known. **Line 2** is the stage strip, the current step and the
time:

```text
mandrel · #5552 mandrel-status band v2 · PR #5560 checks pending
✓ start ─ ✓ build ─ ✓ check ─ ✓ handoff ─ ● close ─ ○ merge · gate lint · 1m10s of usual ~1m30s
```

`✓` marks a finished stage, `●` the current one and `○` the ones to come.
Each stage comes from a file delivery already writes, and the latest
evidence wins:

| Stage | Evidence | Detail shown |
| --- | --- | --- |
| `start` | `<tempRoot>/orchestration/story-init-result-<id>.log` | `initialized`; the Story title on line 1 comes from this log |
| `build` | `commit…` lines in the worktree's reflog (`logs/HEAD` under its gitdir) | commit count and the last subject |
| `check` | the highest `<tempRoot>/scratch/story-<id>/acceptance-verdict-round-<n>.json` | `round <n> · <met>/<total> met` |
| `handoff` | the newest `story-handoff-<id>-<step>.log`; `story-handoff-<id>.json` ends the stage | the step name, or `handed off` |
| `close` | `close-gates-<id>.log` | the gate named by its last line's `[name]` prefix |
| `merge` | a terminal envelope with `status` `pending`, or a progress file in `auto-merge` / `confirm-merge` | the PR number and the phase |

A commit made after the last verdict round puts the Story back in `build`.
When `story-progress-<id>.json` is present and newer than everything else,
it decides the stage, the step or close phase and the PR number. The band
never needs it: without it, every stage still shows, and only the close
sub-phase after validation is unknown.

**Learned ETAs.** For each close phase, the band takes the median of
`phaseDurations` over the newest 30 terminal envelopes on disk, and
recomputes it at most every 10 minutes. Once a phase has 3 or more samples,
line 2 reads `<elapsed> of usual ~<median>`. The phase counts as stalled when
its elapsed time passes the larger of twice the median and 2 minutes. With
fewer samples, a close whose gate log has been quiet for 10 minutes is
stalled instead (`stalled? no gate output for <n>m`). Elapsed time runs from
the progress file's `phaseStartedAt` when it is there, else from when the
stage's evidence began.

**Results.** A `landed` envelope collapses the band to one line:
`✓ mandrel · #<id> <title> · landed in <elapsed> · PR #<n> · <k> follow-ups`,
where `k` counts the bullets in `follow-ups-rollup-<id>.md`. A `blocked`,
`failed` or `escalated` envelope puts its `blocked.blockClass` or
`failure.reason` on line 1 and replaces line 2 with `next: <nextCommand>`,
the command that resumes the work.

**Run line.** When a `<tempRoot>/run-<id>/ledger.json` was updated in the
last 2 hours and still has a Story without a `landed` envelope, a third line
reads `run <landed>/<total> landed · #<id> <stage> · <queued> queued`.

**Colors.** Dim by default, yellow when stalled, red for `blocked` /
`failed` / `escalated`, green for `landed`.

**Width.** Under 80 body columns only line 1 shows. Long text is cut short
with `…`, never wrapped.

**Buttons.** `Hide` hides the band for this session until the followed
Story changes. `Details` opens the `mandrel-status` pane, which lists each
stage with its start time and duration, the handoff steps, and the close
phases with their recorded and usual durations.

It also toasts once when a terminal envelope appears with `status` `landed`
or `blocked`. Results already on disk when the session starts are not
toasted, and a hot reload does not repeat one.

**Where it reads.** Every path is relative to the main checkout. A session
running in a linked worktree (for example `.claude/worktrees/<name>`, which
holds no `temp/` or `.worktrees/`) has a `.git` file reading
`gitdir: <main>/.git/worktrees/<name>`, and the band reads from that
`<main>`. `tempRoot` is `project.paths.tempRoot` from
`.agentrc.local.json`, then `.agentrc.json`, and defaults to `temp`. The
band refreshes on session start, after each turn and every 15 seconds.

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
