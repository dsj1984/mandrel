/**
 * lib/test-isolate/cli-options.js — argv → options for the `test-isolate` CLI.
 *
 * Story #5316: this lived inside `.agents/scripts/test-isolate.js`, a file no
 * test imports, so it scored the CRAP formula's untested maximum (210 at
 * cyclomatic 14 and 0% coverage) and carried the tree's `test-isolate.js`
 * cyclomatic breach row. It sits here beside `list-files.js`, `parse-tap.js`
 * and `runner.js` for the same reason they do: the CLI shell is unreachable
 * from a test, and everything reachable belongs under `lib/`.
 *
 * The long `else if` ladder it replaces was cyclomatic 14, above the repo's
 * must-fix ceiling of 12. Dispatching through two flag tables is the same
 * parse — same precedence, same tolerance for a value-taking flag that ends
 * the argv — at roughly half the branch count.
 */

/**
 * Flags that consume the following argv entry as a number, keyed by the
 * option each one sets.
 */
const NUMERIC_FLAGS = {
  '--workers': 'workers',
  '--max-bisect-depth': 'maxBisectDepth',
  '--max-bisect-targets': 'maxBisectTargets',
  '--suite-concurrency': 'suiteConcurrency',
};

/** Flags that are their own value. */
const BOOLEAN_FLAGS = {
  '--json': 'json',
  '--quiet': 'quiet',
};

/**
 * Defaults every parse starts from. Deliberately module-private: nothing in
 * production reads it, and exporting it so a test could assert against it
 * would both make that test tautological and land a test-only export on the
 * `dead-exports:production` ratchet.
 */
function defaultOptions() {
  return {
    pattern: undefined,
    workers: undefined,
    maxBisectDepth: 8,
    maxBisectTargets: 5,
    suiteConcurrency: 8,
    json: false,
    quiet: false,
  };
}

/**
 * Parse the `test-isolate` CLI's argv.
 *
 * Precedence, unchanged from the ladder this replaces:
 *   - a known numeric flag consumes the next entry, but only when there IS a
 *     next entry — a trailing `--workers` is ignored rather than setting NaN;
 *   - a known boolean flag sets its option;
 *   - the FIRST non-flag argument becomes the pattern, and later ones are
 *     ignored;
 *   - anything else is ignored, so an unknown `--flag` is never mistaken for
 *     the pattern.
 *
 * @param {string[]} [argv]
 * @returns {{
 *   pattern: string|undefined,
 *   workers: number|undefined,
 *   maxBisectDepth: number,
 *   maxBisectTargets: number,
 *   suiteConcurrency: number,
 *   json: boolean,
 *   quiet: boolean,
 * }}
 */
export function parseIsolateArgv(argv = []) {
  const options = defaultOptions();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const numericKey = NUMERIC_FLAGS[arg];
    if (numericKey && argv[i + 1]) {
      options[numericKey] = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    const booleanKey = BOOLEAN_FLAGS[arg];
    if (booleanKey) {
      options[booleanKey] = true;
      continue;
    }
    if (!arg.startsWith('--') && !options.pattern) options.pattern = arg;
  }
  return options;
}
