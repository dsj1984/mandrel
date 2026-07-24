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

## Output Contract — compact digest + artifact path (Story #4708)

An orchestration script's stdout rides resident in the invoking agent's
transcript and is re-read as prompt-cache input on every later turn, so fat
success output is a per-turn tax on the whole session — not a one-time cost.

- **Budget.** A script's **default success-path stdout MUST stay under
  ~2KB**. Error paths and opt-in verbose modes are exempt; the budget is
  about what every routine invocation pays.
- **Digest + artifact path.** When a script produces a large result (a full
  envelope, a per-phase result object, a report), it MUST write the full
  payload to an on-disk artifact (under `temp/`, or an operator-named
  `--out` path) and emit a **compact machine-parseable digest** on stdout
  that names the artifact path plus the handful of fields the caller acts
  on. The shared helper
  [`lib/observability/terse-result.js`](../scripts/lib/observability/terse-result.js)
  (`emitTerseResult`, Story #4685) implements this for hot-path result
  dumps; `plan-context.js --out` shows the envelope-capture variant.
- **Compact JSON.** Machine-parsed stdout envelopes are `JSON.parse`d by
  their drivers — emit them single-line (`JSON.stringify(x)`), never
  pretty-printed (`null, 2` only adds resident bytes). Pretty output is
  reserved for explicit opt-in flags (`--pretty`).
- **Streamed child output counts too (Story #4736).** A script that pipes a
  child process's stdout/stderr through to the caller is emitting that output
  as its own. `single-story-close.js` streamed every close-validation gate —
  the whole of `npm test` included — and blew the budget by ~25× on a *passing*
  close. Capture it to an artifact instead
  ([`single-story-close/gate-log.js`](../scripts/lib/orchestration/single-story-close/gate-log.js)),
  emit the digest, and **replay the tail inline on failure** — the bound is a
  success-path bound, and a red gate's evidence belongs in front of the caller.
- **Escape hatch.** `MANDREL_RESULT_DETAIL=inline` restores inline full
  detail for interactive debugging; scripts using `emitTerseResult` honor it
  automatically. `AGENT_LOG_LEVEL=verbose` restores live gate streaming.
- **stdout purity is unchanged.** Scripts whose stdout is a machine contract
  (Story #2278) keep logs on stderr; the digest is the *only* stdout line.
