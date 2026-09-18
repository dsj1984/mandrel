/**
 * Pure floor-comparison helpers for check-baselines.
 *
 * @module lib/orchestration/check-baselines/phases/floors
 */

import { EXIT_CONFIG } from '../../../baselines/exit-codes.js';

/**
 * Floor polarity per axis; the single table every consumer must share.
 *
 * @param {string} kind
 * @param {string} axis
 * @returns {'gte' | 'lte'}
 */
export function axisDirection(kind, axis) {
  if (kind === 'lint') return 'lte';
  if (kind === 'crap') return 'lte';
  if (kind === 'bundle-size') return 'lte';
  if (kind === 'duplication') return 'lte';
  if (kind === 'mutation') {
    if (axis === 'survived' || axis === 'noCoverage') return 'lte';
    return 'gte';
  }
  return 'gte';
}

/** Axis violations of one rollup component against its floor. */
export function compareToFloor(kind, aggregate, floor) {
  const out = [];
  if (!floor || typeof floor !== 'object') return out;
  for (const axis of Object.keys(floor)) {
    const target = floor[axis];
    if (typeof target !== 'number' || !Number.isFinite(target)) continue;
    const value = aggregate?.[axis];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const direction = axisDirection(kind, axis);
    const pass = direction === 'gte' ? value >= target : value <= target;
    if (!pass) out.push({ axis, value, floor: target, direction });
  }
  return out;
}

function suggestAxis(unknownAxis, availableKeys) {
  if (availableKeys.length === 0) return null;
  const target = unknownAxis.toLowerCase();
  for (const k of availableKeys) {
    const candidate = k.toLowerCase();
    if (target.includes(candidate) || candidate.includes(target)) return k;
  }
  return availableKeys[0];
}

function buildAxisMismatchError({ kind, component, axis, availableKeys }) {
  const availableList = availableKeys.map((k) => `'${k}'`).join(', ');
  const suggestion = suggestAxis(axis, availableKeys);
  const hint = suggestion ? ` (did you mean '${suggestion}'?)` : '';
  const err = new Error(
    `[check-baselines:${kind}] configured floor '${axis}' not found in ` +
      `rollup['${component}']; available keys: ${availableList || '<none>'}` +
      hint,
  );
  err.code = 'EXIT_CONFIG';
  err.exitCode = EXIT_CONFIG;
  err.kind = kind;
  err.component = component;
  err.axis = axis;
  err.availableKeys = availableKeys;
  return err;
}

/**
 * Fail closed (exit 3) on a floor axis absent from the rollup, so a config
 * typo never silently passes.
 */
export function assertFloorAxesExist(kind, component, aggregate, floor) {
  if (!floor || typeof floor !== 'object') return;
  if (!aggregate || typeof aggregate !== 'object') return;
  const availableKeys = Object.keys(aggregate).sort();
  const availableSet = new Set(availableKeys);
  for (const axis of Object.keys(floor)) {
    const target = floor[axis];
    if (typeof target !== 'number' || !Number.isFinite(target)) continue;
    if (availableSet.has(axis)) continue;
    throw buildAxisMismatchError({ kind, component, axis, availableKeys });
  }
}

function collectComponentNames(rollup, floors) {
  return new Set([
    '*',
    ...Object.keys(floors ?? {}),
    ...Object.keys(rollup ?? {}),
  ]);
}

function evaluateComponentFloor(kind, component, rollup, floors) {
  const aggregate = rollup?.[component];
  if (!aggregate || typeof aggregate !== 'object') return null;
  const floor = floors?.[component] ?? floors?.['*'];
  assertFloorAxesExist(kind, component, aggregate, floor);
  const violations = compareToFloor(kind, aggregate, floor);
  return { component, violations };
}

export function applyFloors(kind, rollup, floors) {
  const out = [];
  for (const component of collectComponentNames(rollup, floors)) {
    const finding = evaluateComponentFloor(kind, component, rollup, floors);
    if (finding) out.push(finding);
  }
  out.sort((a, b) => {
    if (a.component === '*') return -1;
    if (b.component === '*') return 1;
    return a.component.localeCompare(b.component);
  });
  return out;
}

export function flattenBreaches(findings) {
  return findings.flatMap((f) =>
    f.violations.map((v) => ({ ...v, component: f.component })),
  );
}
