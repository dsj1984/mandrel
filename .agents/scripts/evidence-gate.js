#!/usr/bin/env node

/**
 * evidence-gate.js — evidence-aware wrapper around a single shell gate.
 *
 * Tech Spec #819 §"Evidence record (Story 7)" — `/deliver` Phase 3
 * (close-validation) runs `npm run lint` and `npm test` against the Epic
 * branch before opening the PR.
 * If the same gate has already passed against the current `git rev-parse
 * HEAD` (recorded earlier in the local hot path), this wrapper logs a skip
 * and exits 0 instead of re-spawning the runner. On run, a successful
 * gate is recorded so the next invocation can skip in turn.
 *
 * Usage:
 *   node .agents/scripts/evidence-gate.js \
 *     (--epic-id <epicId> | --standalone) --scope-id <storyOrEpicId> --gate <name> \
 *     [--worktree <path>] [--no-evidence] -- <cmd> [args...]
 *
 * Examples:
 *   node .agents/scripts/evidence-gate.js --epic-id 802 --scope-id 817 --gate lint -- npm run lint
 *   node .agents/scripts/evidence-gate.js --epic-id 1030 --scope-id 1030 --gate test -- npm test
 *   node .agents/scripts/evidence-gate.js --epic-id 1114 --scope-id 1120 --gate test \
 *     --worktree .worktrees/story-1120 -- npm test
 *   node .agents/scripts/evidence-gate.js --standalone --scope-id 4250 --gate lint \
 *     --worktree .worktrees/story-4250 -- npm run lint
 *
 * Either `--epic-id` or `--standalone` is required. When `scope-id ===
 * epic-id` the evidence file is Epic-scoped
 * (`<tempRoot>/epic-<eid>/validation-evidence.json`); when `scope-id !==
 * epic-id` it is Story-scoped under
 * `<tempRoot>/epic-<eid>/story-<sid>/validation-evidence.json`. With
 * `--standalone` (Story #4250) the file is anchored on the Story id alone at
 * `<tempRoot>/standalone/stories/story-<sid>/validation-evidence.json` — the
 * same keyspace the standalone close consults, so the acceptance-self-eval
 * critic's verify[] runs (lint / typecheck) are shared with the close.
 *
 * **Worktree-aware spawn (Story #1120).** `--cwd` (default `PROJECT_ROOT`)
 * is the *evidence cwd* — it locates the per-Epic temp tree under the main
 * checkout's `.git/`. `--worktree` is the *spawn cwd* — when supplied, the
 * gate runner is launched with `cwd: <worktree>` and the HEAD-SHA used as
 * the evidence key is read from the worktree (so caching keys to the Story
 * branch's HEAD, not the main branch's). When `--worktree` is omitted,
 * spawn cwd falls back to `--cwd` (legacy single-tree behaviour).
 *
 * Exit codes:
 *   0 — gate passed (or skipped via evidence)
 *   N — gate failed (passes through the runner's exit code)
 *
 * `--no-evidence` forces the runner regardless of recorded state. The
 * evidence file is gitignored — evidence is a perf optimization, not a
 * trust boundary; pre-push hooks and CI continue to verify independently.
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
      'epic-id': { type: 'string' },
      gate: { type: 'string' },
      'no-evidence': { type: 'boolean', default: false },
      standalone: { type: 'boolean', default: false },
      cwd: { type: 'string' },
      worktree: { type: 'string' },
    },
    strict: false,
  });
  const scopeId = Number.parseInt(values['scope-id'] ?? '', 10);
  const epicId = Number.parseInt(values['epic-id'] ?? '', 10);
  return {
    scopeId: Number.isNaN(scopeId) || scopeId <= 0 ? null : scopeId,
    epicId: Number.isNaN(epicId) || epicId <= 0 ? null : epicId,
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
 * Runner-shaped entry-point: takes the parsed wrapper args + runner args and
 * executes the gate. Pure-ish (modulo IO) — all side-effects are routed via
 * the injection hooks so tests can stub `gitSpawn`, `spawnSync`, and the
 * evidence store without touching disk or spawning processes.
 *
 * Exported for tests + the CLI `main()`.
 *
 * @param {object} params
 * @param {number}   params.scopeId      — Story / Epic ID (positive integer).
 * @param {number|null} [params.epicId]  — Parent Epic id (Epic-keyed path).
 * @param {boolean}  [params.standalone] — When true, route to the
 *   storyId-anchored standalone keyspace instead of the Epic-keyed path
 *   (Story #4250). Substitutes for `epicId`.
 * @param {string}   params.gate         — Logical gate name (`lint`, `typecheck`, …).
 * @param {boolean}  params.useEvidence  — When false, force the runner.
 * @param {string}   params.cwd          — Evidence cwd (locates the per-Epic
 *   temp tree). The runner is spawned in `worktreePath` when set, else `cwd`.
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
    epicId,
    standalone = false,
    gate,
    useEvidence,
    cwd,
    worktreePath,
    runnerArgs,
  } = params ?? {};

  // `--epic-id` is required for the Epic-keyed path; `--standalone` (Story
  // #4250) substitutes for it and routes the evidence file to the
  // storyId-anchored standalone keyspace so the acceptance-self-eval critic
  // can record verify[] evidence into the same keyspace the standalone close
  // consults.
  if (
    !scopeId ||
    (!epicId && !standalone) ||
    !gate ||
    !runnerArgs ||
    runnerArgs.length === 0
  ) {
    logger.fatal(
      'Usage: node evidence-gate.js (--epic-id <epicId> | --standalone) --scope-id <id> --gate <name> [--worktree <path>] [--no-evidence] -- <cmd> [args...]',
    );
    return { status: 1, skipped: false };
  }
  // Evidence-store opts shared by shouldSkip + recordPass below. `standalone`
  // routes to the storyId-anchored keyspace; otherwise the Epic-keyed path
  // resolves under `epicId`.
  const evidenceStoreOpts = { cwd, epicId, standalone };

  // Spawn cwd is the worktree when supplied — every gate command sees the
  // Story branch's tree, not the main checkout. Evidence cwd stays anchored
  // to the main checkout so the per-Epic temp tree resolves under the main
  // `.git/`. The HEAD-SHA used as the cache key is read from the spawn cwd
  // (the worktree), so cache entries key against the Story branch's HEAD.
  const spawnCwd = worktreePath ?? cwd;
  const [cmd, ...cmdArgs] = runnerArgs;
  const configHash = hashCommandConfig({ cmd, args: cmdArgs, cwd: spawnCwd });
  const headSha = useEvidence
    ? resolveHeadShaDefault(spawnCwd, gitSpawnFn)
    : null;

  if (useEvidence && headSha) {
    const verdict = shouldSkipFn(
      {
        storyId: scopeId,
        gateName: gate,
        currentSha: headSha,
        configHash,
      },
      evidenceStoreOpts,
    );
    if (verdict.skip) {
      const ts = verdict.record?.timestamp ?? 'n/a';
      logger.info(
        `[evidence-gate] ⏭ ${gate} skipped (evidence match: SHA=${headSha.slice(0, 7)}, recorded ${ts})`,
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

runAsCli(import.meta.url, main, { source: 'evidence-gate' });
