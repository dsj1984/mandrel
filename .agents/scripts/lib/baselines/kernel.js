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
 *   - Lint, Coverage, Mutation, Lighthouse, Bundle-Size carry a static
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
  sortRows as coverageSortRows,
} from './kinds/coverage.js';
import {
  applyEpsilon as crapApplyEpsilon,
  compare as crapCompare,
  kernelVersion as crapKernelVersion,
  keyField as crapKeyField,
  mergeRows as crapMergeRows,
  name as crapName,
  projectRow as crapProjectRow,
  rollup as crapRollup,
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
  sortRows as duplicationSortRows,
} from './kinds/duplication.js';
import {
  applyEpsilon as lighthouseApplyEpsilon,
  compare as lighthouseCompare,
  kernelVersion as lighthouseKernelVersion,
  keyField as lighthouseKeyField,
  mergeRows as lighthouseMergeRows,
  name as lighthouseName,
  projectRow as lighthouseProjectRow,
  rollup as lighthouseRollup,
  sortRows as lighthouseSortRows,
} from './kinds/lighthouse.js';
import {
  applyEpsilon as lintApplyEpsilon,
  compare as lintCompare,
  kernelVersion as lintKernelVersion,
  keyField as lintKeyField,
  mergeRows as lintMergeRows,
  name as lintName,
  projectRow as lintProjectRow,
  rollup as lintRollup,
  sortRows as lintSortRows,
} from './kinds/lint.js';
import {
  applyEpsilon as maintainabilityApplyEpsilon,
  compare as maintainabilityCompare,
  kernelVersion as maintainabilityKernelVersion,
  keyField as maintainabilityKeyField,
  mergeRows as maintainabilityMergeRows,
  name as maintainabilityName,
  projectRow as maintainabilityProjectRow,
  rollup as maintainabilityRollup,
  sortRows as maintainabilitySortRows,
} from './kinds/maintainability.js';
import {
  applyEpsilon as mutationApplyEpsilon,
  compare as mutationCompare,
  kernelVersion as mutationKernelVersion,
  keyField as mutationKeyField,
  mergeRows as mutationMergeRows,
  name as mutationName,
  projectRow as mutationProjectRow,
  rollup as mutationRollup,
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
    kernelVersion: members.kernelVersion,
    projectRow: members.projectRow,
    sortRows: members.sortRows,
    rollup: members.rollup,
    compare: members.compare,
    applyEpsilon: members.applyEpsilon,
    mergeRows: members.mergeRows,
  });
}

/**
 * Registry of every shipped kind module. Keys mirror the per-kind schema
 * filenames so a future "list all kinds" iterator can stay declarative.
 */
const KIND_MODULES = Object.freeze({
  lint: bindKindModule({
    name: lintName,
    keyField: lintKeyField,
    kernelVersion: lintKernelVersion,
    projectRow: lintProjectRow,
    sortRows: lintSortRows,
    rollup: lintRollup,
    compare: lintCompare,
    applyEpsilon: lintApplyEpsilon,
    mergeRows: lintMergeRows,
  }),
  coverage: bindKindModule({
    name: coverageName,
    keyField: coverageKeyField,
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
    kernelVersion: crapKernelVersion,
    projectRow: crapProjectRow,
    sortRows: crapSortRows,
    rollup: crapRollup,
    compare: crapCompare,
    applyEpsilon: crapApplyEpsilon,
    mergeRows: crapMergeRows,
  }),
  maintainability: bindKindModule({
    name: maintainabilityName,
    keyField: maintainabilityKeyField,
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
    kernelVersion: mutationKernelVersion,
    projectRow: mutationProjectRow,
    sortRows: mutationSortRows,
    rollup: mutationRollup,
    compare: mutationCompare,
    applyEpsilon: mutationApplyEpsilon,
    mergeRows: mutationMergeRows,
  }),
  lighthouse: bindKindModule({
    name: lighthouseName,
    keyField: lighthouseKeyField,
    kernelVersion: lighthouseKernelVersion,
    projectRow: lighthouseProjectRow,
    sortRows: lighthouseSortRows,
    rollup: lighthouseRollup,
    compare: lighthouseCompare,
    applyEpsilon: lighthouseApplyEpsilon,
    mergeRows: lighthouseMergeRows,
  }),
  'bundle-size': bindKindModule({
    name: bundleSizeName,
    keyField: bundleSizeKeyField,
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
