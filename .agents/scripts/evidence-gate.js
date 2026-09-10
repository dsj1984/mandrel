#!/usr/bin/env node

/**
 * evidence-gate.js — evidence-aware wrapper around a single shell gate.
 *
 * Tech Spec #819 §"Evidence record (Story 7)" — `/mandrel-deliver` Phase 3
 * (close-validation) runs `npm run lint` and `npm test` against the Epic
 * branch before opening the PR.
 * If the same gate has already passed against the current `git rev-parse
 * HEAD` (recorded earlier in the local hot path), this wrapper logs a skip
 * and exits 0 instead of re-spawning the runner. On run, a successful
 * gate is recorded so the next invocation can skip in turn.
 *
 * Usage:
 *   node .agents/scripts/evidence-gate.js \
 *     --standalone --scope-id <storyId> --gate <name> \
 *     [--worktree <path>] [--no-evidence] -- <cmd> [args...]
 *
 * Examples:
 *   node .agents/scripts/evidence-gate.js --standalone --scope-id 4250 --gate lint \
 *     --worktree .worktrees/story-4250 -- npm run lint
 *   node .agents/scripts/evidence-gate.js --standalone --scope-id 4250 --gate test \
 *     --worktree .worktrees/story-4250 -- npm test
 *
 * `--standalone` (Story #4250) is required: the evidence file is anchored on
 * the Story id at
 * `<tempRoot>/standalone/stories/story-<sid>/validation-evidence.json` — the
 * same keyspace the standalone close consults, so the acceptance-self-eval
 * critic's verify[] runs (lint / typecheck) are shared with the close.
 * v2.0.0 removed the Epic tier along with the `--epic-id` Epic-keyed
 * keyspace.
 */

import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { gitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { PROJECT_ROOT } from './lib/project-root.js';
import {
  hashCommandConfig,
  recordPass,
  shouldSkip,
  treeFingerprint,
} from './lib/validation-evidence.js';

/**
 * Split argv at the first `--` and return both halves. The wrapper consumes
 * everything before `--`; the runner receives everything after.
 *
 * Exported for testing.
 */
export function splitOnDashDash(argv) {
  const idx = argv.indexOf('--');
  if (idx === -1) return { wrapperArgs: argv, runnerArgs: [] };
  return {
    wrapperArgs: argv.slice(0, idx),
    runnerArgs: argv.slice(idx + 1),
  };
}

/**
 * Parse the wrapper-side argv (before `--`).
 *
 * Exported for testing.
 */
export function parseWrapperArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'scope-id': { type: 'string' },
      gate: { type: 'string' },
      'no-evidence': { type: 'boolean', default: false },
      standalone: { type: 'boolean', default: false },
      cwd: { type: 'string' },
      worktree: { type: 'string' },
    },
    strict: false,
  });
  const scopeId = Number.parseInt(values['scope-id'] ?? '', 10);
  return {
    scopeId: Number.isNaN(scopeId) || scopeId <= 0 ? null : scopeId,
    standalone: values.standalone === true,
    gate: values.gate ?? null,
    useEvidence: values['no-evidence'] !== true,
    cwd: values.cwd ?? PROJECT_ROOT,
    worktreePath: values.worktree ?? null,
  };
}

function resolveHeadShaDefault(cwd, gitSpawnFn) {
  const res = gitSpawnFn(cwd, 'rev-parse', 'HEAD');
  if (res.status !== 0) return null;
  const sha = (res.stdout || '').trim();
  return sha.length > 0 ? sha : null;
}

/**
 * The pair of keys an evidence record is written and read under: the commit
 * this gate ran at, and the content identity of the tree it ran against
 * (Story #5278).
 *
 * Both are read from the **spawn** cwd — the Story worktree when one is
 * supplied — so the keys describe the tree the gate actually saw. The tree
 * fingerprint is what keeps this gate credited across close's own base-sync
 * fast-forward, which moves HEAD between the deposit and the gates that would
 * spend it; see `validation-evidence.js#treeFingerprint`.
 *
 * @param {{ spawnCwd: string, gitSpawnFn: Function, useEvidence: boolean }} args
 * @returns {{ headSha: string|null, inputFingerprint: string|null }}
 */
function resolveEvidenceKeys({ spawnCwd, gitSpawnFn, useEvidence }) {
  if (!useEvidence) return { headSha: null, inputFingerprint: null };
  return {
    headSha: resolveHeadShaDefault(spawnCwd, gitSpawnFn),
    inputFingerprint: treeFingerprint(spawnCwd, gitSpawnFn),
  };
}

/**
 * Runner-shaped entry-point: takes the parsed wrapper args + runner args and
 * executes the gate. Pure-ish (modulo IO) — all side-effects are routed via
 * the injection hooks so tests can stub `gitSpawn`, `spawnSync`, and the
 * evidence store without touching disk or spawning processes.
 *
 * Exported for tests + the CLI `main()`.
 *
 * @param {object} params
 * @param {number}   params.scopeId      — Story ID (positive integer).
 * @param {boolean}  [params.standalone] — Required. Routes to the
 *   storyId-anchored standalone keyspace (Story #4250).
 * @param {string}   params.gate         — Logical gate name (`lint`, `typecheck`, …).
 * @param {boolean}  params.useEvidence  — When false, force the runner.
 * @param {string}   params.cwd          — Evidence cwd (locates the temp
 *   tree). The runner is spawned in `worktreePath` when set, else `cwd`.
 * @param {string|null} [params.worktreePath] — Spawn cwd override (Story #1120).
 *   When set, the runner runs in the Story worktree and the HEAD-SHA used as
 *   the evidence cache key is read from the worktree, not from `cwd`.
 * @param {string[]} params.runnerArgs   — `[cmd, ...args]` from after `--`.
 * @param {object}   [deps]              — Optional injection hooks (tests).
 * @param {Function} [deps.gitSpawnFn]   — Stub for `gitSpawn`.
 * @param {Function} [deps.spawnFn]      — Stub for `spawnSync`.
 * @param {Function} [deps.shouldSkipFn] — Stub for `shouldSkip`.
 * @param {Function} [deps.recordPassFn] — Stub for `recordPass`.
 * @param {object}   [deps.logger]       — Logger-shaped object (info/error/warn/fatal).
 * @returns {{ status: number, skipped: boolean }} Outcome summary. `status`
 *   is the runner's exit code (0 = pass), `skipped` is true when evidence
 *   short-circuited the runner.
 */
