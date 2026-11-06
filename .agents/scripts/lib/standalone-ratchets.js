/**
 * standalone-ratchets.js — CI's standalone ratchets, stated once. The handoff
 * preflight runs each whose baseline is committed, and the config schema's
 * `delivery.quality.ratchets.coveredByLint` enum is these keys, so neither can
 * gain a ratchet without the other. Imports nothing: the schema loads it.
 */

export const STANDALONE_RATCHETS = Object.freeze([
  Object.freeze({
    key: 'dead-exports',
    script: 'check-dead-exports.js',
    args: Object.freeze([]),
    baseline: 'baselines/dead-exports.json',
  }),
  Object.freeze({
    key: 'dead-exports-production',
    script: 'check-dead-exports.js',
    args: Object.freeze(['--production']),
    baseline: 'baselines/dead-exports-production.json',
  }),
  Object.freeze({
    key: 'arch-cycles',
    script: 'check-arch-cycles.js',
    args: Object.freeze([]),
    baseline: 'baselines/arch-cycles.json',
  }),
  Object.freeze({
    key: 'cyclomatic',
    script: 'check-cyclomatic.js',
    args: Object.freeze([]),
    baseline: 'baselines/cyclomatic.json',
  }),
]);

export const STANDALONE_RATCHET_KEYS = Object.freeze(
  STANDALONE_RATCHETS.map((r) => r.key),
);
