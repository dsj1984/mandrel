/**
 * handoff-gates.js — the handoff's view of close's own gate list, so argv,
 * env and evidence keys never drift from close.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BASELINES_GATE_NAMES,
  buildDefaultGates,
  QUALITY_PREVIEW_GATE_NAMES,
} from '../close-validation/gates.js';
import {
  hashCommandConfig,
  recordPass,
  treeFingerprint,
} from '../validation-evidence.js';

const EVIDENCE_GATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'evidence-gate.js',
);

/** Close's gate list, built with the inputs its validation phase passes. */
function closeGates(ctx) {
  return buildDefaultGates({
    config: ctx.config,
    baseBranch: ctx.baseBranch,
    cwd: ctx.cwd,
    evidenceCwd: ctx.evidenceCwd,
    storyId: ctx.storyId,
    packageScripts: ctx.scripts,
    presentBaselines: ctx.presentBaselines,
    getChangedFilesImpl: ctx.getChangedFilesFn,
    gitSpawnImpl: ctx.git,
  });
}

/**
 * Close's `lint` and `format` entries wrapped in `evidence-gate.js` with the
 * argv close executes; a disabled or scoped-out gate deposits nothing.
 */
export function creditedPreflight(ctx) {
  const checks = [];
  for (const gate of closeGates(ctx).filter((g) =>
    ['lint', 'format'].includes(g.name),
  )) {
    const run = ctx.scopeGate({
      gate,
      spawnCwd: ctx.cwd,
      log: (m) => ctx.progress('preflight', m),
    });
    if (run.skip) continue;
    checks.push({
      key: gate.name,
      cmd: 'node',
      args: [
        EVIDENCE_GATE,
        '--standalone',
        '--scope-id',
        String(ctx.storyId),
        '--gate',
        gate.name,
        '--worktree',
        ctx.cwd,
        '--cwd',
        ctx.evidenceCwd,
        '--',
        run.cmd,
        ...run.args,
      ],
      deposit: { cmd: run.cmd, args: run.args },
      tolerateNoFilesProcessed: run.tolerateNoFilesProcessed,
    });
  }
  return checks;
}

/** The `lint` credit a clean preflight deposited, hashed as close hashes it. */
export function lintCredit(ctx, check) {
  return {
    head: ctx.head,
    configHash: hashCommandConfig({ ...check.deposit, cwd: ctx.cwd }),
  };
}

/**
 * Re-key the `lint` pass deposited at `priorHead` onto the seated HEAD. Not
 * `format`: its scoped argv names the changed files, which the seat changes.
 * Best-effort: a failed write only costs close a lint run.
 */
export function carryLintCredit(ctx, priorHead) {
  const credit = ctx.state.lintCredit;
  if (credit?.head !== priorHead) return;
  try {
    recordPass(
      {
        storyId: ctx.storyId,
        gateName: 'lint',
        sha: ctx.head,
        configHash: credit.configHash,
        inputFingerprint: treeFingerprint(ctx.cwd, ctx.git),
      },
      { cwd: ctx.evidenceCwd, standalone: true },
    );
    ctx.state.lintCredit = { ...credit, head: ctx.head };
  } catch (err) {
    ctx.progress('seat', `⚠️ lint credit not carried: ${err?.message ?? err}`);
  }
}

/** `quality-preview-crap` (capture depositor only) and every baselines entry. */
function postCaptureGates(ctx) {
  const names = new Set(Object.values(BASELINES_GATE_NAMES));
  if (ctx.depositor === 'coverage-capture') {
    names.add(QUALITY_PREVIEW_GATE_NAMES.crap);
  }
  return closeGates(ctx).filter((g) => names.has(g.name) && !g.skip);
}

/** The gate name, plus the kinds a baselines entry scores. */
function describeGate(gate) {
  const i = gate.args.indexOf('--gate');
  return i === -1 ? gate.name : `${gate.name} (kinds: ${gate.args[i + 1]})`;
}

/** Run each post-capture gate through `run`; the first non-zero exit is the finding. */
export async function scorePostCapture(ctx, run) {
  const gates = postCaptureGates(ctx);
  for (const gate of gates) {
    const env = gate.env ? { ...ctx.env, ...gate.env } : undefined;
    const res = await run(
      `post-capture-${gate.name}`,
      gate.cmd,
      gate.args,
      env,
    );
    if (res.status !== 0) {
      const finding = `${describeGate(gate)} finding (exit ${res.status}) — fix and commit, then re-run`;
      return {
        gates,
        failed: { gate: gate.name, finding, evidencePath: res.evidencePath },
      };
    }
  }
  return { gates, failed: null };
}
