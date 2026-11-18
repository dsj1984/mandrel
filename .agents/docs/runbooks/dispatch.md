# Dispatching a Story to an environment

`mandrel dispatch` starts, resumes and stops a Story's delivery in a named
**environment**, and records on GitHub which environment holds the Story.
It is the primary command; `node .agents/scripts/dispatch.js` takes the same
flags and runs the same code, for workflows and scripts that call state
mutations through `.agents/scripts/`.

## Configuration

Environments live under `delivery.environments` in `.agentrc.json` (or
`.agentrc.local.json`, which adds or overrides one through the usual merge):

```json
{
  "delivery": {
    "environments": {
      "local": { "target": "local", "capacity": 2 },
      "laptop-yolo": {
        "target": "local",
        "command": ["claude", "-p", "/mandrel-deliver {id}"]
      }
    }
  }
}
```

- **Name**: lowercase letters, digits and hyphens, at most 31 characters.
- **`target`**: where the delivery runs. Only `local` (this machine) exists.
- **`capacity`**: how many Stories the environment may hold at once
  (default 1).
- **`command`**: the argv started for a Story, with `{id}` replaced by the
  Story id (default `["claude", "-p", "/mandrel-deliver {id}"]`). It is
  spawned as an array, never through a shell.

With no `delivery.environments`, one implicit environment named `local`
with capacity 1 is used.

The holding environment is the label `env::<name>` on the Story, created on
demand. An environment's load is the number of open Stories carrying its
label in `agent::ready`, `agent::executing`, `agent::closing` or
`agent::blocked`. A label left on a closed Story is history and counts for
nothing.

## Actions

| Command | What it does |
| --- | --- |
| `mandrel dispatch --env <name> <id>` | Dispatch an `agent::ready` Story: apply `env::<name>`, then start the environment's command detached. Output goes to `<tempRoot>/dispatch/story-<id>.log`; the record (`pid`, `argv`, `startedAt`) sits beside it as `story-<id>.json`. If the process fails to start, the label is removed again and the command exits 1. |
| `mandrel dispatch --resume <id>` | Relaunch an `agent::blocked` Story in the environment its label names. No `agent::*` label changes: the launched `/mandrel-deliver <id>` owns the resume path. |
| `mandrel dispatch --stop <id>` | Stop the recorded process, release the lease, return the Story to `agent::ready` and remove its `env::` label. The branch and worktree are kept. |
| `mandrel dispatch --status [--json]` | Print every environment with its load and every Story's board column, with the verdict each drop target would return. |

`--dry-run` prints the verdict and the argv it would run, and writes and
starts nothing.

The launched delivery acquires the assignee lease exactly as a delivery you
start by hand does; dispatch never claims it.

## Output and exit codes

stdout is one JSON envelope (the `--status` table without `--json` is the
only exception).

- **0**: success, `{ ok: true, action, storyId, environment, pid?, logPath? }`.
- **2**: a refusal, `{ ok: false, action, reason, detail }`.
- **1**: the command itself could not run (bad arguments, a GitHub failure, a
  process that did not start), `{ ok: false, error }`.

## Refusal reasons

| Reason | Meaning |
| --- | --- |
| `unknown-environment` | No configured environment has that name. |
| `epic` | The id is an Epic; `detail` names its children to dispatch instead. |
| `not-ready` | A dispatch needs an `agent::ready` Story. |
| `already-dispatched` | The Story already holds an environment. |
| `foreign-lease` | Someone else holds the Story's assignee lease. |
| `unmet-dependency` | A `blocked by #<id>` footer names an issue still open; `detail` lists them. |
| `at-capacity` | The environment already holds `capacity` Stories. |
| `not-blocked` | A resume needs an `agent::blocked` Story. |
| `wrong-environment` | `--env` names a different environment than the Story's label, or a stop targets a Story no environment holds. |
| `closing` | A stop of an `agent::closing` Story; let close land, or recover it with `deliver-recover.js`. |

## Headless permissions

A dispatched delivery runs `claude -p` with nobody watching, so a tool
permission prompt it hits cannot be answered and the delivery stalls or
blocks. The default command carries **no** permission-bypass flag. Grant the
tools a delivery needs in the project's Claude Code settings, or, if you
accept the risk, set an environment's `command` explicitly with the flag you
want (for example `--permission-mode acceptEdits`). On Windows, `claude` is
usually a `.cmd` shim that cannot be spawned without a shell; set `command`
to the executable it wraps.
