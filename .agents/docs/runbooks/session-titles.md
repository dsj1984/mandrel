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
3. **Load the host's session-title tool, then rename.** On the Claude
   desktop app it is `mcp__ccd_session_mgmt__set_session_title`, called with
   `session_id: "self"` and the printed `title`. The app ships it
   **deferred**: only its name is listed until it is loaded, and calling it
   unloaded fails. A listed-but-unloaded tool is not an absent one: load it
   first with `ToolSearch` query
   `select:mcp__ccd_session_mgmt__set_session_title`, once per session, then
   rename. Skip silently only when that load finds no such tool.
4. **Never let a rename block the workflow.** A declined or failed rename,
   or a failed load, is ignored: never retried, never asked about, and it
   never fails or pauses the step that set it.

The desktop app asks the operator to approve renaming a session whose title
they set by hand; declining is a declined rename, so the run carries on under
the operator's title.

## Which hosts title

| Host | Titles? | Why |
| --- | --- | --- |
| Claude desktop app | Yes | Loads the deferred tool, then renames |
| Claude Code CLI | No | No session-title tool; the step skips |
| Codex | No | No session-title tool; the step skips |
| Claude Code cloud / web sessions | No | No `ccd_session_mgmt` tool is exposed, so the session stays untitled |
| Runner-set `--yes` run | No | Nobody is at the keyboard; the step skips |

## Allowing the rename without a prompt

Unless the tool is allowlisted, the desktop app stops each rename on a
permission prompt, so an unattended run waits or the rename is declined. Add
this entry to `permissions.allow` in `.claude/settings.json` (or the
per-operator `.claude/settings.local.json`):

```json
"mcp__ccd_session_mgmt__set_session_title"
```

It is safe to allow: it only renames the current session.
`mcp__ccd_session_mgmt__*` or `mcp__ccd_session_mgmt` also covers it, but
allows the server's other tools too. `/mandrel-update` Step 3.6 proposes the
entry, and `mandrel doctor`'s `session-title-allowlist` advisory reports when
titles are on and no settings file allows it.
