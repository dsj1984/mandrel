import { parseArgs } from 'node:util';

/**
 * Positive integer with an optional leading `#`; `null` when invalid.
 *
 * @param {string|number|null|undefined} value
 * @returns {number|null}
 */
export function parseTicketId(value) {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'number' ? String(value) : value.toString();
  const cleaned = raw.replace(/^#/, '').trim();
  if (cleaned === '') return null;
  const n = Number.parseInt(cleaned, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Under `strict: false`, `--flag=false` arrives as the string `'false'`.
 *
 * @param {boolean|string|null|undefined} value
 * @returns {boolean}
 */
function coerceBooleanFlag(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'false' || lowered === '0' || lowered === '') return false;
    return true;
  }
  return Boolean(value);
}

/** Like coerceBooleanFlag, but preserves `undefined` (flag absent). */
function optionalBooleanFlag(value) {
  if (value === undefined) return undefined;
  return coerceBooleanFlag(value);
}

/**
 * `undefined` when absent (caller falls back to config). Junk is treated as
 * absent, never coerced to 0.
 *
 * @param {unknown} value
 * @returns {number|undefined}
 */
function parsePositiveInt(value) {
  if (value === undefined || value === null) return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * As {@link parsePositiveInt}, for a flag whose zero is meaningful.
 *
 * @param {unknown} value
 * @returns {number|undefined}
 */
function parseNonNegativeInt(value) {
  if (value === undefined || value === null) return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

const MERGE_WATCH_MODES = ['sync', 'async'];

/**
 * `undefined` when absent. An unrecognized value throws: degrading to `sync`
 * would silently serialize a multi-Story run. Runs before any mutation.
 *
 * @param {unknown} value
 * @returns {'sync'|'async'|undefined}
 */
export function parseMergeWatchMode(value) {
  if (value == null) return undefined;
  const mode = String(value).trim().toLowerCase();
  if (MERGE_WATCH_MODES.includes(mode)) return mode;
  throw new Error(
    `--merge-watch-mode must be one of ${MERGE_WATCH_MODES.join('|')} (got "${value}")`,
  );
}

/**
 * Non-throwing variant; safe only because a tolerant parse runs no phase.
 *
 * @param {unknown} value
 * @returns {'sync'|'async'|undefined}
 */
function tolerantMergeWatchMode(value) {
  try {
    return parseMergeWatchMode(value);
  } catch {
    return undefined;
  }
}

/** Shorter than this, the reason silences the gate rather than records why. */
const MIN_OVERRIDE_REASON_LENGTH = 12;

/**
 * The logged override of a code-review critical blocker. The reason is
 * mandatory: a bare flag throws before any phase rather than arming a silent
 * override.
 *
 * @param {unknown} value
 * @returns {string|undefined} the trimmed reason, or `undefined` when absent.
 */
export function parseOverrideReviewBlock(value) {
  if (value == null) return undefined;
  // `parseArgs` with `strict: false` yields `true` for a bare string flag.
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length >= MIN_OVERRIDE_REASON_LENGTH) return reason;
  throw new Error(
    '--override-review-block requires a reason of at least ' +
      `${MIN_OVERRIDE_REASON_LENGTH} characters naming the finding you reviewed ` +
      `and rejected (got ${JSON.stringify(value)}). The reason is posted to the ` +
      'PR and the Story and recorded as friction telemetry.',
  );
}

/**
 * Non-throwing variant, as {@link tolerantMergeWatchMode}.
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
function tolerantOverrideReviewBlock(value) {
  try {
    return parseOverrideReviewBlock(value);
  } catch {
    return undefined;
  }
}

/**
 * Throws when a validating flag parser rejects a value; error handlers use
 * {@link parseSprintArgsTolerant} instead of re-calling this.
 *
 * @param {string[]} args Array of arguments (defaults to process.argv)
 * @param {{ tolerant?: boolean }} [options] `tolerant` degrades a rejected
 *   flag to its absent value instead of throwing. For reporting only.
 * @returns {object} Parsed and typed argument values
 */
export function parseSprintArgs(
  args = process.argv,
  { tolerant = false } = {},
) {
  const { values, positionals } = parseArgs({
    args: args.slice(2),
    options: {
      epic: { type: 'string', short: 'e' },
      story: { type: 'string', short: 's' },
      'dry-run': { type: 'boolean', default: false },
      'skip-dashboard': { type: 'boolean', default: false },
      'skip-validation': { type: 'boolean', default: false },
      'skip-sync': { type: 'boolean', default: false },
      'no-auto-merge': { type: 'boolean', default: false },
      // No default — absent means "use delivery.routing.closeAndLand".
      'wait-merge': { type: 'boolean' },
      'no-wait-merge': { type: 'boolean', default: false },
      // The next three override `delivery.*` config when present.
      'max-wait-seconds': { type: 'string' },
      'merge-watch-mode': { type: 'string' },
      'rerun-advisory': { type: 'string' },
      'override-review-block': { type: 'string' },
      executor: { type: 'string' },
      cwd: { type: 'string' },
      'recut-of': { type: 'string' },
      resume: { type: 'boolean', default: false },
      restart: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const parsed = {
    epicId: parseTicketId(values.epic),
    storyId: parseTicketId(values.story),
    ticketId: null,
    dryRun: values['dry-run'] ?? false,
    skipDashboard: values['skip-dashboard'] ?? false,
    skipValidation: coerceBooleanFlag(values['skip-validation']),
    skipSync: coerceBooleanFlag(values['skip-sync']),
    noAutoMerge: coerceBooleanFlag(values['no-auto-merge']),
    // `undefined` when neither flag is present: config `closeAndLand` decides.
    waitForMerge: optionalBooleanFlag(values['wait-merge']),
    noWaitForMerge: coerceBooleanFlag(values['no-wait-merge']),
    maxWaitSeconds: parsePositiveInt(values['max-wait-seconds']),
    mergeWatchMode: tolerant
      ? tolerantMergeWatchMode(values['merge-watch-mode'])
      : parseMergeWatchMode(values['merge-watch-mode']),
    rerunAdvisory: parseNonNegativeInt(values['rerun-advisory']),
    overrideReviewBlock: tolerant
      ? tolerantOverrideReviewBlock(values['override-review-block'])
      : parseOverrideReviewBlock(values['override-review-block']),
    executor: values.executor ?? null,
    cwd:
      (typeof values.cwd === 'string' && values.cwd.trim()) ||
      process.env.AGENT_WORKTREE_ROOT ||
      null,
    recutOf: parseTicketId(values['recut-of']),
    resume: values.resume ?? false,
    restart: values.restart ?? false,
  };

  parsed.ticketId =
    parseTicketId(positionals[0]) ?? parsed.storyId ?? parsed.epicId ?? null;

  return parsed;
}

/**
 * @param {string[]} args
 * @returns {object}
 */
function parseSprintArgsOrEmpty(args) {
  try {
    return parseSprintArgs(args, { tolerant: true });
  } catch {
    return {};
  }
}

/**
 * Never throws: returns the fields alongside the rejection, so an entry's
 * error handler can still build its terminal envelope. Only the failing flag
 * degrades. Use the result to report, never to run a pipeline.
 *
 * @param {string[]} [args] Array of arguments (defaults to `process.argv`)
 * @returns {{ args: object, error: Error|null }}
 */
export function parseSprintArgsTolerant(args = process.argv) {
  try {
    return { args: parseSprintArgs(args), error: null };
  } catch (error) {
    return { args: parseSprintArgsOrEmpty(args), error };
  }
}

const SUPPORTED_FLAG_TYPES = new Set([
  'boolean',
  'ticket',
  'integer',
  'string',
  'string-multi',
]);

function camelCase(name) {
  return name.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
}

function initialValueFor(type) {
  if (type === 'boolean') return false;
  if (type === 'string-multi') return [];
  if (type === 'ticket') return null;
  return undefined;
}

function coerceValue(type, raw) {
  if (type === 'string') return raw;
  if (type === 'ticket') return parseTicketId(raw);
  if (type === 'integer') return Number(raw);
  return raw;
}

function validateSpec(spec) {
  for (const [name, def] of Object.entries(spec)) {
    if (!SUPPORTED_FLAG_TYPES.has(def.type)) {
      throw new Error(
        `defineFlags: unsupported type "${def.type}" for flag "${name}"`,
      );
    }
  }
}

function initParserState(spec) {
  const values = {};
  const keyOf = {};
  const shortMap = {};
  for (const [name, def] of Object.entries(spec)) {
    const key = def.alias ?? camelCase(name);
    keyOf[name] = key;
    values[key] = initialValueFor(def.type);
    if (def.short) shortMap[def.short] = name;
  }
  return { values, keyOf, shortMap };
}

function classifyToken(tok, shortMap) {
  if (tok.startsWith('--')) {
    const eq = tok.indexOf('=');
    if (eq >= 0)
      return { flagName: tok.slice(2, eq), inlineValue: tok.slice(eq + 1) };
    return { flagName: tok.slice(2), inlineValue: null };
  }
  if (tok.startsWith('-') && tok.length > 1) {
    const candidate = shortMap[tok.slice(1)];
    if (candidate) return { flagName: candidate, inlineValue: null };
  }
  return { flagName: null, inlineValue: null };
}

function assignFlagValue(values, key, def, raw) {
  if (def.type === 'string-multi') {
    values[key] = [...(values[key] ?? []), raw];
  } else {
    values[key] = coerceValue(def.type, raw);
  }
}

function readValuedFlag(args, i, inlineValue, def, values, key) {
  if (inlineValue !== null) {
    assignFlagValue(values, key, def, inlineValue);
    return i + 1;
  }
  const next = args[i + 1];
  const missing =
    next === undefined || (typeof next === 'string' && next.startsWith('--'));
  if (missing) {
    if (def.optionalValue !== undefined) values[key] = def.optionalValue;
    return i + 1;
  }
  assignFlagValue(values, key, def, next);
  return i + 2;
}

function parseTokens(args, spec, state) {
  const { values, keyOf, shortMap } = state;
  const positionals = [];
  let i = 0;
  while (i < args.length) {
    const tok = args[i];
    if (typeof tok !== 'string') {
      i += 1;
      continue;
    }
    if (tok === '--') {
      for (let j = i + 1; j < args.length; j += 1) positionals.push(args[j]);
      break;
    }
    const { flagName, inlineValue } = classifyToken(tok, shortMap);
    if (!flagName) {
      positionals.push(tok);
      i += 1;
      continue;
    }
    const def = spec[flagName];
    if (!def) {
      i += 1;
      continue;
    }
    const key = keyOf[flagName];
    if (def.type === 'boolean') {
      values[key] = true;
      i += 1;
      continue;
    }
    i = readValuedFlag(args, i, inlineValue, def, values, key);
  }
  return positionals;
}

function isAbsentValue(def, cur) {
  if (def.type === 'ticket') return cur === null;
  if (def.type === 'string-multi') return cur.length === 0;
  return cur === undefined;
}

function applyEnvFallbacks(spec, state, env) {
  const { values, keyOf } = state;
  for (const [name, def] of Object.entries(spec)) {
    if (!def.envKey) continue;
    const envRaw = env?.[def.envKey];
    if (typeof envRaw !== 'string' || envRaw.length === 0) continue;
    const key = keyOf[name];
    if (!isAbsentValue(def, values[key])) continue;
    if (def.type === 'string-multi') values[key] = [envRaw];
    else values[key] = coerceValue(def.type, envRaw);
  }
}

function applyDefaults(spec, state) {
  const { values, keyOf } = state;
  for (const [name, def] of Object.entries(spec)) {
    if (!('default' in def)) continue;
    const key = keyOf[name];
    const cur = values[key];
    const absent = def.type === 'ticket' ? cur === null : cur === undefined;
    if (absent) values[key] = def.default;
  }
}

/**
 * Declarative argv parser for every top-level script. Spec entry:
 * `{ type, alias?, default?, envKey?, optionalValue?, short? }` — `alias`
 * defaults to the camel-cased flag; `envKey` applies only when the flag is
 * absent; `default` after that; `optionalValue` when the flag has no value.
 *
 * @param {Record<string, object>} spec
 * @param {string[]} args  argv slice (no `process` / script entries)
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ values: Record<string, any>, positionals: string[] }}
 */
export function defineFlags(spec, args = [], opts = {}) {
  validateSpec(spec);
  const env = opts.env ?? process.env;
  const state = initParserState(spec);
  const positionals = parseTokens(args, spec, state);
  applyEnvFallbacks(spec, state, env);
  applyDefaults(spec, state);
  return { values: state.values, positionals };
}
