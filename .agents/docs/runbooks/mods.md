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

[`mods/mandrel-status/`](../../mods/mandrel-status/) draws **one line above
the prompt only when a Story is stopped on something you have to do**. While
Stories are in flight, landing, or stopped on something the delivering
session clears itself, it draws nothing.

```text
◆ #8269 needs your approval — review and approve the PR (PR #8276) · Messages can send…   [Open PR] [Hide]
✗ #5544 close failed at base-sync — resume the Story · +1 more                           [Copy] [Hide]
```

**When it draws.** It reads each
`<tempRoot>/orchestration/story-deliver-terminal-<id>.json` written in the
last 24 hours and shows the ones that need a person:

| Result | Line | Color | Button |
| --- | --- | --- | --- |
| `blocked` with `blocked.recovery: "operator"` | `◆` + the block, worded below | magenta | `Open PR` |
| `failed` | `✗ close failed at <phase> — resume the Story` | red | `Copy` the `nextCommand` |
| `escalated` | `✗ too big for the light path — plan it` | red | `Copy` the `nextCommand` |

A `blocked` result with `recovery: "agent"` (pending or red checks, an API
race, a queue ejection, an advisory gate) draws nothing: the delivering
session clears those itself. An envelope written before `recovery` existed
falls back to the operator rows below. `landed` and `pending` results draw
nothing, and so does a result whose `.worktrees/story-<id>/` changed after
it was written, because someone has resumed that Story.

| `blockClass` | Worded as |
| --- | --- |
| `branch-protection-human-required` | needs your approval — review and approve the PR |
| `arm-failure` | auto-merge could not arm — merge the PR yourself |
| `predicate-refused` | a repo rule refused the merge — check the PR |
| `merge-queue-rest-unsupported` | the merge queue needs a hand — add the PR to the merge queue |

**The line.** The newest blocker leads, `· +N more` counts the rest, and
the Story title (from `story-init-result-<id>.log`, while it is on disk)
comes last. When the line runs out of room, the title goes first. After
that the line is cut with `…`, never wrapped.

**Buttons.** `Open PR` uses the envelope's `pr.url`, else
`https://github.com/<github.owner>/<github.repo>/pull/<n>` from the config.
`Copy` copies the envelope's `nextCommand`. `Hide` hides this result; a
newer result for any Story shows the band again.

**Where it reads.** Every path is relative to the main checkout. A session
running in a linked worktree (for example `.claude/worktrees/<name>`) has a
`.git` file reading `gitdir: <main>/.git/worktrees/<name>`, and the band
reads from that `<main>`. `tempRoot` is `project.paths.tempRoot` from
`.agentrc.local.json`, then `.agentrc.json`, and defaults to `temp`. With
no `.agents/` in the checkout it draws nothing. The band refreshes on
session start, after each turn and every 15 seconds.

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
draw (`$.ui.*`), keep session state (`$.state`) and keep time (`$.clock`).
It hooks only `session.start`, `turn.complete` and `ui.render` (the
`AbovePrompt` band), and its buttons only change `$.state` or copy to
the clipboard. It hooks no `tool.call`, `prompt.submit`,
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
