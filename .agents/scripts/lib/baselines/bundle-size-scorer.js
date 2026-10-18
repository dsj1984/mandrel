/**
 * Default scorer for the bundle-size baseline: weigh each declared
 * `gates['bundle-size'].bundles[]` artifact on disk. It never builds the
 * project — the artifacts must already exist.
 *
 * Row shape (kinds/bundle-size.js): `{ bundle, rawKb, gzippedKb }`, where a
 * bundle's size is the sum over every file its `path` glob matches.
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import picomatch from 'picomatch';

/** Directories a bundle glob never descends into. */
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

/**
 * @param {number} bytes
 * @returns {number} KB, two decimals.
 */
function toKb(bytes) {
  return Number((bytes / 1024).toFixed(2));
}

/**
 * The leading glob-free directory of a POSIX pattern — the walk root.
 *
 * @param {string[]} segments
 * @returns {string}
 */
function staticBase(segments) {
  const firstMagic = segments.findIndex((s) => /[*?[\]{}()!]/.test(s));
  const base =
    firstMagic === -1 ? segments.slice(0, -1) : segments.slice(0, firstMagic);
  return base.join('/');
}

/**
 * @param {string} absDir
 * @param {typeof nodeFs} fs
 * @returns {string[]} Absolute file paths under `absDir`.
 */
function walkFiles(absDir, fs) {
  if (!fs.existsSync(absDir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) out.push(...walkFiles(abs, fs));
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Repo-relative files a bundle `path` (literal or glob) matches, sorted.
 *
 * @param {string} pattern
 * @param {string} cwd
 * @param {typeof nodeFs} fs
 * @returns {string[]} Absolute paths.
 */
function resolveBundleFiles(pattern, cwd, fs = nodeFs) {
  const posix = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!picomatch.scan(posix).isGlob) {
    const abs = path.resolve(cwd, posix);
    return fs.existsSync(abs) && fs.statSync(abs).isFile() ? [abs] : [];
  }
  const isMatch = picomatch(posix, { dot: true });
  const base = staticBase(posix.split('/'));
  return walkFiles(path.resolve(cwd, base), fs)
    .filter((abs) => isMatch(path.relative(cwd, abs).split(path.sep).join('/')))
    .sort();
}

/**
 * @param {{ name: string, path: string }} bundle
 * @param {string} cwd
 * @param {typeof nodeFs} fs
 * @returns {{ bundle: string, rawKb: number, gzippedKb: number }}
 */
function measureBundle(bundle, cwd, fs) {
  const files = resolveBundleFiles(bundle.path, cwd, fs);
  if (files.length === 0) {
    throw new Error(
      `[bundle-size] declared bundle "${bundle.name}" matches no file at "${bundle.path}" — build the project before refreshing; an unbuilt artifact is never recorded as 0 KB.`,
    );
  }
  let raw = 0;
  let gzipped = 0;
  for (const abs of files) {
    const bytes = fs.readFileSync(abs);
    raw += bytes.length;
    gzipped += gzipSync(bytes).length;
  }
  return { bundle: bundle.name, rawKb: toKb(raw), gzippedKb: toKb(gzipped) };
}

/**
 * @param {{ cwd: string, quality?: object, fs?: typeof nodeFs }} opts
 * @returns {(files: string[], opts: object) => object[]}
 */
export function buildBundleSizeScorer({ cwd, quality, fs = nodeFs } = {}) {
  const declared = quality?.gates?.['bundle-size']?.bundles;
  const bundles = Array.isArray(declared) ? declared : [];
  return (_files, opts) => {
    const effectiveCwd = opts?.cwd ?? cwd ?? process.cwd();
    return bundles.map((bundle) => measureBundle(bundle, effectiveCwd, fs));
  };
}
