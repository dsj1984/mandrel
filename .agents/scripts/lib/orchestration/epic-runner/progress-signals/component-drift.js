import path from 'node:path';
import { resolveComponents } from '../../../baselines/components.js';
import { componentOrder } from './_bullet-format.js';

/**
 * Shared component-regression walk for the progress-signal drift detectors
 * (Story #3984). `crap-drift.js` and `maintainability-drift.js` previously
 * duplicated this baseline-rollup → per-component compare → bullet-list
 * shape verbatim; the only divergence was the breach comparator (CRAP is
 * "lower is better", maintainability is "higher is better") and the bullet
 * text. Both detectors now parameterize this walk.
 *
 * Pure — the caller loads the baseline via `lib/baselines/reader.js#load(...)`
 * and passes the resulting `{ rollup }` plus the gate config block.
 *
 * Only components whose rollup breaches the configured floor surface — a
 * breach in a component-scoped floor does NOT report against `*` unless
 * `*` itself breaches. This keeps the rollout narrowly targeted: when an
 * operator wires up a per-component floor for `api`, regressing `api`
 * names `api` — not `*`.
 *
 * @param {{
 *   rollup?: Record<string, Record<string, number>>,
 *   gateConfig?: { floors?: Record<string, Record<string, number>> } & object,
 * }} params
 * @param {{
 *   isBreach: (value: number, floor: number) => boolean,
 *   formatBullet: (name: string, axis: string, value: number, floor: number) => string,
 * }} spec
 * @returns {string[]}
 */
export function walkComponentRegressions(params = {}, spec) {
  const rollup = params.rollup ?? {};
  const gateConfig = params.gateConfig ?? {};
  const floors = gateConfig.floors ?? {};
  const components = resolveComponents(gateConfig);
  const names = new Set([
    ...Object.keys(components),
    ...Object.keys(floors),
    ...Object.keys(rollup),
  ]);
  const bullets = [];
  for (const name of [...names].sort(componentOrder)) {
    const aggregate = rollup[name];
    if (!aggregate || typeof aggregate !== 'object') continue;
    const floor = floors[name] ?? floors['*'];
    if (!floor || typeof floor !== 'object') continue;
    for (const axis of Object.keys(floor).sort()) {
      const target = floor[axis];
      const value = aggregate[axis];
      if (typeof target !== 'number' || !Number.isFinite(target)) continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      if (!spec.isBreach(value, target)) continue;
      bullets.push(spec.formatBullet(name, axis, value, target));
    }
  }
  return bullets;
}

/**
 * Shared wave-start snapshot persistence for the drift detectors. Both
 * detectors persist a `{ capturedAt, ...metadata, scores }` JSON document
 * under `<cwd>/<baselineDir>/<filename>` so a resumed epic run can re-read
 * the wave-start anchor rather than lose it, and both treat persistence as
 * best-effort (the in-memory baseline still works when a write fails).
 *
 * @param {{
 *   fs: { readFileSync?: Function, writeFileSync?: Function, mkdirSync?: Function },
 *   baselinePath: string,
 *   metadata?: Record<string, unknown>,
 * }} opts
 */
export function createSnapshotStore({ fs, baselinePath, metadata = {} }) {
  return {
    persist(scores) {
      if (!fs.writeFileSync) return;
      try {
        fs.mkdirSync?.(path.dirname(baselinePath), { recursive: true });
        fs.writeFileSync(
          baselinePath,
          JSON.stringify(
            { capturedAt: new Date().toISOString(), ...metadata, scores },
            null,
            2,
          ),
        );
      } catch {
        // persistence is best-effort; the in-memory baseline still works
      }
    },

    load() {
      if (!fs.readFileSync) return null;
      try {
        const raw = fs.readFileSync(baselinePath, 'utf-8');
        const parsed = JSON.parse(raw);
        return parsed?.scores ?? null;
      } catch {
        return null;
      }
    },
  };
}
