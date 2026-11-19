# The local dispatch board

`mandrel ui` serves one local page that shows every Story's state across your
delivery environments, and starts, resumes or stops a delivery when you drag
a card. It is a face over `mandrel dispatch`: every action it takes is the
same action, with the same verdict, as the command in the
[dispatch runbook](dispatch.md).

## Running it

```bash
npx mandrel ui              # http://127.0.0.1:4319/
npx mandrel ui --port 5000
```

The command prints the URL and runs until you interrupt it (Ctrl+C). Open
the printed URL in a browser on the same machine. It needs what
`mandrel dispatch` needs: a GitHub token (`GITHUB_TOKEN`/`GH_TOKEN` or
`gh auth login`) and, for the default environment command, the `claude` CLI.

Run it from your project's root. The board reads the `.agentrc.json` of the
directory it starts in, and refuses to start (exit 1) when that config names
no `github.owner` and `github.repo`, printing the directory it looked in.

When a state read fails later, the page shows a short message and the
terminal running `mandrel ui` prints the cause
(`mandrel ui: board state read failed: …`). The API answers `503` with
`no-github-repo`, `config-invalid` or `state-unavailable`, never the cause
itself.

The server stores nothing. Every state read is recomputed from GitHub
through the `mandrel dispatch --status` read model, joined with the delivery
stage a running delivery publishes on its Story. A read is reused for at
most 5 seconds, separately for each Done limit; the page polls on the
cadence chosen in Settings (15 seconds by default) and after each action.

## Security model

The board is a local, single-operator tool. It never leaves your machine:

- It binds `127.0.0.1` only. A request whose `Host` header is not
  `127.0.0.1:<port>` or `localhost:<port>` is refused (403), which stops a
  DNS-rebinding page from reaching it.
- Each run generates a random 32-byte token and embeds it in the page it
  serves. Every `/api/` request must present it in `X-Mandrel-Token`
  (compared in constant time). Another tab or site cannot read the page, so
  it cannot learn the token.
- An action (`POST /api/action`) must also carry the server's own `Origin`
  and `Content-Type: application/json`. Its body is capped at 4 KB and must
  be exactly `{ action, storyId, environment }`: `action` one of
  `dispatch`, `resume`, `stop`; a positive integer `storyId`; a configured
  `environment`. Anything else is refused (400) and runs nothing.
- `POST /api/launch-options` sets a Story's model and effort overrides
  under the same checks, in the same order: the Host allowlist, the token
  (403 `forbidden`), the same `Origin` and JSON content type (403), and the
  4 KB body cap. The body must be exactly `{ storyId, model, effort }`: a
  positive integer `storyId`, a `model` in the allowlist or `null`, an
  `effort` level or `null` (`null` uses the environment default).
  Anything else is 400 (`invalid-body`, `unknown-property`,
  `invalid-story-id`, `invalid-model`, `invalid-effort`); a closed ticket or
  an Epic is 409 `not-a-story`. It writes the Story's labels in one update
  and nothing else; dispatch re-validates the labels at launch anyway.
- Every response carries a strict Content-Security-Policy (no inline script
  or style, same-origin only), `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
- No response contains a credential. The Connections view reports only
  whether a GitHub token resolves and from where (environment variable or
  `gh`), never its value. Errors are `{ "error": "<code>" }` with no stack
  trace or path.
- `GET /api/connections` also names the accounts in use: the GitHub login
  (`gh api user`, which honours `GH_TOKEN`/`GITHUB_TOKEN` first, so it is
  the token's account) and, from `claude auth status --json`, only the
  Claude account's email, org name, plan and login method (plus the API
  provider when it is not first-party). Both lookups run in parallel with a
  10 s timeout and are reused for 60 seconds. Account values are never
  logged; they appear only in this token-protected response and the page.
- The page writes every GitHub-sourced string as text, never as HTML, and
  links only to `https://github.com/` pages.
- `GET /api/state` and `GET /api/story` take an optional `done=<n>`, the
  number of Done Stories to read: 10, 20 (the default), 50 or 100, as
  `mandrel dispatch --status --done-limit` accepts. Any other value is
  refused with 400 `invalid-done-limit`.
- `GET /api/story?id=<n>` takes only a 1–10 digit positive id (400
  `invalid-id` otherwise, 404 `not-found` for a Story not on the board). Its
  log tail is read from the path the dispatch record names, and only when
  that path is inside `<tempRoot>/dispatch/`; the page never supplies a
  path, and no response carries an absolute path other than the recorded
  argv.

There is no sign-in, no hosted mode and no stored secret. Do not expose the
port through a tunnel or proxy: the token protects the API from other pages
in your browser, not from other people on a network.

## The board

