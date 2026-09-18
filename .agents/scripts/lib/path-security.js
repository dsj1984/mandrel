import path from 'node:path';

/**
 * Reject `..` traversal and absolute escapes in config-supplied paths.
 *
 * @param {string} root    absolute path of the containing directory
 * @param {string} target  absolute path to validate
 * @param {string} label   identifier for the error message
 * @param {{ allowEmpty?: boolean }} [opts] false also rejects target === root.
 * @returns {string} the path relative to `root`
 * @throws {Error} when target escapes root
 */
export function assertPathContainment(root, target, label, opts = {}) {
  const allowEmpty = opts.allowEmpty ?? true;
  const rel = path.relative(root, target);
  const escapes =
    rel.startsWith('..') || path.isAbsolute(rel) || (!allowEmpty && rel === '');
  if (escapes) {
    throw new Error(`${label} resolves outside ${root}: ${target}`);
  }
  return rel;
}
