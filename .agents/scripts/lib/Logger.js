/**
 * `error` is non-fatal (the caller continues); `fatal` exits and belongs only
 * at CLI boundaries. The level (`silent` = fatal only, `info` default,
 * `verbose` adds debug) is resolved from `AGENT_LOG_LEVEL` on every emit, not
 * at load, so tests can flip it in-process.
 */
/**
 * Anything else resolves to `info`.
 *
 * @type {ReadonlySet<string>}
 */
const VALID_LEVELS = Object.freeze(new Set(['silent', 'info', 'verbose']));

/**
 * `null` means read `AGENT_LOG_LEVEL` on each resolve.
 *
 * @type {string|null}
 */
let levelOverride = null;

/**
 * @returns {'silent'|'info'|'verbose'}
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
 * Pin the level (`null` clears it). An unrecognized value throws rather than
 * silently pinning `info`.
 *
 * @param {('silent'|'info'|'verbose')|null} level
 * @returns {void}
 */
export function setLevel(level) {
  if (level === null) {
    levelOverride = null;
    return;
  }
  if (typeof level !== 'string' || !VALID_LEVELS.has(level.toLowerCase())) {
    throw new RangeError(
      `setLevel: level must be one of silent|info|verbose or null (got ${level})`,
    );
  }
  levelOverride = level.toLowerCase();
}

function debugEnabled() {
  return resolveLevel() === 'verbose';
}

function infoEnabled() {
  return resolveLevel() === 'info' || debugEnabled();
}

// Swappable so `routeAllOutputToStderr()` can guarantee nothing hits stdout.
let infoSink = (msg) => console.log(msg);
let warnSink = (msg) => console.warn(msg);
let progressStdoutSink = (msg) => console.log(msg);

/** For processes whose stdout is a structured payload. Idempotent. */
export function routeAllOutputToStderr() {
  infoSink = (msg) => console.error(msg);
  warnSink = (msg) => console.error(msg);
  progressStdoutSink = (msg) => console.error(msg);
}

export const Logger = {
  /** A getter, so it always reports what the next emit will use. */
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
 * Default for an optional logger. Omits `fatal` deliberately: a silenced
 * process-exit would hide an unrecoverable error, so calling it throws.
 */
export const NOOP_LOGGER = Object.freeze({
  silent: true,
  debug() {},
  info() {},
  warn() {},
  error() {},
});

/** Every level to stderr, for callers whose stdout is a structured payload. */
export const STDERR_LOGGER = Object.freeze({
  debug: (message) => console.error(message),
  info: (message) => console.error(message),
  warn: (message) => console.error(message),
  error: (message) => console.error(message),
});
