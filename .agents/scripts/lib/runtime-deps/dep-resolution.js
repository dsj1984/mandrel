/**
 * runtime-deps/dep-resolution — is a declared runtime dependency present and
 * the right major. Deps resolve from the consumer's `node_modules`, so a
 * declared range is only enforced by comparing it to what resolved.
 * Major-only and semver-free on purpose: every range is `^`, and a semver
 * dependency would grow the very closure this guards.
 *
 * @module lib/runtime-deps/dep-resolution
 */

/**
 * Anything not `<major>.`-shaped yields `null` (not range-checked): a
 * conservative miss is a no-op, a false positive blocks a working install.
 *
 * @param {string|null|undefined} spec
 * @returns {number|null}
 */
function majorOf(spec) {
  if (typeof spec !== 'string') return null;
  const match = /^[\^~]?(\d+)\./.exec(spec.trim());
  return match ? Number(match[1]) : null;
}

/**
 * `false` when either side is unreadable. `0.x` minors are not separated —
 * accepted, since the range this enforces is `@babel/parser`'s `^7`.
 *
 * @param {string|null|undefined} range
 * @param {string|null|undefined} resolved
 * @returns {boolean}
 */
function majorMismatch(range, resolved) {
  const want = majorOf(range);
  if (want === null) return false;
  const got = majorOf(resolved);
  if (got === null) return false;
  return want !== got;
}

/**
 * Falls back to `<name>/package.json`: a package with no `main`/`exports`
 * cannot be resolved by name, and reporting it missing would exit the process.
 *
 * @param {string} dep
 * @param {(specifier: string) => string} resolve
 * @returns {boolean}
 */
export function isResolvable(dep, resolve) {
  try {
    resolve(dep);
    return true;
  } catch {
    // fall through to the manifest probe
  }
  try {
    resolve(`${dep}/package.json`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Distinct from the missing-deps message: reinstalling changes nothing, only
 * the consumer can pin a compatible major.
 *
 * @param {{name: string, required: string, resolved: string}[]} mismatched
 * @param {{ root: string }} ctx
 * @returns {string}
 */
export function formatMismatchedDepsMessage(mismatched, { root }) {
  const lines = mismatched.map(
    (m) => `  - ${m.name}: need ${m.required}, resolved ${m.resolved}`,
  );
  return [
    'Mandrel framework runtime dependency version mismatch:',
    ...lines,
    '',
    `Resolved from: ${root}`,
    'These packages are resolved from your repository, not from mandrel, so',
    'the version your tree installs is the version the framework gets. Pin a',
    'compatible major in your package.json and reinstall.',
  ].join('\n');
}

/**
 * @param {{ required: string[], resolve: (specifier: string) => string }} opts
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function checkRuntimeDeps({
  required,
  resolve,
  ranges = null,
  readVersion = null,
}) {
  const missing = [];
  const mismatched = [];
  for (const dep of required) {
    if (!isResolvable(dep, resolve)) {
      missing.push(dep);
      continue;
    }
    if (!ranges || !readVersion) continue;
    const range = ranges[dep];
    const resolved = readVersion(dep);
    if (majorMismatch(range, resolved)) {
      mismatched.push({ name: dep, required: range, resolved });
    }
  }
  return {
    ok: missing.length === 0 && mismatched.length === 0,
    missing,
    mismatched,
  };
}
