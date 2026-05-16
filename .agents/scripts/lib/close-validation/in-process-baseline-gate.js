// .agents/scripts/lib/close-validation/in-process-baseline-gate.js
/**
 * in-process-baseline-gate.js — Story #1973 / Task #1984.
 *
 * Builds a `Gate.run` async function that evaluates the regression compare
 * for a single per-kind baseline (`maintainability`, `crap`, `mutation`)
 * **in process**, by importing `compare(head, base)` directly from the
 * per-kind module under `.agents/scripts/lib/baselines/kinds/`. The
 * resulting gate exits 0 on no regression, exits 1 when the per-kind
 * compare returns at least one regression, and exits 0 (treating the
 * absence of base data as "no compare data, no regression") when the base
 * baseline is missing.
 *
 * Replaces the historical `child_process.spawn(node check-<kind>.js)`
 * gate path so close-validation no longer fans out per-kind subprocesses
 * for the regression compare. The unified `check-baselines` gate retains
 * the canonical floor + tolerance + schema enforcement (Epic #1943).
 *
 * Pure helpers; no side effects beyond the read-only `git show` issued by
 * `readBaseFromGit`. All collaborators are injectable for unit tests.
 */

import { readBaseFromGit as defaultReadBaseFromGit } from '../baselines/git-base.js';
import * as crapKind from '../baselines/kinds/crap.js';
import * as maintainabilityKind from '../baselines/kinds/maintainability.js';
import * as mutationKind from '../baselines/kinds/mutation.js';
import { load as defaultLoadHeadBaseline } from '../baselines/reader.js';

/**
 * Per-kind module registry — only the kinds that previously had a
 * standalone `check-<kind>.js` gate in `buildDefaultGates` are wired.
 * Coverage / lint / lighthouse / bundle-size never had per-kind gates in
 * close-validation; the unified `check-baselines` gate covers them.
 */
const KIND_MODULES = Object.freeze({
  maintainability: maintainabilityKind,
  crap: crapKind,
  mutation: mutationKind,
});

/**
 * Default on-disk paths for each baseline. Mirrors the canonical defaults
 * in `baselines/reader.js`. Repos that relocate a baseline configure it
 * via `delivery.quality.gates.<kind>.baselinePath`; the head reader honours
 * that override automatically. The git base reader needs the same path
 * resolved against the base ref, so we mirror it here.
 */
const DEFAULT_BASELINE_PATHS = Object.freeze({
  maintainability: 'baselines/maintainability.json',
  crap: 'baselines/crap.json',
  mutation: 'baselines/mutation.json',
});

/**
 * Resolve the relative baseline path for a kind from agent settings, with
 * a canonical default fallback. Mirrors `check-baselines.js` lookup so the
 * in-process gate reads the same file as the unified dispatcher.
 *
 * @param {string} kind
 * @param {object} [agentSettings]
 * @returns {string}
 */
export function resolveBaselineRelativePath(kind, agentSettings) {
  const gateBlock =
    agentSettings?.delivery?.quality?.gates?.[kind] ??
    agentSettings?.quality?.gates?.[kind] ??
    null;
  if (gateBlock?.baselinePath && typeof gateBlock.baselinePath === 'string') {
    return gateBlock.baselinePath;
  }
  return DEFAULT_BASELINE_PATHS[kind];
}

/**
 * Read the base baseline JSON envelope from the supplied ref via
 * `readBaseFromGit`. Returns `null` when the file is absent at the ref or
 * cannot be parsed; callers then treat that as "no compare data, no
 * regression" — matching `check-baselines.js` § evaluateCompare semantics.
 *
 * @param {{ ref: string|null, baselineRel: string, cwd: string,
 *           readBaseFromGit?: typeof defaultReadBaseFromGit }} opts
 * @returns {object|null}
 */
