#!/usr/bin/env node

/**
 * ceremony-derive.js — derive a Story's acceptance ceremony from ground truth
 * (Story #5313).
 *
 * The deliver digest used to hand the worker a three-module import block to
 * paste into `node --input-type=module -e` — compute the change set, derive
 * the level, resolve the ceremony — and every hand-carried incantation is a
 * transcription risk (the object-vs-string `derivedLevel` slip alone routed a
 * whole class of Stories to the null fail-safe). This CLI is that block,
 * scripted: one invocation, one JSON object, computed from the branch rather
 * than recalled.
 *
 *   1. Compute the change set ONCE for `<base>...story-<id>`
 *      (`lib/orchestration/change-set.js`).
 *   2. Derive the change level and the sensitive-path classes from it
 *      (`lib/orchestration/review-depth.js#deriveChangeLevel`).
 *   3. Resolve the ceremony for the configured profile
 *      (`lib/orchestration/ceremony-routing.js#resolveCeremonyForRisk`).
 *
 * Stdout: a single JSON object —
 *   { storyId, baseRef, headRef, files, enumerated, level, classes, profile,
 *     mode, reason, verdictOwner }
 *
 * `files` is the one change set every acceptance critic must be handed; the
 * caller never lets a critic re-enumerate it. `files: null` means the diff
 * could not be enumerated, which routes to the fail-safe fresh critic.
 *
 * Exit codes: 0 on a derived decision (including the `null` fail-safe — an
 * unenumerable diff is a decision, not an error), 1 on a usage error.
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { getDeliveryRouting } from './lib/config/delivery-routing.js';
import { resolveConfig } from './lib/config-resolver.js';
import { resolveCeremonyForRisk } from './lib/orchestration/ceremony-routing.js';
import { computeChangeSet } from './lib/orchestration/change-set.js';
import { deriveChangeLevel } from './lib/orchestration/review-depth.js';

const USAGE = {
  invocation:
    'node .agents/scripts/ceremony-derive.js --story <id> [--base <ref>] [--cwd <path>]',
  summary:
    'Compute the Story change set once, derive its change level and sensitive-path classes, resolve the acceptance ceremony, and print one JSON object.',
  flags: [
    ['--story <id>', 'Story issue number; the head ref is story-<id>.'],
    [
      '--base <ref>',
      'Base ref for the three-dot diff (default: project.baseBranch, normally main).',
    ],
    [
      '--cwd <path>',
      'Checkout to run the diff in (default: the current directory).',
    ],
  ],
};

/**
 * Parse the CLI argv. Exported for tests.
 *
 * @param {string[]} argv
 * @returns {{ storyId: number|null, base: string|null, cwd: string|null }}
 */
export function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      story: { type: 'string' },
      base: { type: 'string' },
      cwd: { type: 'string' },
    },
    strict: false,
  });
  const storyId = Number.parseInt(values.story ?? '', 10);
  return {
    storyId: Number.isInteger(storyId) && storyId > 0 ? storyId : null,
    base: values.base ?? null,
    cwd: values.cwd ?? null,
  };
}

/**
 * The derivation itself — pure over its injected collaborators, so tests can
 * pin the envelope without spawning git or reading a config.
 *
 * @param {{ storyId: number, baseRef: string, cwd: string, ceremonyProfile: string }} input
 * @param {{
 *   computeChangeSetImpl?: typeof computeChangeSet,
 *   deriveChangeLevelImpl?: typeof deriveChangeLevel,
 *   resolveCeremonyImpl?: typeof resolveCeremonyForRisk,
 * }} [deps]
 * @returns {{
 *   storyId: number, baseRef: string, headRef: string,
 *   files: string[]|null, enumerated: boolean,
 *   level: 'low'|'high'|null, classes: string[],
 *   profile: string, mode: 'fresh'|'inline', reason: string,
 *   verdictOwner: 'fresh-critic'|'inline-self-eval',
 * }}
 */
export function deriveCeremony(
  { storyId, baseRef, cwd, ceremonyProfile },
  deps = {},
) {
  const {
    computeChangeSetImpl = computeChangeSet,
    deriveChangeLevelImpl = deriveChangeLevel,
    resolveCeremonyImpl = resolveCeremonyForRisk,
  } = deps;
  const headRef = `story-${storyId}`;
  const changeSet = computeChangeSetImpl({ baseRef, headRef, cwd });
  const { level, classes } = deriveChangeLevelImpl({
    changedFiles: changeSet.files,
  });
  // `derivedLevel` is the level STRING — handing the `{ level, classes }`
  // object here was the transcription slip this CLI exists to retire.
  const ceremony = resolveCeremonyImpl({
    derivedLevel: level,
    clusterIndex: 0,
    ceremonyProfile,
  });
  return {
    storyId,
    baseRef,
    headRef,
    files: changeSet.files,
    enumerated: changeSet.enumerated,
    level,
    classes,
    profile: ceremony.profile,
    mode: ceremony.mode,
    reason: ceremony.reason,
    verdictOwner: ceremony.verdictOwner,
  };
}

/**
 * CLI shell: resolve the config-backed defaults, derive, print.
 *
 * @param {string[]} [argv]
 * @param {{
 *   resolveConfigImpl?: typeof resolveConfig,
 *   stdout?: { write: (s: string) => void },
 *   cwd?: string,
 * } & Parameters<typeof deriveCeremony>[1]} [deps]
 * @returns {Promise<object>} the printed envelope
 */
export async function runCeremonyDeriveCli(
  argv = process.argv.slice(2),
  deps = {},
) {
  const {
    resolveConfigImpl = resolveConfig,
    stdout = process.stdout,
    cwd: defaultCwd = process.cwd(),
    ...derivationDeps
  } = deps;
  const { storyId, base, cwd } = parseArgv(argv);
  if (!storyId) {
    throw new Error(
      'ceremony-derive: --story <id> is required (a positive integer).',
    );
  }
  const workCwd = cwd ?? defaultCwd;
  const config = resolveConfigImpl({ cwd: workCwd });
  const envelope = deriveCeremony(
    {
      storyId,
      baseRef: base ?? config?.project?.baseBranch ?? 'main',
      cwd: workCwd,
      ceremonyProfile: getDeliveryRouting(config).ceremonyProfile,
    },
    derivationDeps,
  );
  stdout.write(`${JSON.stringify(envelope)}\n`);
  return envelope;
}

async function main() {
  await runCeremonyDeriveCli();
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'ceremony-derive',
  propagateExitCode: true,
  errorPrefix: '[ceremony-derive] ❌ Fatal error',
  usage: USAGE,
});
