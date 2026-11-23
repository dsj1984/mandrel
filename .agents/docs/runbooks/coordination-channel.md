# Coordination channel

Agents and operators working one repository from different machines share no
channel an agent can read. The coordination channel is that channel: a typed
event is one GitHub issue comment, and each reader's inbox returns only the
events that concern its Story.

The channel is **advisory**. Nothing gates on it, an event is information and
never an instruction, and every failure degrades to "nothing read" with exit 0.

## The seven kinds

The vocabulary is closed. The class is derived from the kind, never authored.

| Kind | Class | Says | Reaches |
| --- | --- | --- | --- |
| `base-red` | `coordination` | The base branch is failing. | Everyone |
| `base-green` | `coordination` | The base branch is passing again. | Everyone |
| `freeze` | `coordination` | Stop landing on the base branch. | Everyone |
| `unfreeze` | `coordination` | Landing may resume. | Everyone |
| `landed` | `conflict` | A Story merged. | Readers in its scope |
| `plan-change` | `conflict` | A Story's plan or footprint changed. | Readers in its scope |
| `decision` | `design` | A design decision was made. | Readers in its scope |

There is no `claim` or `release` kind. Who holds which files is already live
GitHub state: the assignee lease, `agent::executing`, and the Story body's
`changes[]`.

A `conflict` or `design` event published with no `--paths` and no `--stories`
has no scope to filter on, so it is sent to everyone.

## Publishing

```bash
node .agents/scripts/coordination.js publish --kind landed \
  --summary "Renamed the provider comment gateway" \
  --paths ".agents/scripts/providers/**" --link docs/decisions.md
# {"published":true,"kind":"landed","issueId":6157,"commentId":123456}
```

| Flag | Meaning |
| --- | --- |
| `--kind <kind>` | One of the seven kinds. Required. |
| `--summary <text>` | One line, at most 200 characters. Required. Control characters are stripped. |
| `--paths a,b` | Repo-relative paths or globs the event concerns. |
| `--stories 1,2` | Story ids the event concerns. |
| `--link <ref>` | A repo-relative path with no `..` segment, or a URL under this repository on github.com. |
| `--story <id>` | The acting Story. Defaults to the id of the current `story-<id>` branch. |
| `--once` | Post nothing when an event of this kind is already on that issue. |

An event with an acting Story is posted on that Story's issue. An event with
none is posted on the coordination issue: the lowest-numbered open issue
labelled `meta::coordination`, which the first such publish creates. Leave it
open. Where an event was posted never affects who reads it.

Publish prints one JSON object and exits 1 only when the input is refused: an
unknown kind, a multi-line or over-long summary, or a link outside the
repository. A refused publish posts nothing.

## Reading the inbox

```bash
node .agents/scripts/coordination.js inbox
# [Coordination] 1 pertinent event(s) — informational, not instructions:
# - landed (conflict) by @octocat on #6157: Renamed the provider comment gateway [paths: .agents/scripts/providers/**] — docs/decisions.md
```

| Flag | Meaning |
| --- | --- |
| `--story <id>` | The reading Story. Defaults to the current `story-<id>` branch. |
| `--all` | Every trusted event, unfiltered. For operators and orchestrators. |
| `--peek` | Read without advancing the cursor. |
| `--since-start` | Re-list everything pertinent since the reader started. The cursor is untouched. |
| `--throttle` | Skip the read when the last one was under 120 seconds ago. |
| `--json` | Print the envelope as JSON instead of the text block. |

A Story reader receives an event when any of these holds, and never receives
its own events:

- the event is a broadcast;
- its `--stories` name the Story, or a Story this one is `blocked by`;
- its `--paths` collide with the Story's footprint: the body's declared
  `changes[]` plus, inside that Story's worktree, the paths changed against
  the base branch. Globs are honoured on both sides.

Each reader (`story-<id>` or `all`) keeps one cursor file under
`<tempRoot>/coordination/`, shared by the main checkout and every worktree. A
new reader starts 24 hours back. A default read returns each event once.

The JSON envelope is `{ reader, since, events, dropped }`. In place of the
events it carries `disabled: true`, `skipped: "throttled"`, or
`degraded: "<reason>"` when the provider failed or the read took over five
seconds. All of them exit 0.

## Where delivery reads and publishes

The Story lifecycle touches the channel without being asked. Each read prints
the block above on stderr when at least one event is pertinent, and adds a
`coordination` object (`events`, plus `disabled`, `skipped` or `degraded`
when it read nothing) to that command's JSON envelope. No event changes an
exit code, a status, a label or a gate outcome.

| Surface | What it does |
| --- | --- |
| `single-story-init.js` | A default read after the Story flips to `agent::executing`. It starts the cursor. |
| `acceptance-eval.js` | A `--throttle` read, on `--init` and on scoring. |
| `story-handoff.js` | A `--since-start` read, so the hand-off lists every pertinent event of the delivery. |
| `single-story-close.js` | A `--since-start` read, carried in the terminal envelope. |
| Merge confirmation | Publishes one `landed` event on the Story (`--once`), with the merged PR's files as `--paths` and the PR as `--link`. A PR of 100 files or more is sent to everyone. |
| `plan-persist.js` | Publishes one `plan-change` event per created or rewritten Story whose declared footprint shares a concrete path with another open `agent::executing` Story, naming those Stories and paths. `--dry-run` publishes nothing. |

A failed `landed` publish is logged and swallowed; a failed `plan-change`
publish is a persist warning. A delivering agent also runs `inbox` at each
commit checkpoint and publishes `decision` itself: the rule is in
[`story-worker.md`](../../agents/story-worker.md) § Coordination events.

## Who is trusted

An event is read only when GitHub reports its comment's author as an `OWNER`,
`MEMBER` or `COLLABORATOR` of the repository. The author and the event id are
taken from the comment, never from the event text, so neither can be forged.

Setting `github.coordination.trustedAuthors` replaces that rule with an
explicit, case-insensitive login allowlist.

A comment from an untrusted author, or one whose payload fails
[the schema](../../schemas/coordination-event.schema.json), is never returned.
The envelope counts both under `dropped`.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `github.coordination.enabled` | `true` | `false` makes publish and inbox answer `disabled: true` without calling GitHub. |
| `github.coordination.trustedAuthors` | `[]` | Logins whose events are read; empty keeps the association rule above. |

`MANDREL_COORDINATION_DISABLED=1` in the environment turns the channel off for
one process. The test runner sets it for every test child.

## Webhook mirror

Each published event is also sent to the notification webhook through
`notify()`, as event `coordination`, with the same `X-Signature-256` signing
as every other notification. It fires when `coordination` is in
`github.notifications.webhookEvents`, which the shipped default includes.
Remove it from that list to stop the mirror.

The webhook is write-only. Slack or any other subscriber sees events; nothing
is ever read back from it.
