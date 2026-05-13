/**
 * push-hook-parity — refuse-and-print check.
 *
 * Detects when the pre-push gates (biome check, MI gate) would fail at
 * `git push` time, BEFORE merge commits land. Biome check and the MI
 * gate fire at push time (not lint time), so an apparently-clean commit
 * cascade can still get stuck at the actual push step.
 *
 * Surface: `/diagnose` CLI. The gates execute against HEAD in dry-run
 * mode (no working-tree mutation) and report pass/fail. This check is
 * intentionally scoped to `diagnose` rather than `story-close` because:
 *
 *   - story-close already runs the full validation chain (typecheck,
 *     lint, test, format, MI, coverage, crap) against the worktree. The
 *     gates are part of that chain. Running them twice in preflight is
 *     wasteful.
 *   - /diagnose is the surface where the operator wants a fast pre-push
 *     verdict ("would this commit pass the push hook?"). That's exactly
 *     what this check answers.
 *
 * The gate runs live in `state.js`'s `gates.*` projection so they are
 * memoized by `(scope, cwd)` and the heavy spawn cost is paid at most
 * once per assembly. Tests inject a fake `gates` probe to drive the
 * specific pass/fail scenarios without spawning real binaries.
 *
 * AutoCorrect is `refuse-and-print`. The fix is "run the gate locally
 * and address its findings" — there is no safe auto-fix because we
 * cannot mutate the working tree to satisfy MI baseline regressions
 * without making domain decisions about which file to touch.
 */

const ID = 'push-hook-parity';

export default {
  id: ID,
  severity: 'blocker',
  scope: ['diagnose'],
  autoCorrect: 'refuse-and-print',
  detect(state) {
    const gates = state?.gates ?? {};
    const biome = gates.biome;
    const miGate = gates.miGate;
    // If neither gate ran (state.js was assembled for a scope without
    // gates.* keys), the check has nothing to say. Returning null avoids
    // a false positive when the consumer happens to share state across
    // scopes.
    if (!biome && !miGate) return null;
    const failed = [];
    if (biome && !biome.ok)
      failed.push({ name: 'biome', output: biome.output });
    if (miGate && !miGate.ok)
      failed.push({ name: 'miGate', output: miGate.output });
    if (failed.length === 0) return null;
    const failedNames = failed.map((f) => f.name).join(' + ');
    const detailLines = failed.map(
      (f) => `  - ${f.name}:\n${indent(f.output ?? '(no output)')}`,
    );
    return {
      id: ID,
      severity: 'blocker',
      scope: state?.scope ?? '',
      summary: `pre-push gate(s) would fail at push time: ${failedNames}`,
      detail: [
        'These gates run on `git push`, not on `git commit`, so the working',
        'tree looks clean but the push will be rejected. Resolve before merging:',
        '',
        ...detailLines,
      ].join('\n'),
      fixCommand: buildFixCommand(failed.map((f) => f.name)),
      autoCorrectable: false,
    };
  },
};

/**
 * Build the literal command(s) the operator should run locally to see the
 * same failure the push hook would surface. Each gate has its own canonical
 * invocation; chaining with `&&` lets the operator copy-paste the whole
 * recipe as one line.
 *
 * @param {string[]} gateNames
 * @returns {string}
 */
function buildFixCommand(gateNames) {
  const recipes = {
    biome: 'npx biome check .',
    miGate: 'npm run check:maintainability',
  };
  return gateNames
    .map((g) => recipes[g] ?? `# unknown gate: ${g}`)
    .join(' && ');
}

/**
 * Indent every line of `text` by two spaces so multi-line gate output
 * renders cleanly inside the bullet list in `detail`.
 *
 * @param {string} text
 * @returns {string}
 */
function indent(text) {
  return String(text)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}
