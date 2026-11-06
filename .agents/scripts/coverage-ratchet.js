#!/usr/bin/env node
/**
 * coverage-ratchet.js — CI's hand-back for a Story whose coverage capture was
 * deferred to CI (`Coverage-deferred:` in the PR body). Adopts the artifact
 * CI produced at `--head`, then runs the per-file coverage and CRAP value
 * ratchet over it against `--base`. Exit 0: the ratchet holds; 1: refused
 * or a ratchet step failed (named on stderr).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnChild } from './lib/child-exec.js';
import { runAsCli } from './lib/cli-utils.js';
import { getQuality, resolveConfig } from './lib/config-resolver.js';
import {
  adoptArtifact,
  parseRatchetArgs,
  ratchetSteps,
  scoreRatchet,
} from './lib/coverage-ratchet.js';
import { Logger } from './lib/Logger.js';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

const USAGE = {
  invocation:
    'node .agents/scripts/coverage-ratchet.js --artifact <path> --head <sha> [--scope affected|full] [--base <ref>] [--adopt-only]',
  summary:
    "Adopt a CI-produced Istanbul coverage-final.json at the checked-out HEAD (placed at `delivery.quality.gates.coverage.coveragePath` and stamped like a green local capture), then run the coverage and CRAP value ratchet over it. CI's sharding and artifact merging stay the consumer's job.",
  flags: [
    ['--artifact <path>', 'The CI-produced coverage-final.json.'],
    [
      '--head <sha>',
      'The commit the artifact measured; refused unless it is the checked-out HEAD.',
    ],
    [
      '--scope affected|full',
      'What the artifact measured. Default `affected`.',
    ],
    ['--base <ref>', 'The ratchet base. Default `origin/<baseBranch>`.'],
    [
      '--adopt-only',
      'Place and stamp the artifact, skip the ratchet (seat rows from it next).',
    ],
  ],
  notes: [
    'Refuses (exit 1) a dirty tracked tree and a missing or unparseable artifact.',
    'On a pull_request event pass `--head "$(git rev-parse HEAD)"` from the job that produced the artifact; this job must check out the same ref.',
  ],
};

/** Spawn one ratchet step in `cwd`, output passed through. */
function runStep(cwd) {
  return (args, env) =>
    spawnChild(process.execPath, args, {
      cwd,
      stdio: 'inherit',
      env: env ? { ...process.env, ...env } : process.env,
    }).status ?? 1;
}

async function main() {
  const cwd = process.cwd();
  const args = parseRatchetArgs(process.argv.slice(2));
  if (args.error) {
    Logger.error(`[coverage-ratchet] ✖ ${args.error}`);
    return 1;
  }
  const config = resolveConfig({ cwd });
  const base = args.base ?? `origin/${config?.project?.baseBranch ?? 'main'}`;
  const refusal = adoptArtifact({
    cwd,
    quality: getQuality(config),
    ...args,
    base,
  });
  if (refusal) {
    Logger.error(`[coverage-ratchet] ✖ refused: ${refusal}`);
    return 1;
  }
  Logger.info(
    `[coverage-ratchet] adopted ${args.artifact} at ${args.head} (${args.scope} scope)`,
  );
  if (args.adoptOnly) return 0;
  const { failedStep, status } = await scoreRatchet(
    ratchetSteps(SCRIPTS_DIR, base),
    runStep(cwd),
  );
  if (failedStep) {
    Logger.error(
      `[coverage-ratchet] ✖ ${failedStep} failed (exit ${status}) — the coverage/CRAP ratchet does not hold against ${base}`,
    );
    return 1;
  }
  Logger.info(
    `[coverage-ratchet] ✅ coverage and CRAP ratchet hold against ${base}`,
  );
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'coverage-ratchet',
  usage: USAGE,
  propagateExitCode: true,
});
