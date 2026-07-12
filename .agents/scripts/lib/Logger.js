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
 * Level is resolved **lazily on every emit** from `AGENT_LOG_LEVEL` (or a
 * `setLevel` override). Resolving per emit — rather than once at module
 * load — lets tests exercise every level branch in-process via `setLevel`
 * or a live `AGENT_LOG_LEVEL` flip, without spawning a child process per
 * level (Story #3329):
 *
 *   - `silent`   → only `fatal` emits.
 *   - `info`     → default. Emits `info` and above; suppresses `debug`.
 *   - `verbose`  → emits everything (including `debug`).
 *   - `debug`    → alias for `verbose` (backward compatible).
 */
/**
 * Recognized log levels, lowest-noise first. Anything outside this set
 * resolves to `info`.
 *
 * @type {ReadonlySet<string>}
 */
const VALID_LEVELS = Object.freeze(
  new Set(['silent', 'info', 'verbose', 'debug']),
);

/**
 * Process-wide level override. `null` means "no explicit override — read
 * `AGENT_LOG_LEVEL` from the environment on each resolve". `setLevel`
 * pins this so tests (and embedders) can exercise every level branch
 * in-process without spawning a child whose module-load reads a different
 * env var. `setLevel(null)` clears the pin and restores env-driven
 * resolution.
 *
 * @type {string|null}
 */
let levelOverride = null;

/**
 * Resolve the active log level lazily. Honors an explicit `setLevel`
 * override first, otherwise reads `AGENT_LOG_LEVEL` from the environment
 * on every call. Resolving per emit (rather than once at module load)
 * means a test can flip `AGENT_LOG_LEVEL` — or call `setLevel` — and see
 * the level branches react in-process, without a child process per level
 * (Story #3329).
 *
 * @returns {'silent'|'info'|'verbose'|'debug'}
 */
export function resolveLevel() {
  const raw = (
    levelOverride ??
    process.env.AGENT_LOG_LEVEL ??
    ''
  ).toLowerCase();
  return VALID_LEVELS.has(raw) ? raw : 'info';
}

/**
 * Pin the process-wide log level, bypassing `AGENT_LOG_LEVEL`. Pass a
 * recognized level (`silent` / `info` / `verbose` / `debug`) to force it,
 * or `null` to clear the pin and restore env-driven resolution. An
 * unrecognized non-null value throws so callers cannot silently pin a
 * level that resolves to `info`.
 *
 * @param {('silent'|'info'|'verbose'|'debug')|null} level
 * @returns {void}
 */
export function setLevel(level) {
  if (level === null) {
    levelOverride = null;
    return;
  }
  if (typeof level !== 'string' || !VALID_LEVELS.has(level.toLowerCase())) {
    throw new RangeError(
      `setLevel: level must be one of silent|info|verbose|debug or null (got ${level})`,
    );
  }
  levelOverride = level.toLowerCase();
}

function debugEnabled() {
  const level = resolveLevel();
  return level === 'verbose' || level === 'debug';
}

function infoEnabled() {
  return resolveLevel() === 'info' || debugEnabled();
}

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
 * — for example the JSON envelope emitted by
 * `plan-context.js`, where any interleaved
 * `[Orchestrator] ℹ️ …` log line corrupts the captured file
 * (Story #2278).
 */
export function routeAllOutputToStderr() {
  infoSink = (msg) => console.error(msg);
  warnSink = (msg) => console.error(msg);
  progressStdoutSink = (msg) => console.error(msg);
}

export const Logger = {
  /**
   * The currently-resolved level. A getter (not a frozen snapshot) so it
   * reflects `setLevel` overrides and live `AGENT_LOG_LEVEL` changes —
   * reading `Logger.level` always returns what the next emit will use.
   */
  get level() {
    return resolveLevel();
  },

  debug(message) {
    if (debugEnabled()) console.error(`[Orchestrator] 🐛 ${message}`);
  },

  info(message) {
    if (infoEnabled()) infoSink(`[Orchestrator] ℹ️ ${message}`);
  },

  warn(message) {
    if (infoEnabled()) warnSink(`[Orchestrator] ⚠️ ${message}`);
  },

  error(message) {
    if (infoEnabled()) console.error(`[Orchestrator] ❌ ${message}`);
  },

  fatal(message) {
    console.error(`[Orchestrator] ❌ ${message}`);
    process.exit(1);
  },

  createProgress(scriptName, { stderr = true } = {}) {
    return (phase, message) => {
      if (!infoEnabled()) return;
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
 * caller's stdout is a structured payload (e.g. the authoring-context JSON
 * envelope from `plan-context.js`) and any
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
