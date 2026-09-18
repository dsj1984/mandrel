/**
 * kernel.js — per-kind kernel-version resolution (Story #1891, Epic #1786).
 *
 * Every committed baseline stamps a `kernelVersion` semver string in its
 * envelope. The version tracks the in-repo (or upstream) kernel that
 * produced the rows — a bump invalidates every committed baseline of
 * that kind, signalling consumers to regenerate. The version source is
 * **per-kind**:
 *
 *   - CRAP and Maintainability share the `typhonjs-escomplex` upstream
 *     package version; both modules' `kernelVersion()` read it from the
 *     nearest `node_modules/typhonjs-escomplex/package.json`.
 *   - Coverage, Mutation, Bundle-Size, Duplication carry a static
 *     in-repo semver bumped by hand whenever the scoring/rollup math
 *     changes. Their `kernelVersion()` just returns the constant.
 *
 * This module is the public surface: callers ask
 * `currentKernelVersion(kind)` and get a single string back, no matter
 * which strategy the kind uses internally.
 *
 * `checkKernelVersion(kind, baselineVersion)` is the drift-detection
 * helper. It returns `{ match, current }` so a CI gate can compare the
 * baseline's stamp against the running kernel and decide whether to
 * regenerate or fail.
 *
 * @module lib/baselines/kernel
 */

import {
  applyEpsilon as bundleSizeApplyEpsilon,
  compare as bundleSizeCompare,
  kernelVersion as bundleSizeKernelVersion,
  keyField as bundleSizeKeyField,
  mergeRows as bundleSizeMergeRows,
  name as bundleSizeName,
  projectRow as bundleSizeProjectRow,
  rollup as bundleSizeRollup,
  rowIdentity as bundleSizeRowIdentity,
  sortRows as bundleSizeSortRows,
} from './kinds/bundle-size.js';
import {
  applyEpsilon as coverageApplyEpsilon,
  compare as coverageCompare,
  kernelVersion as coverageKernelVersion,
  keyField as coverageKeyField,
  mergeRows as coverageMergeRows,
  name as coverageName,
  projectRow as coverageProjectRow,
  rollup as coverageRollup,
  rowIdentity as coverageRowIdentity,
  sortRows as coverageSortRows,
} from './kinds/coverage.js';
import {
  applyEpsilon as crapApplyEpsilon,
  assertBaselineCompatible as crapAssertBaselineCompatible,
  compare as crapCompare,
  envelopeExtras as crapEnvelopeExtras,
  kernelVersion as crapKernelVersion,
  keyField as crapKeyField,
  mergeRows as crapMergeRows,
  name as crapName,
  projectRow as crapProjectRow,
  rollup as crapRollup,
  rowIdentity as crapRowIdentity,
  sortRows as crapSortRows,
} from './kinds/crap.js';
import {
  applyEpsilon as duplicationApplyEpsilon,
  compare as duplicationCompare,
  kernelVersion as duplicationKernelVersion,
  keyField as duplicationKeyField,
  mergeRows as duplicationMergeRows,
  name as duplicationName,
  projectRow as duplicationProjectRow,
  rollup as duplicationRollup,
  rowIdentity as duplicationRowIdentity,
  sortRows as duplicationSortRows,
} from './kinds/duplication.js';
import {
  applyEpsilon as maintainabilityApplyEpsilon,
  compare as maintainabilityCompare,
  kernelVersion as maintainabilityKernelVersion,
  keyField as maintainabilityKeyField,
  mergeRows as maintainabilityMergeRows,
  name as maintainabilityName,
  projectRow as maintainabilityProjectRow,
  rollup as maintainabilityRollup,
  rowIdentity as maintainabilityRowIdentity,
  sortRows as maintainabilitySortRows,
} from './kinds/maintainability.js';
import {
  applyEpsilon as mutationApplyEpsilon,
  assertBaselineCompatible as mutationAssertBaselineCompatible,
  compare as mutationCompare,
  kernelVersion as mutationKernelVersion,
  keyField as mutationKeyField,
  mergeRows as mutationMergeRows,
  name as mutationName,
  projectRow as mutationProjectRow,
  rollup as mutationRollup,
  rowIdentity as mutationRowIdentity,
  sortRows as mutationSortRows,
} from './kinds/mutation.js';

