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

import * as bundleSize from './kinds/bundle-size.js';
import * as coverage from './kinds/coverage.js';
import * as crap from './kinds/crap.js';
import * as duplication from './kinds/duplication.js';
import * as lighthouse from './kinds/lighthouse.js';
import * as lint from './kinds/lint.js';
import * as maintainability from './kinds/maintainability.js';
import * as mutation from './kinds/mutation.js';

/**
 * Registry of every shipped kind module. Keys mirror the per-kind schema
 * filenames so a future "list all kinds" iterator can stay declarative.
 */
const KIND_MODULES = Object.freeze({
  lint,
  coverage,
  crap,
  maintainability,
  mutation,
  lighthouse,
  'bundle-size': bundleSize,
  duplication,
});

/**
 * Look up a kind module by name. Throws when the kind isn't registered so
 * callers can't silently fall through to undefined behaviour.
 *
 * @param {string} kind
 * @returns {{ name: string, kernelVersion: () => string, keyField: string,
 *           projectRow: (row: object) => object,
 *           sortRows: (rows: object[]) => object[],
 *           rollup: (rows: object[], components?: object[]) => object }}
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
