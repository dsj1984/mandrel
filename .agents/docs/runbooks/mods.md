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

[`mods/mandrel-status/`](../../mods/mandrel-status/) draws one dim line above
the prompt while you work in a Mandrel checkout:

| State on disk | The line |
| --- | --- |
| A `.worktrees/story-<id>/` with no newer terminal envelope | `mandrel · Story #<id> implementing` |
| …and close has written `close-gates-<id>.log` | `mandrel · Story #<id> closing` |
| …and that log has been quiet for 10 minutes | `… · stalled? no gate output for <n>m` |
| Otherwise, the newest `story-deliver-terminal-<id>.json` from the last 2 hours | `mandrel · Story #<id> <status> · PR #<n> checks <state> · <elapsed>` |
| None of the above, or no `.agents/` in the working directory | nothing |

It also toasts once when a terminal envelope appears with `status` `landed`
or `blocked`. Results already on disk when the session starts are not
toasted, and a hot reload does not repeat one.

The files sit under `<tempRoot>/orchestration/`. `tempRoot` is
`project.paths.tempRoot` from `.agentrc.local.json`, then `.agentrc.json`,
and defaults to `temp`. It refreshes on session start, after each turn and
every 15 seconds.

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
It hooks no `tool.call`, `prompt.submit`, `command.run` or `session.append`
event. It never writes files, spawns processes, calls the network or the
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