/**
 * Assemble the kind-module protocol from named imports.
 *
 * Prefer named imports over `import * as kind` here: knip (and the
 * dead-exports ratchet) cannot see members reached only through
 * `getKindModule(kind).projectRow(...)` after a namespace import, so
 * star-imports of `kinds/*.js` produced systematic false-positive dead
 * exports for the protocol surface (`name`, `keyField`, `kernelVersion`,
 * `projectRow`, `sortRows`, `rollup`, …).
 *
 * @param {object} members
 * @returns {object}
 */
function bindKindModule(members) {
  return Object.freeze({
    name: members.name,
    keyField: members.keyField,
    // Story #5215: the merge identity, distinct from the `keyField`
    // grouping key above — CRAP groups by file and identifies by method.
    rowIdentity: members.rowIdentity,
    kernelVersion: members.kernelVersion,
    projectRow: members.projectRow,
    sortRows: members.sortRows,
    rollup: members.rollup,
    compare: members.compare,
    applyEpsilon: members.applyEpsilon,
    mergeRows: members.mergeRows,
    // Optional per-kind hooks (Story #4775). `envelopeExtras` contributes
    // envelope-level stamps the shared writer would not otherwise know about;
    // `assertBaselineCompatible` lets a kind refuse a loaded baseline whose
    // scoring semantics predate the running scorer.
    envelopeExtras: members.envelopeExtras,
    assertBaselineCompatible: members.assertBaselineCompatible,
  });
}

/**
 * Registry of every shipped kind module. Keys mirror the per-kind schema
 * filenames so a future "list all kinds" iterator can stay declarative.
 */
const KIND_MODULES = Object.freeze({
  coverage: bindKindModule({
    name: coverageName,
    keyField: coverageKeyField,
    rowIdentity: coverageRowIdentity,
    kernelVersion: coverageKernelVersion,
    projectRow: coverageProjectRow,
    sortRows: coverageSortRows,
    rollup: coverageRollup,
    compare: coverageCompare,
    applyEpsilon: coverageApplyEpsilon,
    mergeRows: coverageMergeRows,
  }),
  crap: bindKindModule({
    name: crapName,
    keyField: crapKeyField,
    rowIdentity: crapRowIdentity,
    kernelVersion: crapKernelVersion,
    projectRow: crapProjectRow,
    sortRows: crapSortRows,
    rollup: crapRollup,
    compare: crapCompare,
    applyEpsilon: crapApplyEpsilon,
    mergeRows: crapMergeRows,
    envelopeExtras: crapEnvelopeExtras,
    assertBaselineCompatible: crapAssertBaselineCompatible,
  }),
  maintainability: bindKindModule({
    name: maintainabilityName,
    keyField: maintainabilityKeyField,
    rowIdentity: maintainabilityRowIdentity,
    kernelVersion: maintainabilityKernelVersion,
    projectRow: maintainabilityProjectRow,
    sortRows: maintainabilitySortRows,
    rollup: maintainabilityRollup,
    compare: maintainabilityCompare,
    applyEpsilon: maintainabilityApplyEpsilon,
    mergeRows: maintainabilityMergeRows,
  }),
  mutation: bindKindModule({
    name: mutationName,
    keyField: mutationKeyField,
    rowIdentity: mutationRowIdentity,
    kernelVersion: mutationKernelVersion,
    projectRow: mutationProjectRow,
    sortRows: mutationSortRows,
    rollup: mutationRollup,
    compare: mutationCompare,
    applyEpsilon: mutationApplyEpsilon,
    mergeRows: mutationMergeRows,
    assertBaselineCompatible: mutationAssertBaselineCompatible,
  }),
  'bundle-size': bindKindModule({
    name: bundleSizeName,
    keyField: bundleSizeKeyField,
    rowIdentity: bundleSizeRowIdentity,
    kernelVersion: bundleSizeKernelVersion,
    projectRow: bundleSizeProjectRow,
    sortRows: bundleSizeSortRows,
    rollup: bundleSizeRollup,
    compare: bundleSizeCompare,
    applyEpsilon: bundleSizeApplyEpsilon,
    mergeRows: bundleSizeMergeRows,
  }),
  duplication: bindKindModule({
    name: duplicationName,
    keyField: duplicationKeyField,
    rowIdentity: duplicationRowIdentity,
    kernelVersion: duplicationKernelVersion,
    projectRow: duplicationProjectRow,
    sortRows: duplicationSortRows,
    rollup: duplicationRollup,
    compare: duplicationCompare,
    applyEpsilon: duplicationApplyEpsilon,
    mergeRows: duplicationMergeRows,
  }),
});

