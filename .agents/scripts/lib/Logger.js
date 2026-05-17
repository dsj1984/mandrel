/**
 * Logger conventions (see `docs/patterns.md` → "Error Handling Convention"):
 *
 *   - `debug`:  verbose trace; only emitted when the logger level is `verbose`.
 *   - `info`:   normal progress.
 *   - `warn`:   recoverable issue the operator should notice.
 *   - `error`:  non-fatal failure; caller continues. Use when `throw` would
 *               be too loud (e.g. best-effort cleanup paths).
 *   - `fatal`:  unrecoverable; exits the process. Use only at CLI
 *               boundaries, never inside library code.
 *
 * Level is resolved from `AGENT_LOG_LEVEL`:
 *
 *   - `silent`   → only `fatal` emits.
 *   - `info`     → default. Emits `info` and above; suppresses `debug`.
 *   - `verbose`  → emits everything (including `debug`).
 *   - `debug`    → alias for `verbose` (backward compatible).
 */
const RAW_LEVEL = (process.env.AGENT_LOG_LEVEL ?? '').toLowerCase();
const LEVEL =
  RAW_LEVEL === 'silent' ||
  RAW_LEVEL === 'info' ||
  RAW_LEVEL === 'verbose' ||
  RAW_LEVEL === 'debug'
    ? RAW_LEVEL
    : 'info';

const DEBUG_ENABLED = LEVEL === 'verbose' || LEVEL === 'debug';
const INFO_ENABLED = LEVEL === 'info' || DEBUG_ENABLED;
const WARN_ENABLED = INFO_ENABLED;
const ERROR_ENABLED = INFO_ENABLED;

// Mutable sinks for `info` (defaults to stdout via console.log) and the
// stdout branch of `createProgress` (defaults to console.log). `warn` already
// uses console.warn which Node routes to stderr, but we expose a sink for it
// too so a single `routeAllOutputToStderr()` call gives a uniform guarantee
// to callers that "no Logger output lands on stdout" (Story #2278).
let infoSink = (msg) => console.log(msg);
let warnSink = (msg) => console.warn(msg);
let progressStdoutSink = (msg) => console.log(msg);

/**
 * Flip every Logger output that can land on stdout (`info`, `warn`, and the
 * stdout branch of `createProgress`) to stderr for the lifetime of the
 * process. Idempotent. Use when stdout is reserved for a structured payload
 * — for example the `--emit-context` JSON envelopes emitted by
 * `epic-plan-spec.js` and `epic-plan-decompose.js`, where any interleaved
 * `[Orchestrator] ℹ️ …` log line corrupts the captured file
 * (Story #2278).
 */
export function routeAllOutputToStderr() {
  infoSink = (msg) => console.error(msg);
  warnSink = (msg) => console.error(msg);
  progressStdoutSink = (msg) => console.error(msg);
}

export const Logger = {
  level: LEVEL,

  debug(message) {
    if (DEBUG_ENABLED) console.error(`[Orchestrator] 🐛 ${message}`);
  },

  info(message) {
    if (INFO_ENABLED) infoSink(`[Orchestrator] ℹ️ ${message}`);
  },

  warn(message) {
    if (WARN_ENABLED) warnSink(`[Orchestrator] ⚠️ ${message}`);
  },

  error(message) {
    if (ERROR_ENABLED) console.error(`[Orchestrator] ❌ ${message}`);
  },

  fatal(message) {
    console.error(`[Orchestrator] ❌ ${message}`);
    process.exit(1);
  },

  createProgress(scriptName, { stderr = true } = {}) {
    return (phase, message) => {
      if (!INFO_ENABLED) return;
      const line = `▶ [${scriptName}] [${phase}] ${message}`;
      if (stderr) console.error(line);
      else progressStdoutSink(line);
    };
  },
};

/**
 * Frozen no-op logger shaped like the public `Logger` surface (minus `fatal`,
 * which must never be silenced — silencing process-exit is a footgun). Use
 * this as the default-argument value when a function accepts an optional
 * logger; consumers that don't pass one get a uniform shape without each
 * call site re-declaring its own inline literal.
 *
 * Deliberately omits `fatal` so that any code path tempted to call
 * `logger.fatal(...)` against the no-op fails loudly rather than silently
 * skipping a process-exit that would otherwise have surfaced an
 * unrecoverable error.
 */
export const NOOP_LOGGER = Object.freeze({
  silent: true,
  debug() {},
  info() {},
  warn() {},
  error() {},
});

/**
 * Frozen logger that routes every level to **stderr**. Use this when a
 * caller's stdout is a structured payload (e.g. `--emit-context` JSON
 * envelopes from `epic-plan-spec.js` / `epic-plan-decompose.js`) and any
 * progress/telemetry log must not interleave with the payload. Mirrors the
 * `{ info, warn, error, debug }` shape that the orchestration helpers
 * accept via optional `logger` arguments.
 */
export const STDERR_LOGGER = Object.freeze({
  debug: (message) => console.error(message),
  info: (message) => console.error(message),
  warn: (message) => console.error(message),
  error: (message) => console.error(message),
});
