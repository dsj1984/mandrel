/**
 * base-sync-revalidation.js — `delivery.close.revalidateAfterBaseSync: "ci"`:
 * after a conflict-free base merge, hand typecheck, lint and the coverage
 * capture to the named CI checks instead of re-running them. All or nothing;
 * the first failing rule is the reason the close re-runs everything.
 */

import picomatch from 'picomatch';
import { COVERAGE_DEFERRED_REASONS } from '../coverage-deferral.js';
import {
  shouldSkip as defaultShouldSkip,
  hashCommandConfig,
} from '../validation-evidence.js';

const DEFERRABLE_GATES = new Set(['typecheck', 'lint', 'coverage-capture']);
const PREFLIGHT_GATES = ['typecheck', 'lint'];

/** @param {object|null|undefined} config @returns {'full'|'ci'} */
export function revalidationMode(config) {
  return config?.delivery?.close?.revalidateAfterBaseSync === 'ci'
    ? 'ci'
    : 'full';
}

/** Registered and not decided-skipped when the list was built. */
const isLive = (gate) => !gate.skip;

/** Does `gate` carry pass evidence at `sha` under its own config hash? */
function hasPassAt(gate, { sha, storyId, cwd, evidenceCwd, shouldSkipImpl }) {
  try {
    const verdict = shouldSkipImpl(
      {
        storyId,
        gateName: gate.name,
        currentSha: sha,
        configHash: hashCommandConfig({ cmd: gate.cmd, args: gate.args, cwd }),
      },
      { cwd: evidenceCwd ?? cwd, standalone: true },
    );
    return verdict?.skip === true;
  } catch {
    return false;
  }
}

/** Rules 1–3: is this a conflict-free merge with no always-revalidate path? */
function mergeIneligibility(baseSync, alwaysPaths) {
  const incoming = baseSync?.changedPaths ?? [];
  if (baseSync?.kind !== 'merge-commit' || incoming.length === 0) {
    return { reason: 'no-base-merge' };
  }
  if ((baseSync.resolvedBaselineFiles ?? []).length > 0) {
    return { reason: 'conflict-resolved' };
  }
  if (alwaysPaths.length === 0) return null;
  const matches = picomatch(alwaysPaths, { dot: true });
  const hit = incoming.find((path) => matches(path));
  return hit ? { reason: 'always-revalidate-path', detail: hit } : null;
}

/** Rules 4–6: does CI own the deferral and did handoff credit the pre-sync head? */
function ciIneligibility(gates, { ciChecks, config, ...probe }) {
  if (ciChecks.length === 0) return { reason: 'no-ci-checks' };
  const capture = gates.find(
    (g) => g.name === 'coverage-capture' && isLive(g) && !g.suiteOfRecordCi,
  );
  if (capture && !config.delivery.quality?.gates?.coverage?.ciRatchetCheck) {
    return { reason: 'no-ci-ratchet-check' };
  }
  for (const name of PREFLIGHT_GATES) {
    const gate = gates.find((g) => g.name === name && isLive(g));
    if (gate && !hasPassAt(gate, probe)) {
      return { reason: 'no-preflight-credit', detail: name };
    }
  }
  return null;
}

/**
 * Mark typecheck, lint and the capture `ciDeferred` when every rule holds;
 * otherwise return `gates` untouched with the failing rule as the reason.
 * `revalidation` is `null` unless the mode is `ci`.
 *
 * @param {import('./gates.js').Gate[]} gates
 * @param {{ baseSync: object|null, config: object|null, storyId: number, cwd: string, evidenceCwd?: string, log?: (m: string) => void, shouldSkipImpl?: typeof defaultShouldSkip }} opts
 * @returns {{ gates: import('./gates.js').Gate[], revalidation: object|null }}
 */
export function applyBaseSyncCiDeferral(
  gates,
  {
    baseSync,
    config,
    storyId,
    cwd,
    evidenceCwd,
    log,
    shouldSkipImpl = defaultShouldSkip,
  },
) {
  if (revalidationMode(config) !== 'ci') return { gates, revalidation: null };
  const close = config.delivery.close;
  const ciChecks = close.revalidateCiChecks ?? [];
  const fallback =
    mergeIneligibility(baseSync, close.revalidateAlwaysPaths ?? []) ??
    ciIneligibility(gates, {
      ciChecks,
      config,
      sha: baseSync.creditedCommit,
      storyId,
      cwd,
      evidenceCwd,
      shouldSkipImpl,
    });
  if (fallback) {
    log?.(
      `[close-validation] base-sync revalidation: running every gate (${fallback.reason}${fallback.detail ? `: ${fallback.detail}` : ''})`,
    );
    return {
      gates,
      revalidation: {
        mode: 'ci',
        applied: 'full',
        ...fallback,
        deferredGates: [],
        ciChecks,
      },
    };
  }
  const deferredGates = [];
  const ciDeferred = {
    reason: COVERAGE_DEFERRED_REASONS.baseSyncCi,
    checks: ciChecks,
  };
  const marked = gates.map((gate) => {
    if (!(DEFERRABLE_GATES.has(gate.name) && isLive(gate))) return gate;
    deferredGates.push(gate.name);
    return gate.suiteOfRecordCi ? gate : { ...gate, ciDeferred };
  });
  log?.(
    `[close-validation] base-sync revalidation: ${deferredGates.join(', ')} deferred to CI (${ciChecks.join(', ')})`,
  );
  return {
    gates: marked,
    revalidation: {
      mode: 'ci',
      applied: 'deferred-to-ci',
      reason: 'conflict-free-merge',
      deferredGates,
      ciChecks,
    },
  };
}
