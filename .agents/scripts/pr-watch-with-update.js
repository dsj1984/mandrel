#!/usr/bin/env node
/**
 * pr-watch-with-update.js — the single CI-watch mechanism for the Story
 * delivery path (`helpers/deliver-story.md` Step 4). Story #4358 retired
 * the bare `gh pr checks --watch` so every caller drives this one CLI.
 *
 * Polls the PR's required checks to a terminal state and auto-recovers
 * from `mergeStateStatus: BEHIND` (via bounded `gh pr update-branch`
 * calls) by delegating to the shared `watchPrToTerminal` primitive in
 * the lifecycle `Watcher` — the SAME loop the listener runs, so the CLI
 * and the bus path are byte-for-byte equivalent. No lifecycle bus is
 * created; this is a direct, synchronous watch with a real exit code.
 *
 * Slow-vs-failed semantics (Story #4358):
 *   - GREEN — every required check terminal + green → exit 0.
 *   - RED   — one or more required checks genuinely failed → exit 1
 *             IMMEDIATELY, consuming no resume budget. On red the CLI
 *             writes `temp/story-<id>-ci-digest.{json,md}` (failing check
 *             name, run id, a `gh run view --log-failed` tail, and a
 *             coarse classification) and prints the red-green
 *             remediation handoff. The digest is scoped by filename, so
 *             it requires `--story` (Story #4539: the digest was
 *             Epic-scoped and therefore never written on the only
 *             delivery path v2 has).
 *   - STILL-RUNNING — the poll cap fired with checks still pending and
 *             none failed; the watcher re-armed up to
 *             `delivery.ci.watch.maxResumes` times, then returned a
 *             `still-running` verdict → exit 2 (NEVER 1, NEVER
 *             `timed_out`). The CLI prints the `gh pr checks --watch`
 *             handoff so the host can keep polling on its own cadence.
 *
 * Config (Story #4356 namespace, read via `getCiDelivery`):
 *   - `delivery.ci.watch.pollIntervalMs`
 *   - `delivery.ci.watch.maxPolls`
 *   - `delivery.ci.watch.maxResumes`
 *   CLI flags override config; config overrides the framework fallback.
 *
 * Usage:
 *   node .agents/scripts/pr-watch-with-update.js --pr <n> --story <id>
 *     [--repo owner/repo] [--max-updates N] [--poll-interval-ms MS]
 *     [--max-polls N] [--max-resumes N]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { getCiDelivery } from './lib/config/ci.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { watchPrToTerminal } from './lib/orchestration/lifecycle/listeners/watcher.js';

/** Framework fallbacks when neither a CLI flag nor config supplies a value. */
export const WATCH_DEFAULTS = Object.freeze({
  pollIntervalMs: 10_000,
  maxPolls: 180,
  maxUpdates: 3,
  maxResumes: 3,
});

/** Exit code reserved for the slow-but-not-red `still-running` verdict. */
export const STILL_RUNNING_EXIT_CODE = 2;

