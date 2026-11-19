# Session titles

Plan, deliver, orchestrate, audit and QA runs retitle the host session as they
progress, so an operator with several sessions open can read from the sidebar
alone what each one is working on and what state it is in.

| Glyph | State |
| --- | --- |
| `○` | planning (stays `○` once the plan is saved) |
| `◐` | in progress |
| `●` | done |
| `⊗` | blocked |

No other glyph is ever emitted.

## Building a title

A workflow step names an event; the title itself is built only by
`session-title.js`, never composed inline:

```bash
node .agents/scripts/session-title.js --event deliver --ids 6108,6109
# {"title":"◐ Delivery #6108 #6109","apply":true}
```

`node .agents/scripts/session-title.js --help` lists every event and the one
input it takes. One to three ids render as `#a #b #c`; more render as
`#<min>–#<max> (<count>)`. A title is capped at 48 characters, cutting only the
free text.

## Applying a title

1. **Rename only when `apply` is `true`.** With
   `delivery.routing.sessionTitles: false` (set it in `.agentrc.local.json` to
   opt out as one operator) the script prints
   `{"title":null,"apply":false,"reason":"disabled"}` and exits 0: skip the
   rename.
2. **Rename only the top-level session.** A subagent (`story-worker`,
   `acceptance-critic`, an auditor, a critic) never titles: a subagent cannot
   rename the session it runs in. A dispatched session titles itself only
   through the workflow it runs.
3. **Use the host's session-title tool.** On the Claude desktop app it is
   `mcp__ccd_session_mgmt__set_session_title` with `session_id: "self"` and
   the printed `title`. A host with no session-title tool skips silently:
   the Claude Code CLI, Codex, and any runner-set `--yes` run.
4. **Never let a rename block the workflow.** A declined or failed rename is
   ignored: never retried, never asked about, and it never fails or pauses the
   step that set it.

The desktop app asks the operator to approve renaming a session whose title
they set by hand; declining is a declined rename, so the run carries on under
the operator's title.
