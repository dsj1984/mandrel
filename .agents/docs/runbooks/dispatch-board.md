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

The server stores nothing. Every state read is recomputed from GitHub
through the `mandrel dispatch --status` read model, joined with the delivery
stage a running delivery publishes on its Story. A read is reused for at
most 5 seconds; the page polls every 15 seconds and after each action.

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
- Every response carries a strict Content-Security-Policy (no inline script
  or style, same-origin only), `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
- No response contains a credential. The Connections dialog reports only
  whether a GitHub token resolves and from where (environment variable or
  `gh`), never its value. Errors are `{ "error": "<code>" }` with no stack
  trace or path.
- The page writes every GitHub-sourced string as text, never as HTML, and
  links only to `https://github.com/` pages.
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
**Blocked**, **Done**. Delivering holds one lane per configured environment,
headed by its name, target and `load/capacity` (or `offline`), plus an
`untracked` lane for in-flight Stories that carry no `env::` label. A card
shows the Story id, title, pull request with its check summary, unmet
dependencies and environment.

A card in Delivering or Blocked also shows a status row:

- a stepper over the five published stages (build · check · handoff ·
  close · merge), marking the current one and those before it;
- a liveness badge: a pulsing dot for `working`, amber **process exited**
  for `exited`, grey `unknown` (see
  [Following a dispatched delivery](dispatch.md#following-a-dispatched-delivery)).
  An `exited` process on a Story still `agent::executing` is highlighted as
  a warning. Under `prefers-reduced-motion` the dot does not pulse;
- `running Nm` since the launch and `updated Nm ago` since the last stage.

## The side panel

A Story's detail opens in a side panel on the right; the board stays
visible and usable beside it. Open it by double-clicking a card,
right-clicking it, pressing Enter or Space on a focused card, or with the
card's **⋯** button. Esc, the × button or opening the same card again
closes it. While open it refreshes on the board's poll.

The Story detail view shows the GitHub issue link, the pull request and its
checks, the column, environment, stage and labels, the stage timeline (the
last 10 stage changes), the dispatch record (pid, start time, session id or
URL, command), the last 50 lines of the log summarized one line per event,
and the resume command `claude --resume <sessionId>` with a **Copy**
button. The page never runs that command. Its action buttons are the
card's Move menu, so Stop still asks for confirmation.

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
there. Every card also has a **Move** menu listing the same allowed actions,
so nothing requires dragging.

## Other views

- **Environments**: one card per environment with its target, load, online
  state, where it is defined (`.agentrc.json`, `.agentrc.local.json` or the
  implicit default) and the Stories it holds. Read-only; edit environments
  in config.
- **Connections** (the status button): GitHub token presence and source,
  `claude` CLI availability, and per environment whether it is online and
  why not.
- **Theme** (overflow menu): auto (follows the system), light or dark.