export function readBaseEnvelope({
  ref,
  baselineRel,
  cwd,
  readBaseFromGit = defaultReadBaseFromGit,
}) {
  if (!ref) return null;
  let raw;
  try {
    raw = readBaseFromGit(ref, baselineRel, { cwd });
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Format a compare-stage regression list into a single advisory line for
 * the gate log. Truncates after the first five regressions so a noisy
 * regression set does not flood the operator's terminal.
 *
 * @param {string} kind
 * @param {Array<{ key: string }>} regressions
 * @returns {string[]}
 */
export function formatRegressionLines(kind, regressions) {
  const head = `[${kind}] ${regressions.length} regression(s) detected:`;
  const sample = regressions.slice(0, 5).map((r) => `  • ${r.key}`);
  const more =
    regressions.length > sample.length
      ? [`  • … and ${regressions.length - sample.length} more`]
      : [];
  return [head, ...sample, ...more];
}

/**
 * Build a `Gate.run` callable that evaluates the per-kind regression
 * compare in-process. The returned function honours the runner contract
 * (`{ status: number }`) and never spawns a per-kind CLI. The base ref is
 * read via `readBaseFromGit` (which spawns `git show` once per
 * `(ref, file)` tuple under an LRU cache); the head baseline is read via
 * the shared `baselines/reader.load`.
 *
 * @param {{
 *   kind: 'maintainability'|'crap'|'mutation',
 *   epicBranch?: string|null,
 *   agentSettings?: object,
 *   loadHeadBaseline?: typeof defaultLoadHeadBaseline,
 *   readBaseFromGit?: typeof defaultReadBaseFromGit,
 *   kindModule?: object,
 * }} opts
 * @returns {(cmd?: string, args?: string[], runOpts?: { cwd: string, log?: (m: string) => void }) => Promise<{ status: number }>}
 */
export function buildInProcessBaselineGate({
  kind,
  epicBranch,
  agentSettings,
  loadHeadBaseline = defaultLoadHeadBaseline,
  readBaseFromGit = defaultReadBaseFromGit,
  kindModule,
}) {
  const resolvedKindModule = kindModule ?? KIND_MODULES[kind];
  if (!resolvedKindModule || typeof resolvedKindModule.compare !== 'function') {
    throw new Error(
      `[in-process-baseline-gate] no compare() exported for kind="${kind}"`,
    );
  }
  const baselineRel = resolveBaselineRelativePath(kind, agentSettings);

  return async function runInProcessBaselineGate(_cmd, _args, runOpts = {}) {
    const cwd = runOpts.cwd ?? process.cwd();
    const log =
      typeof runOpts.log === 'function'
        ? runOpts.log
        : (m) => process.stdout.write(`${m}\n`);

    // Stage A — read the head baseline. The in-process gate is the
    // *regression-compare* arm only; schema and read enforcement is the
    // unified `check-baselines` gate's job (Epic #1943). Treating a
    // read/schema failure here as "skip the compare, status 0" keeps the
    // per-kind gate's semantics narrow — it can't double-report a config
    // error that check-baselines is about to surface — and matches the
    // historical behaviour where the per-kind CLI's missing-baseline
    // path also returned a clean exit when the gate scope did not yet
    // include the file (e.g. the very first close on a fresh repo).
    let headBaseline;
    try {
      headBaseline = loadHeadBaseline(kind, { cwd });
    } catch (err) {
      log(`[${kind}] head baseline read skipped: ${err?.message ?? err}`);
      return { status: 0 };
    }

    // Stage B — read the base envelope at the Epic ref. Missing base data
    // is treated as "no compare data, no regression" (matches
    // check-baselines.js § evaluateCompare).
    if (!epicBranch) {
      log(`[${kind}] no base ref configured; compare skipped`);
      return { status: 0 };
    }
    const baseEnvelope = readBaseEnvelope({
      ref: epicBranch,
      baselineRel,
      cwd,
      readBaseFromGit,
    });
    if (!baseEnvelope) {
      log(`[${kind}] base baseline absent at ${epicBranch}; compare skipped`);
      return { status: 0 };
    }

    // Stage C — pure compare via the per-kind module.
    let result;
    try {
      result = resolvedKindModule.compare(
        { rows: Array.isArray(headBaseline?.rows) ? headBaseline.rows : [] },
        { rows: Array.isArray(baseEnvelope?.rows) ? baseEnvelope.rows : [] },
      );
    } catch (err) {
      // Compare-side failure is advisory in check-baselines.js; mirror
      // that by treating it as "no regression" so the in-process gate
      // never escalates a kernel bug to a hard failure.
      log(`[${kind}] compare failed (advisory): ${err?.message ?? err}`);
      return { status: 0 };
    }

    const regressions = Array.isArray(result?.regressions)
      ? result.regressions
      : [];
    if (regressions.length === 0) {
      return { status: 0 };
    }
    for (const line of formatRegressionLines(kind, regressions)) log(line);
    return { status: 1 };
  };
}

export const __INTERNAL__ = { KIND_MODULES, DEFAULT_BASELINE_PATHS };
