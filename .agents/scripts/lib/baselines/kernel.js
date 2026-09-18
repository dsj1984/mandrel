/**
 * Kind-module registry and kernel-version resolution. CRAP and MI stamp the
 * installed scorer package version; the other kinds stamp a static semver
 * bumped by hand when their scoring or rollup math changes.
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
 * Named imports, not `import * as`: knip cannot see members reached through
 * a namespace, which reports the protocol surface as dead exports.
 *
 * @param {object} members
 * @returns {object}
 */
function bindKindModule(members) {
  return Object.freeze({
    name: members.name,
    keyField: members.keyField,
    // Merge identity; distinct from the `keyField` grouping key.
    rowIdentity: members.rowIdentity,
    kernelVersion: members.kernelVersion,
    projectRow: members.projectRow,
    sortRows: members.sortRows,
    rollup: members.rollup,
    compare: members.compare,
    applyEpsilon: members.applyEpsilon,
    mergeRows: members.mergeRows,
    // Optional hooks: extra envelope stamps; refusal of an incompatible baseline.
    envelopeExtras: members.envelopeExtras,
    assertBaselineCompatible: members.assertBaselineCompatible,
  });
}

/** Keys mirror the per-kind schema filenames. */
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
 * Throws on an unregistered kind.
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
 * @param {string} kind
 * @returns {string}
 */
export function currentKernelVersion(kind) {
  return getKindModule(kind).kernelVersion();
}

/**
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
 * Semantic compatibility, which `kernelVersion` cannot express: scoring can
 * change while the stamped package does not. Kinds without the hook pass.
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
 * @returns {string[]}
 */
export function listKinds() {
  return Object.keys(KIND_MODULES);
}
