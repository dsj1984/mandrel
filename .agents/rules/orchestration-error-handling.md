# Orchestration Error Handling

This rule applies to contributors writing or modifying orchestration scripts
under `.agents/scripts/*.js` and the helper modules under
`.agents/scripts/lib/orchestration/**`. Most agent task work does not touch
these files; consult this rule only when implementing or refactoring
orchestrators themselves.

## Throw, Never Fatal

Orchestration scripts MUST surface unrecoverable failures with
`throw new Error(<message>)` rather than `Logger.fatal(<message>)`. The
`runAsCli` boundary catches the throw and maps it to `process.exit(1)`,
preserving the message verbatim and staying robust under a mocked
`process.exit`; `Logger.fatal` falls through silently when `process.exit` is
stubbed, letting execution continue past the intended hard-stop.

### Where it applies

- `.agents/scripts/<orchestrator>.js` (top-level CLI entry points)
- `.agents/scripts/lib/orchestration/**/*.js` (helper modules)

Non-orchestration scripts (one-shot utilities, audit reporters, doc
generators) may continue to use `Logger.fatal` where the lifetime guarantees
are simpler.
