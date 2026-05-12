/**
 * Shared argv + env parsing for the baseline gates (`check-crap`,
 * `check-maintainability`, etc.). Single source of truth for the
 * `--changed-since / --full-scope / --epic-ref / --story / --epic / --json`
 * envelope and the `FRICTION_STORY_ID` / `FRICTION_EPIC_ID` env fallback.
 */

export function coercePositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Walk argv looking for `flag`; return the next token when it's not another
// flag, the `bareDefault` when the next token is missing or another flag
// (`--changed-since` → 'main'), or `null` when `flag` is absent entirely.
function readFlag(argv, flag, bareDefault = null) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) return next;
      return bareDefault;
    }
  }
  return null;
}

export function parseGateArgs(
  argv = process.argv.slice(2),
  { env = process.env, extras = {} } = {},
) {
  const storyId =
    coercePositiveInt(readFlag(argv, '--story')) ??
    coercePositiveInt(env?.FRICTION_STORY_ID ?? null);
  const epicId =
    coercePositiveInt(readFlag(argv, '--epic')) ??
    coercePositiveInt(env?.FRICTION_EPIC_ID ?? null);
  const extrasOut = {};
  for (const [key, parser] of Object.entries(extras)) {
    extrasOut[key] = typeof parser === 'function' ? parser(argv) : null;
  }
  return {
    changedSinceRef: readFlag(argv, '--changed-since', 'main'),
    fullScope: argv.includes('--full-scope'),
    epicRef: readFlag(argv, '--epic-ref'),
    storyId,
    epicId,
    jsonPath: readFlag(argv, '--json'),
    extras: extrasOut,
  };
}

/**
 * Resolve the `--changed-since` ref by layering CLI > env > config >
 * framework default ('main'). Shared between CRAP and MI so a project
 * that flips one back to `--full-scope` doesn't have to remember which
 * env names apply to which gate. `primaryEnv` / `secondaryEnv` decide
 * which env var the gate inspects first.
 */
export function resolveScopedRef({
  argv = process.argv.slice(2),
  env = process.env,
  config,
  primaryEnv,
  secondaryEnv,
}) {
  if (argv.includes('--full-scope')) {
    return { ref: null, scope: 'full', source: '--full-scope' };
  }
  const fromArgv = readFlag(argv, '--changed-since', 'main');
  if (fromArgv)
    return { ref: fromArgv, scope: 'diff', source: '--changed-since' };
  for (const name of [primaryEnv, secondaryEnv]) {
    const v = name ? env?.[name] : null;
    if (typeof v === 'string' && v.length > 0) {
      return { ref: v, scope: 'diff', source: name };
    }
  }
  if (config?.defaultScope === 'full') {
    return { ref: null, scope: 'full', source: 'config.defaultScope=full' };
  }
  if (typeof config?.diffRef === 'string' && config.diffRef.length > 0) {
    return { ref: config.diffRef, scope: 'diff', source: 'config.diffRef' };
  }
  return { ref: 'main', scope: 'diff', source: 'default' };
}
