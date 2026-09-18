// lib/migrations/steps/2.63.0-baseline-merge-queue-shape.js
/**
 * Strip `generatedAt` and `rollup` from the committed row-set baselines. Both
 * were rewritten on every refresh, so two branches refreshing disjoint rows
 * always conflicted on GitHub, which never runs the custom merge driver.
 * Readers now derive the rollup from `rows`. Files are identified by their
 * `$schema` tail; any other baseline is left byte-identical.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

const BASELINES_DIR = 'baselines';

/** `$schema` tail → the keys the new shape no longer carries. */
const RETIRED_KEYS_BY_SCHEMA = Object.freeze({
  'coverage.schema.json': ['generatedAt', 'rollup'],
  'crap.schema.json': ['generatedAt', 'rollup'],
  'maintainability.schema.json': ['generatedAt', 'rollup'],
  'duplication.schema.json': ['generatedAt', 'rollup'],
  'mutation.schema.json': ['generatedAt', 'rollup'],
  'bundle-size.schema.json': ['generatedAt', 'rollup'],
  'cyclomatic.schema.json': ['generatedAt', 'rollup'],
  'dead-exports.schema.json': ['generatedAt'],
});

/**
 * @param {unknown} envelope
 * @returns {string[]}
 */
function retiredKeysPresent(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return [];
  }
  const schema = envelope.$schema;
  if (typeof schema !== 'string') return [];
  const keys = RETIRED_KEYS_BY_SCHEMA[schema.split('/').pop()] ?? [];
  return keys.filter((key) => Object.hasOwn(envelope, key));
}

/**
 * @param {{ projectRoot?: string }} ctx
 * @param {typeof nodeFs} fsImpl
 * @returns {Array<{ file: string, envelope: object, keys: string[] }>}
 */
function pendingBaselines(ctx, fsImpl) {
  const dir = path.join(ctx?.projectRoot ?? process.cwd(), BASELINES_DIR);
  let names;
  try {
    names = fsImpl.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of [...names].sort()) {
    if (!String(name).endsWith('.json')) continue;
    const file = path.join(dir, String(name));
    let envelope;
    try {
      envelope = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const keys = retiredKeysPresent(envelope);
    if (keys.length > 0) out.push({ file, envelope, keys });
  }
  return out;
}

export const baselineMergeQueueShape = {
  version: '2.63.0',
  description:
    'strip generatedAt and rollup from committed row-set baselines so ' +
    'disjoint refreshes merge textually on GitHub, where the custom merge ' +
    'driver never runs (Story #5400)',
  /**
   * @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx]
   * @param {typeof nodeFs} [fsImpl]
   * @returns {boolean}
   */
  detect(ctx, fsImpl = ctx?.fs ?? nodeFs) {
    return pendingBaselines(ctx, fsImpl).length > 0;
  },
  /**
   * @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx]
   * @param {typeof nodeFs} [fsImpl]
   * @returns {void}
   */
  apply(ctx, fsImpl = ctx?.fs ?? nodeFs) {
    for (const { file, envelope, keys } of pendingBaselines(ctx, fsImpl)) {
      const next = { ...envelope };
      for (const key of keys) delete next[key];
      fsImpl.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    }
  },
};
