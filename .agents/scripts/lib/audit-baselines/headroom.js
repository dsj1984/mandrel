/**
 * Slack between each configured floor and the measured rollup — a floor far
 * from reality is a gate that cannot fail. Polarity comes from the gate's own
 * `axisDirection`, so "better" means what `check-baselines.js` means.
 *
 * @module lib/audit-baselines/headroom
 */

import { axisDirection } from '../orchestration/check-baselines/phases/floors.js';
import { rollupOf } from './kinds.js';

/**
 * Positive on the good side of the floor, negative when breached.
 *
 * @param {number | undefined} measured
 * @param {number} floor
 * @param {'gte' | 'lte'} direction
 * @returns {number | null}
 */
function headroomFor(measured, floor, direction) {
  if (typeof measured !== 'number') return null;
  return direction === 'gte' ? measured - floor : floor - measured;
}

/**
 * @param {{
 *   kinds: string[],
 *   quality: object,
 *   baselines: Map<string, object | null>,
 * }} args
 * @returns {Array<object>}
 */
export function buildHeadroom({ kinds, quality, baselines }) {
  const out = [];
  for (const kind of kinds) {
    const floors = quality?.gates?.[kind]?.floors?.['*'];
    if (!floors || typeof floors !== 'object') continue;
    const rollup = rollupOf(kind, baselines.get(kind) ?? null);
    for (const [axis, floor] of Object.entries(floors)) {
      if (typeof floor !== 'number' || !Number.isFinite(floor)) continue;
      const measured = rollup?.[axis];
      const direction = axisDirection(kind, axis);
      out.push({
        kind,
        axis,
        floor,
        measured: typeof measured === 'number' ? measured : null,
        direction,
        headroom: headroomFor(measured, floor, direction),
      });
    }
  }
  return out.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.axis.localeCompare(b.axis),
  );
}
