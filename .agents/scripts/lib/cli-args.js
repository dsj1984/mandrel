import { parseArgs } from 'node:util';

/**
 * Parse a single ticket-ID-style value. Strips an optional leading `#`,
 * coerces to a positive integer, and returns `null` for anything invalid.
 *
 * Shared by every CLI that accepts `--epic`, `--story`, `--task`, `--recut-of`,
 * or a ticket positional, so the `Number.parseInt(..., 10)` + `# ` prefix dance lives
 * in exactly one place.
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
 * Coerce a value returned by `node:util`'s `parseArgs` for a boolean flag into
 * a real boolean. Under `strict: false`, `--flag=true` / `--flag=false` arrive
 * here as the literal strings `'true'` / `'false'`, while bare `--flag` lands
 * as `true`. Absence yields `undefined`, which collapses to `false`.
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
 * Parse a positive-integer flag, preserving `undefined` when the flag is
 * absent so a caller can distinguish "not supplied" (fall back to config)
 * from an explicit value. A non-numeric or non-positive value is treated as
 * absent rather than coerced to 0 — a `--max-wait-seconds=abc` typo must not
 * silently become a zero-second wait.
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
 * The same contract for a flag whose ZERO is meaningful (Story #5266):
 * `--rerun-advisory 0` is an explicit "spend nothing", not an absent flag.
 * A negative or non-numeric value is still treated as absent rather than
 * coerced, so a typo falls back to the config default instead of inventing an
 * allowance that spends the consumer's CI minutes.
 *
 * @param {unknown} value
 * @returns {number|undefined}
 */