Columns, in order: **Backlog**, **Planning**, **Ready**, **Delivering**,
**Blocked**, **Done**. Each column header shows how many cards it displays
after the filters and search; Done adds the total closed Stories, as
`<shown> of <total>`. A column displaying no cards collapses to a narrow
rail; it is still a drop target, and every rail opens while you drag a card.

With two or more environments, Delivering holds one lane per environment,
headed by its name, target and `load/capacity` (or `offline`), plus a
**Not launched from the board** lane for in-flight Stories that carry no
`env::` label. With exactly one environment, Delivering shows no lane
headers: the column header carries that environment's `load/capacity` (or
`offline`), and the launched cards come first, followed by the rest. The
whole column body is then that environment's drop target.

A card shows the Story id, title, its Epic as `Epic #<id>` (the full title
on hover), pull request with its check summary, unmet dependencies and
environment. Every ticket id on the board (the card's id, each
`waits on #<id>`, the Epic, the detail's Depends on) links to its GitHub
issue, and every GitHub link opens in a new tab.

**Ready** lists the Stories a drop would dispatch now first: those whose
verdict is ok in at least one environment, in read-model order. The others
follow, dimmed, each with one line saying why it waits: the refusal detail
from the first environment that refuses it, such as `#12 is leased to @x.`
or an environment at capacity. A Story waiting on an open dependency shows
only its linked `waits on #<id>` line.

A **Blocked** card shows one truncated line naming why it is blocked: the
first heading of the latest friction comment the runtime posted on the
Story (for example `story-handoff blocked: lint`). The Story detail shows it
in full as **Blocked by**, linked to the comment. A blocked Story with no
friction comment shows no line.

**Project Status** is the GitHub Projects v2 **Status** field, read from the
project `github.projectNumber` names. A card shows it, as a dot and the
Status name (grey Todo, blue In Progress, amber On Hold, purple Done), only
when it has drifted: when it differs from the Status board-sync writes for
the Story's labels (below; a closed Story expects Done). A Story whose
labels give board-sync nothing to write shows no chip. The Story detail
always lists the Status, and the header's Status filter is unaffected.
With no project configured, or a token without the `project` scope, cards
show no Status and the board still loads. Mandrel writes the Status itself on every `agent::` label
change: `agent::ready` and `agent::review-spec` → Todo, `agent::executing`
and `agent::closing` → In Progress, `agent::blocked` → On Hold,
`agent::done` → Done. `node .agents/scripts/agents-bootstrap-github.js` adds On Hold to the project's
Status options when it is missing; until then a blocked Story's Status write
is skipped.

The board shows every open issue, whoever it is assigned to, plus the most
recently closed Stories. Epics are not cards: a Story an open Epic lists
(as a `- [ ] #<id>` checklist item or a native sub-issue) names that Epic
on its card, linked to its GitHub issue. Assignees and labels stay off the
card, in the Story detail.

A card in Delivering or Blocked also shows a status row:

- once the delivery has published a stage, a stepper over the five
  published stages (build · check · handoff · close · merge), marking the
  current one and those before it. Before the first stage, the row reads
  `no stage yet` with no stepper. A Delivering Story with neither a stage
  nor a dispatch record shows only the muted line
  `running outside the board`;
- a liveness badge: a pulsing dot for `working`, amber **process exited**
  for `exited` (see
  [Following a dispatched delivery](dispatch.md#following-a-dispatched-delivery)).
  An `exited` process on a Story still `agent::executing` is highlighted as
  a warning. Under `prefers-reduced-motion` the dot does not pulse. A Story
  the board holds no dispatch record for (delivered from a session the
  board did not launch) shows no badge, since its process cannot be told;
- `running Nm` since the launch and `updated Nm ago` since the last stage.

## The header

The board is always the main view. The header's right side holds a search
box, the **Status**, **Epic** and **People** filters and two icon buttons.

**Search** filters the cards as you type. Digits, with or without a leading
`#`, match the start of a Story id (`61` and `#61` both match #6139);
anything else matches the title, ignoring case. Press `/` anywhere outside
a text field to focus it and Esc to clear it. The search is not saved.

**Status** chooses which Project Statuses the columns show. Its menu lists
**No status** and every Status on the board in board order (Todo, In
Progress, On Hold, Done, then any other); its **Any status** button clears
it. It reads, tints and saves like People below.

**Epic** chooses which Epics' Stories the columns show. Its menu lists
**No Epic** and every Epic on the board as `#<id> <title>`; **Any Epic**
clears it. It reads, tints and saves like People.

The search and the three filters combine: a card shows only when it passes
all four.

**People** chooses whose Stories the columns show. Its menu lists
**Unassigned** and every login assigned to a Story on the board; check any
number of them, or choose **Everyone** to clear the filter. Its button
reads `Everyone`, the one choice, or `<n> selected`, and is tinted while a
filter is on. The choice is saved in this browser. Hidden Stories still
count as dependencies, so a card can wait on one you have filtered out.

The icon buttons:

- **Connections** (plug icon): tinted when GitHub and the `claude` CLI both
  resolve, amber when either needs attention. A badge shows how many
  environments are offline, when any are.
- **Settings** (gear icon): the board's preferences.

Each button opens its view in the side panel; clicking it again closes the
panel, and clicking another one switches views.

## The side panel

The side panel opens on the right and holds one view at a time: a Story's
detail, Connections or Settings. The board stays visible and usable
beside it, and opening a Story's detail replaces whichever view is open.
Open a Story's detail by clicking the card anywhere but a link or button,
or by pressing Enter or Space on a focused card. Esc, the × button or
opening the same card again closes it. While open it refreshes on the board's poll.

The Story detail view shows the GitHub issue link, the pull request and its
checks, and then only the facts that have a value: the Project Status, the
column, what it is blocked by, environment, model and effort, stage, process, assignees, the Epic and the Stories it
depends on (both linked), and the labels as chips. The stage timeline (the
last 10 stage changes), the dispatch record (pid, start time, session id or
URL, command) and the last 50 lines of the log, summarized one line per
event, appear only when there is something to show, as does the resume command `claude --resume <sessionId>` with a **Copy**
button. The page never runs that command. Its action buttons list every
move the card allows, so Stop still asks for confirmation.

## Model and effort

Each card's **✎** button opens a dialog with a **Model** and an **Effort**
select. Each opens on **Use default**, which clears the Story's override;
any other choice sets the `model::<m>` / `effort::<e>` label (created on
demand) and removes every other one. Below them, a line per field names the
effective value and its source as one phrase: `opus (override)`,
`sonnet (from local)`, `Claude Code default (from local)`, or
`routine's own model` for a cloud environment. For a Story not yet in an
environment it names each local environment's default, joined by `or`
(`sonnet (from local) or Claude Code default (from gpu)`), and
`set at dispatch` when only cloud environments are configured. **Save**
posts `POST /api/launch-options` and refreshes the board. The card face
shows no model or effort; the Story detail lists **Model** and **Effort**
facts with their source. Precedence and the allowlist are in
[Model and effort](dispatch.md#model-and-effort).

## Drag actions

The page implements no dispatch rule. Each Story arrives with the verdict
every drop target would return; while you drag a card, every zone shows what
a drop there would do, or why it is refused.

| Drag | What happens |
| --- | --- |
| Ready → an environment lane | Dispatch (`mandrel dispatch --env <lane> <id>`). |
| Blocked → its own lane | Resume (`mandrel dispatch --resume <id>`). |
| Delivering or Blocked → Ready | Asks for confirmation, then stops (`mandrel dispatch --stop <id>`). |
| Backlog → Planning | Copies `/mandrel-plan <id>` to the clipboard; launches nothing. |
| Anything refused | Shows the refusal reason and changes nothing. |

A card moves to its new column only when the next state read places it
there. Nothing requires dragging: each card carries one action button,
labelled with what it would do (`Dispatch to local`, `Resume in local`,
`Stop and return to Ready`, which still asks for confirmation, or
`/mandrel-plan <id>`, which copies the command). When more than one move is
allowed, a **▾** button beside it opens a menu with the rest. A card with no
allowed move has no action button. The **✎** button always follows.

## Panel views

- **Connections**: the GitHub login, token source and status; the Claude
  account's email, org, plan and login method; `claude` CLI availability;
  and an **Environments** section with one card per environment: its
  target, `load/capacity`, whether it is online and why not, where it is
  defined (`.agentrc.json`, `.agentrc.local.json` or the implicit default)
  and the open Stories it holds. Environments are read-only here; edit
  them in config. These are the accounts the board and its **local**
  launches act as, since a local launch inherits the board's environment.
  A cloud environment's session runs as its routine owner's account
  instead; its card shows the routine id, never a token.
- **Settings**: the board's preferences. A change applies at once; there
  is no Save button, and **Reset to defaults** restores all three.

  | Setting | Choices | Default |
  | --- | --- | --- |
  | Theme | auto (follows the system), light, dark | auto |
  | Done Stories shown | 10, 20, 50, 100 | 20 |
  | Refresh every | 15 s, 30 s, 60 s | 15 s |

  Settings are kept in this browser only, as one JSON object under the
  `localStorage` key `mandrel-board-settings`; another browser or user
  keeps its own. The board writes no repository or config file. A missing,
  unreadable or out-of-range value falls back to its default, so the board
  still works with storage blocked. A theme saved by an earlier version is
  carried over once.
