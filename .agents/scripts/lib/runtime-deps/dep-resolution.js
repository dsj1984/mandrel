/**
 * runtime-deps/dep-resolution — is a declared runtime dependency actually
 * there, is it the right major, and how do we say so.
 *
 * `.agents/` materializes into the consumer's repository root, so every
 * framework runtime dependency resolves from *their* `node_modules`. A range
 * in `.agents/runtime-deps.json` therefore documents a requirement it cannot
 * enforce, and the preflight guard needs to compare the range against what
 * actually resolved.
 *
 * Deliberately major-only, and deliberately not `semver`. The framework's
 * runtime ranges are all `^`, whose whole contract is "this major"; pulling in
 * a semver implementation to decide one comparison would add a dependency to
 * the very closure this module exists to keep honest.
 *
 * @module lib/runtime-deps/dep-resolution
 */

/**
 * Leading major number of a version or a caret/tilde range, or `null`.
 *
 * Module-local: `majorMismatch` is the only question callers have.
 *
 * Anything this cannot read as `<major>.` — `*`, a tag, a git URL, a
 * `>=x <y` span — yields `null` and is treated as "not range-checked". That
 * asymmetry is intentional: a conservative miss is a no-op, while a false
 * positive blocks a working install.
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
 * Does `resolved` sit outside the major `range` names?
 *
 * `false` whenever either side is unreadable, so an unparseable range or an
 * unreadable installed version is never reported as a mismatch.
 *
 * `0.x` majors compare as written: `^0.1.0` and `0.2.1` differ in minor, not
 * major, so this does not separate them. Accepted — the `0.x` packages in the
 * closure are terminal, and the range this exists to enforce is
 * `@babel/parser`'s `^7`.
 *
 * @param {string|null|undefined} range
 * @param {string|null|undefined} resolved
 * @returns {boolean}
 */
export function majorMismatch(range, resolved) {
  const want = majorOf(range);
  if (want === null) return false;
  const got = majorOf(resolved);
  if (got === null) return false;
  return want !== got;
}

/**
 * Is a package present in the resolvable tree?
 *
 * The bare specifier is tried first, then `<name>/package.json`. The fallback
 * is not belt-and-braces: a package with no `main` and no `exports` — which
 * `typhonjs-escomplex-commons` and `babel-runtime` both are — cannot be
 * resolved by name at all, and is reached only by deep path. Probing the bare
 * name alone would report such a package missing while it sits installed, and
 * this guard exits the process on that verdict.
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
 * Remediation text for a resolved dependency whose major differs from the
 * range the framework declares.
 *
 * Named separately from the missing-deps message because the remedy differs:
 * the package is installed, so installing again changes nothing. What is
 * wrong is the version the consumer's own tree resolves, which only they can
 * change.
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
 * Resolve each required package via the injected `resolve` seam and collect
 * the ones that fail. `resolve` is typically `require.resolve` bound to the
 * framework module location; it throws `MODULE_NOT_FOUND` when a package is
 * absent from the resolvable `node_modules`.
 *
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
