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
- The page writes every GitHub-sourced string as text, never as HTML.

There is no sign-in, no hosted mode and no stored secret. Do not expose the
port through a tunnel or proxy: the token protects the API from other pages
in your browser, not from other people on a network.

## The board

Columns, in order: **Backlog**, **Planning**, **Ready**, **Delivering**,
**Blocked**, **Done**. Delivering holds one lane per configured environment,
headed by its name, target and `load/capacity` (or `offline`), plus an
`untracked` lane for in-flight Stories that carry no `env::` label. A card
shows the Story id, title, published stage, pull request with its check
summary, unmet dependencies and environment.

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