/**
 * Look up a kind module by name. Throws when the kind isn't registered so
 * callers can't silently fall through to undefined behaviour.
 *
 * @param {string} kind
 * @returns {{ name: string, keyField: string, kernelVersion: () => string,
 *           projectRow: (row: object) => object,
 *           sortRows: (rows: object[]) => object[],
 *           rollup: (rows: object[], components?: object[]) => object,
 *           compare?: Function, applyEpsilon?: Function, mergeRows?: Function }}
 */
export function getKindModule(kind) {
  const mod = KIND_MODULES[kind];
  if (!mod) {
    throw new Error(
      `kernel.getKindModule: unknown kind "${kind}" (known: ${Object.keys(KIND_MODULES).join(', ')})`,
    );
  }
  return mod;
}

/**
 * Resolve the running kernel version for `kind`. Delegates to the per-kind
 * module's `kernelVersion()` — see the module preamble for which strategy
 * each kind uses.
 *
 * @param {string} kind
 * @returns {string}
 */
export function currentKernelVersion(kind) {
  return getKindModule(kind).kernelVersion();
}

/**
 * Resolve a kind module, or null when the kind is not registered. Lets the
 * optional-hook callers below stay expression-shaped instead of threading a
 * mutable binding through a try/catch.
 *
 * @param {string} kind
 * @returns {object|null}
 */
function tryGetKindModule(kind) {
  try {
    return getKindModule(kind);
  } catch {
    return null;
  }
}

/**
 * Ask a kind whether a loaded baseline is compatible with the running
 * scorer's SEMANTICS — a dimension `kernelVersion` cannot express, because a
 * kind's scoring can change while the upstream package it stamps does not
 * (Story #4775). Kinds without the hook always answer "compatible".
 *
 * @param {string} kind
 * @param {object|null} baseline
 * @returns {string|null} Operator-facing message, or null when compatible.
 */
export function checkBaselineSemantics(kind, baseline) {
  const mod = tryGetKindModule(kind);
  if (typeof mod?.assertBaselineCompatible !== 'function') return null;
  return mod.assertBaselineCompatible(baseline);
}

/**
 * Compare a baseline's stamped version against the currently running
 * kernel for the same kind. Returns `{ match, current }` so callers can
 * format a drift signal or trigger a regenerate.
 *
 * @param {string} kind
 * @param {string} baselineVersion
 * @returns {{ match: boolean, current: string }}
 */
export function checkKernelVersion(kind, baselineVersion) {
  const current = currentKernelVersion(kind);
  return {
    match: baselineVersion === current,
    current,
  };
}

/**
 * List every kind registered with the kernel. Useful for the writer's
 * envelope sanity check and for tests that want to iterate all shipped
 * kinds.
 *
 * @returns {string[]}
 */
export function listKinds() {
  return Object.keys(KIND_MODULES);
}
