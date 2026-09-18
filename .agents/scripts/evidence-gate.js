#!/usr/bin/env node

/**
 * Runs one gate, skipping it when evidence shows the same gate already
 * passed for the current HEAD and tree, and recording a pass for the next
 * caller. `--standalone` is required: it keys evidence by Story id, the same
 * keyspace close consults, so worker-side verify[] runs credit the close.
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

export function splitOnDashDash(argv) {
  const idx = argv.indexOf('--');
  if (idx === -1) return { wrapperArgs: argv, runnerArgs: [] };
  return {
    wrapperArgs: argv.slice(0, idx),
    runnerArgs: argv.slice(idx + 1),
  };
}

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
 * Read from the spawn cwd so the keys describe the tree the gate saw. The
 * tree fingerprint keeps credit across close's base-sync fast-forward, which
 * moves HEAD between deposit and spend.
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
 * @param {object} params
 * @param {number}   params.scopeId
 * @param {boolean}  [params.standalone]
 * @param {string}   params.gate
 * @param {boolean}  params.useEvidence
 * @param {string}   params.cwd          — evidence cwd (locates the temp tree)
 * @param {string|null} [params.worktreePath] — spawn cwd and HEAD source
 * @param {string[]} params.runnerArgs
 * @param {object}   [deps]
 * @param {Function} [deps.gitSpawnFn]
 * @param {Function} [deps.spawnFn]
 * @param {Function} [deps.shouldSkipFn]
 * @param {Function} [deps.recordPassFn]
 * @param {object}   [deps.logger]
 * @returns {{ status: number, skipped: boolean }}
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
  const evidenceStoreOpts = { cwd, standalone };

  // The gate runs in the worktree; evidence stays anchored to the main
  // checkout so the temp tree resolves under the main `.git/`.
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
      'node .agents/scripts/evidence-gate.js --scope-id <id> --gate <name> [--standalone] [--no-evidence] [--cwd <path>] [--worktree <path>] -- <cmd> [args...]',
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
      [
        '-- <cmd> [args...]',
        'Required. The command this gate runs, passed through verbatim (never via a shell).',
      ],
    ],
    notes: [
      [
        'Everything after the first `--` is the gate. The stamp therefore describes',
        'what actually ran, whatever that is — which is how a project on any test',
        'runner earns the close `test` credit:',
        '',
        '  node .agents/scripts/evidence-gate.js --standalone --scope-id 4250 \\',
        '    --gate lint --worktree .worktrees/story-4250 -- npm run lint',
        '  node .agents/scripts/evidence-gate.js --standalone --scope-id 4250 \\',
        '    --gate test --worktree .worktrees/story-4250 -- npm test',
      ].join('\n'),
    ],
  },
});