function parsePositiveInt(raw, fallback) {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Resolve the effective poll knobs: CLI flag → `delivery.ci.watch.*` →
 * framework fallback. Pure (given a config bag) — exported for tests so
 * the precedence ladder is reviewable. `flags` are the raw string values
 * from `parseArgs` (or numbers, in tests); a nullish flag falls through
 * to config, and a nullish config field falls through to the default.
 *
 * @param {object} opts
 * @param {object|null} [opts.config]  resolved config (or a bare bag).
 * @param {object} [opts.flags]        `{ pollIntervalMs, maxPolls, maxResumes, maxUpdates }`.
 * @returns {{ pollIntervalMs: number, maxPolls: number, maxResumes: number, maxUpdates: number }}
 */
export function resolveWatchKnobs({ config, flags = {} } = {}) {
  const watch = getCiDelivery(config).watch ?? {};
  const pick = (flag, cfg, dflt) =>
    parsePositiveInt(flag, Number.isInteger(cfg) && cfg >= 0 ? cfg : dflt);
  return {
    pollIntervalMs: pick(
      flags.pollIntervalMs,
      watch.pollIntervalMs,
      WATCH_DEFAULTS.pollIntervalMs,
    ),
    maxPolls: pick(flags.maxPolls, watch.maxPolls, WATCH_DEFAULTS.maxPolls),
    maxResumes: pick(
      flags.maxResumes,
      watch.maxResumes,
      WATCH_DEFAULTS.maxResumes,
    ),
    maxUpdates: pick(flags.maxUpdates, undefined, WATCH_DEFAULTS.maxUpdates),
  };
}

/**
 * Coarse failure classification from a failing-check name. Pure —
 * exported for tests. Deliberately shallow: it steers the operator's
 * next move (which `/loop` unit to reach for), not a root-cause verdict.
 *
 * @param {string} name  failing required-check name.
 * @returns {'test'|'lint'|'baseline'|'build'|'unknown'}
 */
export function classifyFailure(name) {
  const n = String(name ?? '').toLowerCase();
  if (/lint|format|biome|markdownlint/.test(n)) return 'lint';
  if (/baseline|coverage|crap|maintainab|duplicat/.test(n)) return 'baseline';
  if (/build|compile|typecheck|bundle/.test(n)) return 'build';
  if (/test|spec|validate|ci|check/.test(n)) return 'test';
  return 'unknown';
}

/**
 * Default `gh run view --log-failed` spawn — pulls the tail of the failed
 * job log so the digest carries an actionable excerpt. Best-effort:
 * returns an empty tail when the run id is unknown or `gh` errors.
 * Exported indirectly via `writeCiDigest` injection so tests can stub
 * without shelling out.
 */
function ghRunLogTail({ runId, cwd, spawnFn = spawnSync, maxLines = 40 }) {
  if (!runId) return '';
  const result = spawnFn('gh', ['run', 'view', String(runId), '--log-failed'], {
    cwd,
    encoding: 'utf-8',
    shell: false,
    maxBuffer: 10 * 1024 * 1024,
  });
  const out = (result.stdout ?? '').trim();
  if (out.length === 0) return '';
  const lines = out.split('\n');
  return lines.slice(-maxLines).join('\n');
}

/**
 * Resolve the GitHub Actions run id for a failing check. Best-effort via
 * `gh pr checks --json name,link` — the `link` field carries the run URL
 * whose trailing path segment is the run id. Returns `null` when
 * unresolvable.
 */
function resolveRunId({ prRef, checkName, cwd, spawnFn = spawnSync }) {
  const result = spawnFn('gh', ['pr', 'checks', prRef, '--json', 'name,link'], {
    cwd,
    encoding: 'utf-8',
    shell: false,
  });
  try {
    const parsed = JSON.parse((result.stdout ?? '').trim() || '[]');
    const entry = Array.isArray(parsed)
      ? parsed.find((e) => e?.name === checkName)
      : null;
    const link = entry?.link ?? '';
    const m = /\/runs\/(\d+)/.exec(String(link));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Resolve which ticket the digest is keyed to. Story #4539: the digest used
 * to be Epic-scoped by filename and returned `null` without an epic id — so
 * on the v2 Story path (which has no Epic and invokes the watch with `--pr`
 * alone) a red check wrote no digest at all, despite the module header
 * advertising one. v2.0.0 removed the Epic tier; Story scope is the only
 * scope.
 *
 * @param {{ storyId?: number|string|null }} opts
 * @returns {{ kind: 'story', id: number } | null}
 */
export function resolveDigestScope({ storyId = null } = {}) {
  if (storyId == null || String(storyId).length === 0) return null;
  const parsed = Number.parseInt(String(storyId), 10);
  return Number.isInteger(parsed) && parsed > 0
    ? { kind: 'story', id: parsed }
    : null;
}

/**
 * Write the CI failure digest (`.json` + `.md`) for a red watch. Returns
 * the two paths written, or `null` when no story id was supplied (the
 * digest is scoped by filename and has nothing to key on). Exported for
 * tests.
 *
 * @param {object} opts
 * @param {number|string|null} [opts.storyId] The v2 delivery scope.
 * @param {number} opts.prNumber
 * @param {Array<{name:string, outcome:string}>} opts.failures
 * @param {string} opts.tempRoot
 * @param {string} opts.cwd
 * @param {string} opts.prRef
 * @param {Function} [opts.runIdFn]
 * @param {Function} [opts.logTailFn]
 * @returns {{ jsonPath: string, mdPath: string } | null}
 */
export function writeCiDigest({
  storyId = null,
  prNumber,
  failures,
  tempRoot,
  cwd,
  prRef,
  runIdFn = resolveRunId,
  logTailFn = ghRunLogTail,
}) {
  const scope = resolveDigestScope({ storyId });
  if (!scope) return null;
  const primary = failures[0] ?? { name: 'unknown', outcome: 'failure' };
  const runId = runIdFn({ prRef, checkName: primary.name, cwd });
  const logTail = logTailFn({ runId, cwd });
  const classification = classifyFailure(primary.name);
  const digest = {
    storyId: scope.id,
    prNumber,
    failingCheck: primary.name,
    failingOutcome: primary.outcome,
    runId,
    classification,
    allFailures: failures,
    logTail,
    generatedAt: new Date().toISOString(),
  };
  const dir = path.isAbsolute(tempRoot) ? tempRoot : path.join(cwd, tempRoot);
  mkdirSync(dir, { recursive: true });
  const base = `${scope.kind}-${scope.id}-ci-digest`;
  const jsonPath = path.join(dir, `${base}.json`);
  const mdPath = path.join(dir, `${base}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(digest, null, 2)}\n`);
  const md = [
    `# CI failure digest — Story #${scope.id} (PR #${prNumber})`,
    '',
    `- **Failing check:** \`${digest.failingCheck}\` (${digest.failingOutcome})`,
    `- **Run id:** ${runId ?? 'unresolved'}`,
    `- **Classification:** ${classification}`,
    `- **Generated:** ${digest.generatedAt}`,
    '',
    failures.length > 1
      ? `Other non-green checks: ${failures
          .slice(1)
          .map((f) => `\`${f.name}\`=${f.outcome}`)
          .join(', ')}`
      : '',
    '',
    '## `gh run view --log-failed` tail',
    '',
    '```text',
    logTail || '(no failed-log output available)',
    '```',
    '',
  ].join('\n');
  writeFileSync(mdPath, md);
  return { jsonPath, mdPath };
}

/**
 * Run the watch loop and resolve to the exit code. Exported for tests so
 * the green / red / still-running / BEHIND paths can be exercised with
 * injected `gh` spawns and no `process.exit`.
 *
 *   0 → all required checks green.
 *   1 → a required check genuinely failed (red).
 *   2 → still-running (slow CI): cap + resume budget exhausted, none red.
 *
 * @param {object} opts
 * @param {number} opts.prNumber
 * @param {string|null} [opts.repo]
 * @param {number|string} [opts.maxUpdates]
 * @param {number|string} [opts.pollIntervalMs]
 * @param {number|string} [opts.maxPolls]
 * @param {number|string} [opts.maxResumes]
 * @param {object|null} [opts.config]         resolved config (defaults to resolveConfig()).
 * @param {string} [opts.tempRoot]            digest output dir (default `temp`).
 * @param {Function} [opts.ghPrChecksFn]      inject for tests
 * @param {Function} [opts.ghPrViewFn]        inject for tests
 * @param {Function} [opts.ghPrUpdateBranchFn] inject for tests
 * @param {Function} [opts.sleepFn]           inject for tests
 * @param {Function} [opts.writeDigestFn]     inject for tests (default writeCiDigest)
 * @param {object} [opts.logger]
 * @param {(line: string) => void} [opts.print] stdout sink (default process.stdout)
 * @returns {Promise<number>} process exit code.
 */
export async function runPrWatch({
  prNumber,
  repo = null,
  storyId = null,
  maxUpdates,
  pollIntervalMs,
  maxPolls,
  maxResumes,
  config,
  tempRoot,
  ghPrChecksFn,
  ghPrViewFn,
  ghPrUpdateBranchFn,
  sleepFn,
  writeDigestFn = writeCiDigest,
  logger = Logger,
  print = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  if (!Number.isInteger(prNumber) || prNumber < 1)
    throw new TypeError('runPrWatch: --pr requires a positive integer');

  const resolvedConfig =
    config !== undefined ? config : safeResolveConfig(logger);
  const knobs = resolveWatchKnobs({
    config: resolvedConfig,
    flags: { pollIntervalMs, maxPolls, maxResumes, maxUpdates },
  });
  const effectiveTempRoot =
    tempRoot ?? resolvedConfig?.project?.paths?.tempRoot ?? 'temp';

  // `gh` accepts a bare PR number or a URL; passing `<repo>#<n>` lets
  // `gh` resolve the right repository without a URL. When `--repo` is
  // omitted, `gh` infers the repo from the cwd's remote.
  const prRef = repo ? `${repo}#${prNumber}` : String(prNumber);

  const result = await watchPrToTerminal({
    prUrl: prRef,
    cwd: process.cwd(),
    maxPolls: knobs.maxPolls,
    maxUpdates: knobs.maxUpdates,
    maxResumes: knobs.maxResumes,
    pollIntervalMs: knobs.pollIntervalMs,
    ...(ghPrChecksFn ? { ghPrChecksFn } : {}),
    ...(ghPrViewFn ? { ghPrViewFn } : {}),
    ...(ghPrUpdateBranchFn ? { ghPrUpdateBranchFn } : {}),
    ...(sleepFn ? { sleepFn } : {}),
    logger,
  });

  // Always print the final outcomes map so the operator (and the
  // workflow log) can see exactly which check blocked.
  print(
    JSON.stringify({
      prNumber,
      checkOutcomes: result.outcomes,
      requiredChecks: result.requiredChecks,
      polls: result.polls,
      updatesApplied: result.updatesApplied,
      resumesApplied: result.resumesApplied,
      terminal: result.terminal,
      green: result.green,
      stillRunning: result.stillRunning,
      ...(result.error ? { error: result.error } : {}),
    }),
  );

  if (result.error) {
    logger.error?.(
      `[pr-watch] could not resolve required checks: ${result.error}`,
    );
    return 1;
  }

  if (result.green) {
    logger.info?.('[pr-watch] all required checks green.');
    return 0;
  }

  // Slow-but-not-red: the cap AND resume budget are exhausted with checks
  // still pending and none failed. Never exit 1, never `timed_out` — hand
  // off to the host's interval loop and exit 2.
  if (result.stillRunning) {
    const stillPending = Object.entries(result.outcomes)
      .filter(([, v]) => v === 'still-running')
      .map(([k]) => k)
      .join(', ');
    logger.warn?.(
      `[pr-watch] required check(s) still running after ${result.polls} polls + ${result.resumesApplied} resumes: ${stillPending}. Keep polling natively:`,
    );
    logger.warn?.('[pr-watch]   gh pr checks <pr> --watch');
    return STILL_RUNNING_EXIT_CODE;
  }

  // Genuine red check — exit 1 immediately, write the digest, and surface
  // the fix-loop handoff.
  // Exclude 'still-running' as well as the non-failing states: when the cap
  // fires with a mixed failed+pending map, promotePendingToStillRunning has
  // rewritten the pending entries, and a still-running check is slow, not
  // red — including it here would let it become the digest's "primary"
  // failing check and mispoint the diagnosis at a slow check.
  const failures = Object.entries(result.outcomes)
    .filter(
      ([, v]) =>
        v !== 'success' &&
        v !== 'neutral' &&
        v !== 'skipped' &&
        v !== 'still-running',
    )
    .map(([name, outcome]) => ({ name, outcome }));
  const red = failures.map((f) => `${f.name}=${f.outcome}`).join(', ');
  logger.error?.(`[pr-watch] required check(s) not green: ${red}`);
  let digestPaths = null;
  try {
    digestPaths = writeDigestFn({
      storyId,
      prNumber,
      failures,
      tempRoot: effectiveTempRoot,
      cwd: process.cwd(),
      prRef,
    });
  } catch (err) {
    logger.warn?.(
      `[pr-watch] failed to write CI digest (non-fatal): ${err?.message ?? err}`,
    );
  }
  if (digestPaths) {
    logger.error?.(`[pr-watch] CI failure digest → ${digestPaths.jsonPath}`);
  }
  logger.error?.(
    '[pr-watch] a required check failed. Read the digest, apply the smallest fix, and re-run the suite until green.',
  );
  return 1;
}

/** Resolve config without letting a config error abort the watch. */
function safeResolveConfig(logger) {
  try {
    return resolveConfig();
  } catch (err) {
    logger?.warn?.(
      `[pr-watch] config resolve failed; using framework watch defaults: ${err?.message ?? err}`,
    );
    return null;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      pr: { type: 'string' },
      repo: { type: 'string' },
      story: { type: 'string' },
      'max-updates': { type: 'string' },
      'poll-interval-ms': { type: 'string' },
      'max-polls': { type: 'string' },
      'max-resumes': { type: 'string' },
    },
    strict: false,
  });
  return runPrWatch({
    prNumber: Number.parseInt(values.pr ?? '', 10),
    repo: values.repo ?? null,
    storyId: values.story ?? null,
    maxUpdates: values['max-updates'],
    pollIntervalMs: values['poll-interval-ms'],
    maxPolls: values['max-polls'],
    maxResumes: values['max-resumes'],
  });
}

runAsCli(import.meta.url, main, {
  source: 'pr-watch-with-update',
  propagateExitCode: true,
});