export async function runEvidenceGate(params, deps = {}) {
  const {
    gitSpawnFn = gitSpawn,
    spawnFn = spawnSync,
    shouldSkipFn = shouldSkip,
    recordPassFn = recordPass,
    logger = Logger,
  } = deps;
  const {
    scopeId,
    standalone = false,
    gate,
    useEvidence,
    cwd,
    worktreePath,
    runnerArgs,
  } = params ?? {};

  // `--standalone` (Story #4250) routes the evidence file to the
  // storyId-anchored keyspace so the acceptance-self-eval critic can record
  // verify[] evidence into the same keyspace the standalone close consults.
  if (
    !scopeId ||
    !standalone ||
    !gate ||
    !runnerArgs ||
    runnerArgs.length === 0
  ) {
    logger.fatal(
      'Usage: node evidence-gate.js --standalone --scope-id <id> --gate <name> [--worktree <path>] [--no-evidence] -- <cmd> [args...]',
    );
    return { status: 1, skipped: false };
  }
  // Evidence-store opts shared by shouldSkip + recordPass below.
  const evidenceStoreOpts = { cwd, standalone };

  // Spawn cwd is the worktree when supplied — every gate command sees the
  // Story branch's tree, not the main checkout. Evidence cwd stays anchored
  // to the main checkout so the temp tree resolves under the main
  // `.git/`. The HEAD-SHA used as the cache key is read from the spawn cwd
  // (the worktree), so cache entries key against the Story branch's HEAD.
  const spawnCwd = worktreePath ?? cwd;
  const [cmd, ...cmdArgs] = runnerArgs;
  const configHash = hashCommandConfig({ cmd, args: cmdArgs, cwd: spawnCwd });
  const { headSha, inputFingerprint } = resolveEvidenceKeys({
    spawnCwd,
    gitSpawnFn,
    useEvidence,
  });

  if (useEvidence && headSha) {
    const verdict = shouldSkipFn(
      {
        storyId: scopeId,
        gateName: gate,
        currentSha: headSha,
        configHash,
        inputFingerprint,
      },
      evidenceStoreOpts,
    );
    if (verdict.skip) {
      const ts = verdict.record?.timestamp ?? 'n/a';
      logger.info(
        `[evidence-gate] ⏭ ${gate} skipped (${verdict.reason}: SHA=${headSha.slice(0, 7)}, recorded ${ts})`,
      );
      return { status: 0, skipped: true };
    }
  }

  const startedAt = Date.now();
  logger.info(
    `[evidence-gate] ▶ ${gate} → ${cmd} ${cmdArgs.join(' ')} (cwd=${spawnCwd})`,
  );
  const result = spawnFn(cmd, cmdArgs, {
    cwd: spawnCwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const status = result.status ?? 1;
  if (status !== 0) {
    process.exitCode = status;
    logger.error(
      `[evidence-gate] ✖ ${gate} failed (exit ${status}) in ${spawnCwd}`,
    );
    return { status, skipped: false };
  }

  logger.info(`[evidence-gate] ✓ ${gate} passed`);
  if (useEvidence && headSha) {
    try {
      recordPassFn(
        {
          storyId: scopeId,
          gateName: gate,
          sha: headSha,
          configHash,
          exitCode: 0,
          durationMs: Date.now() - startedAt,
          inputFingerprint,
        },
        evidenceStoreOpts,
      );
    } catch (err) {
      logger.warn?.(
        `[evidence-gate]   ⚠ failed to record evidence: ${err?.message ?? err}`,
      );
    }
  }
  return { status: 0, skipped: false };
}

async function main() {
  const { wrapperArgs, runnerArgs } = splitOnDashDash(process.argv.slice(2));
  const args = parseWrapperArgs(wrapperArgs);
  await runEvidenceGate({ ...args, runnerArgs });
}

runAsCli(import.meta.url, main, {
  source: 'evidence-gate',
  usage: {
    invocation:
      'node .agents/scripts/evidence-gate.js --scope-id <id> --gate <name> [--standalone] [--no-evidence] [--cwd <path>] [--worktree <path>]',
    summary:
      'Run one named gate, reusing a prior evidence stamp for the same HEAD instead of re-running it.',
    flags: [
      ['--scope-id <id>', 'Story id the evidence is scoped to (required).'],
      ['--gate <name>', 'Gate to run (e.g. lint, typecheck) (required).'],
      ['--standalone', 'Run outside a close pipeline and stamp the evidence.'],
      [
        '--no-evidence',
        'Ignore and do not write evidence — always run the gate.',
      ],
      ['--cwd <path>', 'Repository root (default: project root).'],
      ['--worktree <path>', 'Worktree the gate runs in.'],
    ],
  },
});
