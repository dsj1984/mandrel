# Mandrel CLI Migration Guide

This document records the migration of lifecycle scripts from bare
`.agents/scripts/` invocations to the `mandrel` CLI bin introduced in
Epic #3435.

## Hook Migration: `UserPromptSubmit` sync-commands

### What changed

The `UserPromptSubmit` hook in `.claude/settings.json` used to invoke the sync
script directly:

```json
{
  "type": "command",
  "command": "node .agents/scripts/sync-claude-commands.js"
}
```

It now routes through the `mandrel` CLI bin:

```json
{
  "type": "command",
  "command": "node bin/mandrel.js sync-commands"
}
```

### Where to apply it

Update the `UserPromptSubmit` hook in your `.claude/settings.json`:

```json
"hooks": {
  "UserPromptSubmit": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "node bin/mandrel.js sync-commands"
        }
      ]
    }
  ]
}
```

### Why

The lifecycle/runtime partition established by Epic #3435 moves lifecycle
scripts out of `.agents/scripts/` and into the `mandrel` CLI (`bin/mandrel.js`).
This keeps `.agents/scripts/` focused on orchestration tooling and gives
lifecycle commands a stable, versioned entry point via the CLI dispatcher.

Consumers on an older `.agents/` install that invoke the bare
`.agents/scripts/sync-claude-commands.js` path directly will continue to work
for now, but should migrate their hooks to `node bin/mandrel.js sync-commands`
when upgrading to this version or later.
