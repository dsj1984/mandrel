/**
 * glob-match.js — the one glob matcher for shipped scripts.
 *
 * Every repo-relative glob (config, audit rules, footprints) is matched here,
 * on POSIX semantics on every platform, so a pattern means the same thing on
 * a Windows runner as on Linux. Built on minimatch; picomatch was dropped
 * because no release fixes GHSA-fc5q-39xc-vjpf.
 */

import { Minimatch } from 'minimatch';

const BASE_OPTIONS = Object.freeze({ platform: 'linux', nocomment: true });

// `dir/**` also matches `dir` itself, as picomatch did; `!dir/**` excludes it.
function compile(pattern, opts) {
  const options = { ...BASE_OPTIONS, ...opts };
  const mm = new Minimatch(pattern, options);
  if (!pattern.endsWith('/**')) return (file) => mm.match(file);
  const dir = new Minimatch(pattern.slice(0, -3), options);
  return mm.negate
    ? (file) => mm.match(file) && dir.match(file)
    : (file) => mm.match(file) || dir.match(file);
}

/**
 * @param {string|string[]} patterns A path matches when ANY pattern does.
 * @param {{ dot?: boolean }} [opts]
 * @returns {(file: string) => boolean}
 */
export function globMatcher(patterns, opts = {}) {
  const matchers = [patterns].flat().map((p) => compile(p, opts));
  return (file) => matchers.some((match) => match(file));
}

/**
 * @param {string} file
 * @param {string|string[]} patterns
 * @param {{ dot?: boolean }} [opts]
 * @returns {boolean}
 */
export function isGlobMatch(file, patterns, opts = {}) {
  return globMatcher(patterns, opts)(file);
}

const hasMagic = (segment) => new Minimatch(segment, BASE_OPTIONS).hasMagic();

/**
 * Split a glob into its static directory prefix and whether it has magic. A
 * literal path is its own base; a leading `!` is not part of the base.
 *
 * @param {string} glob
 * @returns {{ base: string, isGlob: boolean }}
 */
export function scanGlob(glob) {
  const text = String(glob).replace(/^!/, '');
  const segments = text.split('/');
  const firstMagic = segments.findIndex(hasMagic);
  if (firstMagic === -1) return { base: text, isGlob: false };
  const base = segments.slice(0, firstMagic).join('/');
  return {
    base: base === '' && text.startsWith('/') ? '/' : base,
    isGlob: true,
  };
}
