# Project Board — Canonical Kanban Reference

This document is the source of truth for the Mandrel default
GitHub Projects V2 board. `agents-bootstrap-github.js` attempts to
provision everything below automatically; any step that requires a scope
or a GraphQL mutation the token cannot reach is logged as a warning and
expected to be finished by hand using the checklist at the bottom.

## Status field

The board uses GitHub's stock single-select `Status` field with its three
default options, in order:

| # | Option        | Meaning                                                                  |
| - | ------------- | ------------------------------------------------------------------------ |
| 1 | `Todo`        | Open work item; not yet started. Covers parking states (review-spec, ready). |
| 2 | `In Progress` | Active work, including hand-offs to closing and blocked-on-HITL pauses.  |
| 3 | `Done`        | `agent::done` — work complete, cascaded; PR merged for Epics.            |

Granular lifecycle state lives in the `agent::*` labels (see the
mapping below); the Status column is a coarse kanban view collapsed
from them. Bootstrap treats the option list as additive — it never
removes existing options, so extending the field with team-specific
states is safe.

## Label → Column map

`lib/orchestration/column-sync.js` drives the Status column on every
label transition via the `LABEL_TO_COLUMN` table. The sync is invoked
from inside `transitionTicketState` (Story #2548), so every Epic,
Story, and Task flip mirrors onto the board automatically — no need
for callers to opt in. Terminal `Done` wins unconditionally; in-flight
labels (executing / closing / blocked) collapse to `In Progress`;
parking labels (review-spec / ready) collapse to `Todo`.

| Label                | Column        |
| -------------------- | ------------- |
| `agent::review-spec` | `Todo`        |
| `agent::ready`       | `Todo`        |
| `agent::executing`   | `In Progress` |
| `agent::closing`     | `In Progress` |
| `agent::blocked`     | `In Progress` |
| `agent::done`        | `Done`        |

## Default Views

Bootstrap attempts to create the three views below via
`createProjectV2View`. That mutation is not generally available on public
tokens, so expect the bootstrap log to report
`Projects V2 Views mutation unavailable — see docs/project-board.md`.
Create them by hand using the filter strings below.

### 1. Epic Roadmap

- **Layout**: Board
- **Filter**: `label:type::epic`
- **Group by**: `Status`

Gives a single-glance view of every Epic's lifecycle column.

### 2. Active Stories

- **Layout**: Board
- **Filter**: `label:type::story -status:Done`
- **Group by**: `Status`

Shows Stories still in flight — useful for a daily standup.

> **Legacy boards:** earlier bootstrap runs created this view under the
> name `Current Sprint`. Re-running bootstrap will add `Active Stories`
> alongside any existing `Current Sprint` view (bootstrap never deletes
> views). Operators with the legacy view can remove it by hand once the
> renamed view is verified.

### 3. My Queue

- **Layout**: Board
- **Filter**: `assignee:@me`
- **Group by**: `Status`

Personal filter that works across Epics, Features, Stories, and Tasks.

## Manual setup checklist

Use this when bootstrap logs a warning such as
`token lacks the "project" scope` or
`Projects V2 Views mutation unavailable`.

1. **Create the project.** In GitHub, go to the owner (user or org) →
   Projects → New project → Board layout. Name it `<repo> — Agent
   Protocols` (or whatever `github.projectName` is set to
   in `.agentrc.json`).
2. **Record the project number.** Set
   `github.projectNumber` and
   `github.projectOwner` in `.agentrc.json` to match.
3. **Add the `Status` field.** A freshly-created GitHub project already
   has a `Status` field with the three options (`Todo`, `In Progress`,
   `Done`) — no manual setup needed. Bootstrap's `ensureStatusField`
   call is a no-op in that state. Only intervene if the project was
   created without the default field, in which case: Settings → `+ New
   field` → Single select → name `Status` → add the three options from
   the table above in order.
4. **Create the three views.** For each of Epic Roadmap, Active
   Stories, My Queue: `+ New view` → Board → paste the filter string →
   set Group by = Status.
5. **Re-run bootstrap** to verify. It is idempotent — it will skip the
   resources you just created and only add anything still missing.

## Token scopes

For bootstrap to provision the board end-to-end, the token needs at
minimum:

- `repo` (for labels)
- `project` (for Projects V2 fields and views)

Classic PATs need both `repo` and `project`. Fine-grained tokens need
the `Projects` permission set to Read & Write. Organisation SSO must be
authorised for the token if the project lives under an org.

## Extending the board

Teams that want additional Views should add them by hand — bootstrap
only ships the three above and never removes Views you've created.
Adding team-specific single-select options to `Status` is also safe:
bootstrap's option merge preserves any existing options by id.