function parseNonNegativeInt(value) {
  if (value === undefined || value === null) return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** The only two merge-watch postures `--merge-watch-mode` accepts. */
const MERGE_WATCH_MODES = ['sync', 'async'];

/**
 * Parse `--merge-watch-mode` (Story #4949), the per-invocation override of
 * `delivery.mergeWatch.mode`. Absence is preserved as `undefined` so the
 * caller can distinguish "not supplied" (fall back to config) from an explicit
 * posture — the same contract {@link parsePositiveInt} gives
 * `--max-wait-seconds`.
 *
 * Unlike that sibling, an unrecognized value **throws** rather than degrading
 * to absent. A `--max-wait-seconds` typo falls back to a sane bound; a
 * `--merge-watch-mode` typo would fall back to `sync` and silently return a
 * multi-Story run to a serialized foreground wait per close, with the wall
 * clock as the only evidence. Parsing runs before the first close phase, so
 * failing here costs no mutation.
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
 * {@link parseMergeWatchMode} degraded to the "absent" value instead of
 * throwing — how the tolerant parse below treats a flag that failed
 * validation. Reporting `undefined` is safe there and only there, because a
 * tolerant parse never drives a pipeline: its caller surfaces the rejection
 * as the run's failure and runs no phase at all.
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

/**
 * Shortest override reason that can plausibly name a rejected finding. Below
 * this, the flag is being used to silence the gate rather than to record a
 * judgement, which is the failure mode the reason requirement exists to stop.
 */
const MIN_OVERRIDE_REASON_LENGTH = 12;

/**
 * Parse `--override-review-block <reason>` — the sanctioned,
 * logged override of a Story-scope code-review critical blocker.
 *
 * The reason is **mandatory and validated**, because the alternative it
 * replaces is not "no override" but `gh pr merge` run by hand: before this
 * flag, a review blocker the operator had reviewed and rejected left bypassing
 * the gate entirely as the only way to land, and that bypass wrote nothing
 * down anywhere. An override that records why is strictly more auditable than
 * the hand-merge it displaces; an override that records nothing is not, so a
 * bare or blank `--override-review-block` fails closed here — before any phase
 * runs, at no mutation cost — rather than arming a silent one.
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
 * {@link parseOverrideReviewBlock} degraded to absent instead of throwing, for
 * the tolerant reporting parse. Same contract as
 * {@link tolerantMergeWatchMode}: safe only because a tolerant parse runs no
 * phase.
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
 * Standardized CLI argument parser for sprint scripts.
 * Supports options like --epic, --story, --dry-run, --skip-dashboard.
 *
 * Throws when a *validating* parser rejects a flag value (currently only
 * `--merge-watch-mode`). Callers that must not throw — an error handler
 * needing `storyId` to report an envelope — use {@link parseSprintArgsTolerant}
 * rather than calling this a second time inside their own catch.
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
      // Story #4543 — per-run override of `delivery.mergeWatch.maxWaitSeconds`
      // (the merge wait's per-invocation bound). Absent means "use the config".
      'max-wait-seconds': { type: 'string' },
      // Story #4949 — per-invocation override of `delivery.mergeWatch.mode`.
      // Absent means "use the config"; see `parseMergeWatchMode` for why an
      // unrecognized value fails closed instead of degrading to absent.
      'merge-watch-mode': { type: 'string' },
      // Story #5266 — per-invocation override of `delivery.ci.rerunAdvisory`.
      // Absent means "use the config", whose default is 0: close re-runs
      // nothing and mutates no GitHub state on an advisory red unless asked.
      'rerun-advisory': { type: 'string' },
      // Sanctioned override of a code-review critical blocker.
      // Absent means "the blocker blocks"; see `parseOverrideReviewBlock` for
      // why a bare or too-short reason fails closed instead of arming a silent
      // override.
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
    // Close-and-land: `--wait-merge` forces land-in-close; `--no-wait-merge`
    // opts out. When neither flag is present (`undefined`),
    // `parseCloseOptions` applies `delivery.routing.closeAndLand` (default
    // true) so attended and headless delivers share the same happy path.
    waitForMerge: optionalBooleanFlag(values['wait-merge']),
    noWaitForMerge: coerceBooleanFlag(values['no-wait-merge']),
    // Story #4543 — raise the merge wait's per-invocation bound for a
    // headless caller with no host tool-invocation ceiling, so it lands in
    // one block instead of returning `pending` at the default 300s.
    maxWaitSeconds: parsePositiveInt(values['max-wait-seconds']),
    // Story #4949 — per-invocation override of `delivery.mergeWatch.mode`.
    // `undefined` when the flag is absent, which is what lets the merge wait
    // fall back to the config; anything unrecognized throws here.
    mergeWatchMode: tolerant
      ? tolerantMergeWatchMode(values['merge-watch-mode'])
      : parseMergeWatchMode(values['merge-watch-mode']),
    // Story #5266 — how many times close may re-run a failed ADVISORY run
    // before blocking on it. `undefined` when absent, which is what lets the
    // merge wait fall back to `delivery.ci.rerunAdvisory` (default 0).
    // `parseNonNegativeInt` degrades a junk value to undefined rather than
    // guessing an allowance that would spend the consumer's CI minutes.
    rerunAdvisory: parseNonNegativeInt(values['rerun-advisory']),
    // The operator's recorded reason for overriding a review
    // blocker. `undefined` when the flag is absent, which is what keeps the
    // blocker blocking by default.
    overrideReviewBlock: tolerant
      ? tolerantOverrideReviewBlock(values['override-review-block'])
      : parseOverrideReviewBlock(values['override-review-block']),
    executor: values.executor ?? null,
    // Resolve worktree cwd from flag or env. Empty string/whitespace → null.
    cwd:
      (typeof values.cwd === 'string' && values.cwd.trim()) ||
      process.env.AGENT_WORKTREE_ROOT ||
      null,
    recutOf: parseTicketId(values['recut-of']),
    // Story #4253: pre-resolved Epic linkage threaded by the /mandrel-deliver
    // fan-out so `single-story-init.js` can skip redundant Epic lookups when
    // the parent already threaded Epic context (pre-v2; field retained for
    // CLI compatibility).
    resume: values.resume ?? false,
    restart: values.restart ?? false,
  };

  parsed.ticketId =
    parseTicketId(positionals[0]) ?? parsed.storyId ?? parsed.epicId ?? null;

  return parsed;
}

/**
 * Last-resort tolerant parse: the fields, or an empty bag if even the
 * tolerant pass cannot produce one.
 *
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
 * Parse argv **without ever throwing**, returning the fields alongside the
 * rejection rather than in place of it.
 *
 * `parseSprintArgs` gained its first *validating* parser in
 * {@link parseMergeWatchMode} (Story #4949), which made a latent shape in the
 * CLI entries fatal: their catch blocks called
 * `failedTerminalFor(err, parseSprintArgs())` — re-invoking the very parser
 * that had just thrown. The second throw escaped the catch, so an
 * unparseable argv produced a bare stack trace with **no terminal envelope
 * and no friction signal**, on the two surfaces whose whole contract is that
 * they always emit one. An error handler must not depend on an operation
 * already known to fail.
 *
 * So the entries parse **once**, up front, through this wrapper: `args`
 * carries the `storyId` and skip flags the envelope is built from, and
 * `error` is the failure to report. The tolerant re-parse degrades **only**
 * the flag that failed validation; every other field parses normally. Use
 * the result to *report*, never to run a pipeline.
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

/**
 * Declarative argv parser used by every top-level script under
 * `.agents/scripts/`. Replaces the hand-rolled `parseCliArgs` walkers that
 * the `tests/enforcement/parse-cli-args.test.js` enforcement gate forbids.
 *
 * Spec entry shape:
 *   { type, alias?, default?, envKey?, optionalValue?, short? }
 *
 *   - `type`: 'boolean' | 'ticket' | 'integer' | 'string' | 'string-multi'.
 *     'ticket' coerces via `parseTicketId` (positive int, leading `#` stripped,
 *     `null` for invalid). 'integer' coerces via `Number()` (NaN on garbage).
 *   - `alias`: output key on `values`. Defaults to camel-cased flag name.
 *   - `default`: applied when no value was provided AND no envKey produced
 *     one. For 'ticket' the default fires when the parsed value is null.
 *   - `envKey`: env-var fallback, used only when the flag is absent and the
 *     env value is a non-empty string.
 *   - `optionalValue`: value to assign when the flag is present without a
 *     value (i.e. EOF or the next token is another `--flag`).
 *   - `short`: single-char short flag (e.g. `-h`).
 *
 * @param {Record<string, object>} spec
 * @param {string[]} args  argv slice (no `process` / script entries)
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ values: Record<string, any>, positionals: string[] }}
 */
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

export function defineFlags(spec, args = [], opts = {}) {
  validateSpec(spec);
  const env = opts.env ?? process.env;
  const state = initParserState(spec);
  const positionals = parseTokens(args, spec, state);
  applyEnvFallbacks(spec, state, env);
  applyDefaults(spec, state);
  return { values: state.values, positionals };
}
