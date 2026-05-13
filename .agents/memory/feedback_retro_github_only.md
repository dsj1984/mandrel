---
name: Epic retro must be GitHub-only
description: Never fire the notification webhook for the epic retrospective body — it belongs only on the Epic as a structured comment
type: feedback
originSessionId: fe1e8f7f-8acc-4bde-aba3-29780de36dce
---

# Epic retro must be GitHub-only

The epic retrospective is a GitHub-only artefact. When posting it to the Epic issue, use a path that writes the structured comment **without** firing the notification webhook.

**Why:** Originally hit on 2026-04-22 (pre-Epic #902 rename: was `/sprint-retro`, now lives at `.agents/workflows/helpers/epic-retro.md`). Calling `notify.js` for the retro body fires the webhook (`[Notify] Firing webhook (notification) to https://hook.us2.make.com/...`) in addition to posting the GitHub comment. Retros are long-form reflection, not operator-action signals — webhook consumers (Make.com / Slack) should not see the retro body.

**How to apply:** When posting a retro, prefer one of:

- `provider.postComment(epicId, { body, type: "retro" })` (or `mcp__mandrel__post_structured_comment`) — writes the structured comment without touching the webhook.
- A direct GitHub API call (`gh api repos/.../issues/.../comments --method POST`) with the `retro-complete:` marker in the body.

Do **not** use `notify.js` for retros. Verify against the current `helpers/epic-retro.md` if the doc has drifted. The terminal `/epic-close` notification is a different artefact — short action signal — and appropriately uses `notify.js`.
