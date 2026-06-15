#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-deliver-preflight.js — Story #2899 (Epic #2880, F13).
 *
 * Estimates the cost of an upcoming `/deliver` run *before* Story
 * fan-out and surfaces the result to the operator on two channels:
 *
 *   1. A JSON envelope on stdout (always) with the keys
 *      `storyCount`, `installCostSeconds`, `dependencyDepth`,
 *      `githubApiRequests`, `claudeQuotaTokens`, plus `breaches`
 *      (the non-empty subset of `delivery.preflight.max*` thresholds the
 *      estimate exceeds).
 *   2. When `--post` is set (and `--dry-run` is not), an upserted
 *      `delivery-preflight` structured comment on the Epic ticket so
 *      reviewers reading the Epic discover the same numbers without
 *      shelling out.
 *
 * The CLI is intentionally side-effect-light when `--dry-run` is set: no
 * comment write, no lifecycle emit. The slash-command workflow
 * (`/deliver` Phase 1) calls the CLI without `--dry-run` so the
 * comment is upserted; if any threshold is breached, the workflow flips
 * the Epic to `agent::blocked` and surfaces the envelope in chat for
 * operator review. The CLI itself does NOT flip labels — the workflow
 * owns the HITL transition so a re-invocation against a recovered Epic
 * does not double-flip.
 *
 * Estimate model (kept simple and deterministic so a sub-agent reviewing
 * the comment can reason about the numbers):
 *
 *   - `storyCount`           = number of child `type::story` tickets.
 *   - `dependencyDepth`      = longest dependency chain through the Story
 *                              DAG (Story #4155). The ready-set runtime has
 *                              no wave barrier, so wall-clock is bounded
 *                              below by this depth, not by a wave count: a
 *                              depth-1 Epic (all Stories independent) can run
 *                              fully parallel, while a depth-N chain forces N
 *                              sequential beats regardless of cap. Computed
 *                              as the dependency-DAG layer count.
 *   - `installCostSeconds`   = `storyCount * perStoryInstallSeconds`
 *                              (default 45s, override via
 *                              `--per-story-install-seconds`). Models a
 *                              per-worktree `npm ci`.
 *   - `githubApiRequests`    = base 30 (snapshot + plan) +
 *                              `storyCount * perStoryApiRequests`
 *                              (default 25 — story-init + per-Task label
 *                              transitions + close-validation).
 *   - `claudeQuotaTokens`    = `storyCount * perStoryClaudeTokens`
 *                              (default 200000 — covers full Story loop
 *                              hydration + 4-Task implementation).
 *
 * Operators tune the per-Story constants on the CLI when their project's
 * empirical numbers diverge; the defaults are framework guidance, not
 * physics.
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { getPreflight, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { runBuildWaveDagPhase } from './lib/orchestration/epic-runner/phases/build-wave-dag.js';
import { runSnapshotPhase } from './lib/orchestration/epic-runner/phases/snapshot.js';
import {
  computeBaseSha,
  writePreflightCache,
} from './lib/orchestration/preflight-cache.js';
import { upsertStructuredComment } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/epic-deliver-preflight.js \\
  --epic <epicId> [--dry-run] [--post] \\
  [--per-story-install-seconds <n>] \\
  [--per-story-api-requests <n>] \\
  [--per-story-claude-tokens <n>]

Estimates Story count, install cost, wave count, GitHub API request volume,
and Claude Max quota burn for an Epic *before* /deliver fan-out.

Flags:
  --dry-run                        Compute the estimate and print the JSON
                                   envelope on stdout. Does NOT upsert the
                                   delivery-preflight comment.
  --post                           Upsert the delivery-preflight structured
                                   comment on the Epic ticket. Required when
                                   --dry-run is absent and the caller wants
                                   side effects on the ticket.
  --per-story-install-seconds <n>  Override the per-Story install-cost
                                   constant (default 45).
  --per-story-api-requests <n>     Override the per-Story API-request
                                   estimate (default 25).
  --per-story-claude-tokens <n>    Override the per-Story Claude-token
                                   estimate (default 200000).
  --help                           Show this message.

Output (stdout, always): JSON envelope with the estimate plus a 'breaches'
array describing any \`delivery.preflight.max*\` thresholds the estimate
exceeds. A non-empty 'breaches' array does NOT cause the CLI to exit
non-zero — the slash-command workflow owns the agent::blocked transition.

Exit codes:
  0 — estimate computed; stdout carries the envelope.
  1 — provider, config, or wave-DAG failure (no envelope written).
`;

const DEFAULTS = Object.freeze({
  perStoryInstallSeconds: 45,
  perStoryApiRequests: 25,
  perStoryClaudeTokens: 200_000,
  // Base GH API budget: snapshot getTicket + getSubTickets + plan/manifest
  // reads/writes that happen once per /deliver run regardless of
  // Story count. Empirical observation from a 5-Story Epic shows ~30
  // requests for the non-per-Story floor.
  baseApiRequests: 30,
});

/**
 * Pure estimate calculator. Exported for unit tests so the math is
 * exercised without spinning up a provider.
 *
 * @param {{
 *   storyCount: number,
 *   dependencyDepth: number,
 *   perStoryInstallSeconds?: number,
 *   perStoryApiRequests?: number,
 *   perStoryClaudeTokens?: number,
 *   baseApiRequests?: number,
 * }} input
 * @returns {{
 *   storyCount: number,
 *   installCostSeconds: number,
 *   dependencyDepth: number,
 *   githubApiRequests: number,
 *   claudeQuotaTokens: number,
 * }}
 */
export function computeEstimate({
  storyCount,
  dependencyDepth,
  perStoryInstallSeconds = DEFAULTS.perStoryInstallSeconds,
  perStoryApiRequests = DEFAULTS.perStoryApiRequests,
  perStoryClaudeTokens = DEFAULTS.perStoryClaudeTokens,
  baseApiRequests = DEFAULTS.baseApiRequests,
}) {
  if (!Number.isInteger(storyCount) || storyCount < 0) {
    throw new TypeError(
      'computeEstimate: storyCount must be a non-negative integer',
    );
  }
  if (!Number.isInteger(dependencyDepth) || dependencyDepth < 0) {
    throw new TypeError(
      'computeEstimate: dependencyDepth must be a non-negative integer',
    );
  }
  return {
    storyCount,
    installCostSeconds: storyCount * perStoryInstallSeconds,
    dependencyDepth,
    githubApiRequests: baseApiRequests + storyCount * perStoryApiRequests,
    claudeQuotaTokens: storyCount * perStoryClaudeTokens,
  };
}

/**
 * Compare the estimate against the resolved `delivery.preflight.max*`
 * thresholds. A `null` floor is treated as "no cap" and skipped.
 *
 * @param {ReturnType<typeof computeEstimate>} estimate
 * @param {ReturnType<typeof getPreflight>} thresholds
 * @returns {Array<{ key: string, observed: number, max: number }>}
 */
export function detectBreaches(estimate, thresholds) {
  const mapping = [
    { key: 'storyCount', observedKey: 'storyCount', maxKey: 'maxStories' },
    // Story #4155 — `dependencyDepth` replaces the retired `waveCount`
    // estimate; it is still gated by the `maxWaves` config threshold (the
    // published config key is left unchanged for contract stability).
    {
      key: 'dependencyDepth',
      observedKey: 'dependencyDepth',
      maxKey: 'maxWaves',
    },
    {
      key: 'installCostSeconds',
      observedKey: 'installCostSeconds',
      maxKey: 'maxInstallCostSeconds',
    },
    {
      key: 'githubApiRequests',
      observedKey: 'githubApiRequests',
      maxKey: 'maxGithubApiRequests',
    },
    {
      key: 'claudeQuotaTokens',
      observedKey: 'claudeQuotaTokens',
      maxKey: 'maxClaudeQuotaTokens',
    },
  ];
  const breaches = [];
  for (const m of mapping) {
    const max = thresholds[m.maxKey];
    if (max === null || max === undefined) continue;
    const observed = estimate[m.observedKey];
    if (observed > max) {
      breaches.push({ key: m.key, observed, max });
    }
  }
  return breaches;
}

/**
 * Render the markdown body of the `delivery-preflight` structured
 * comment. Pure helper — exported for tests.
 */
export function renderPreflightBody({
  epicId,
  estimate,
  breaches,
  thresholds,
}) {
  const lines = [];
  lines.push(`### 🛫 Delivery preflight — Epic #${epicId}`);
  lines.push('');
  lines.push('| Metric | Estimate | Threshold |');
  lines.push('| --- | ---: | ---: |');
  const rows = [
    ['storyCount', estimate.storyCount, thresholds.maxStories],
    ['dependencyDepth', estimate.dependencyDepth, thresholds.maxWaves],
    [
      'installCostSeconds',
      estimate.installCostSeconds,
      thresholds.maxInstallCostSeconds,
    ],
    [
      'githubApiRequests',
      estimate.githubApiRequests,
      thresholds.maxGithubApiRequests,
    ],
    [
      'claudeQuotaTokens',
      estimate.claudeQuotaTokens,
      thresholds.maxClaudeQuotaTokens,
    ],
  ];
  for (const [k, v, t] of rows) {
    lines.push(`| ${k} | ${v} | ${t == null ? '—' : t} |`);
  }
  lines.push('');
  if (breaches.length === 0) {
    lines.push(
      '✅ All metrics within configured `delivery.preflight.*` thresholds.',
    );
  } else {
    lines.push(
      '⛔ **Threshold breaches** — `/deliver` will flip the Epic to `agent::blocked` for operator review:',
    );
    for (const b of breaches) {
      lines.push(`- \`${b.key}\` = ${b.observed} (max ${b.max})`);
    }
  }
  return lines.join('\n');
}

/**
 * End-to-end preflight. DI-friendly so tests can swap the provider and
 * config without shelling out.
 *
 * @param {{
 *   epicId: number,
 *   dryRun?: boolean,
 *   post?: boolean,
 *   cwd?: string,
 *   perStoryInstallSeconds?: number,
 *   perStoryApiRequests?: number,
 *   perStoryClaudeTokens?: number,
 *   injectedProvider?: object,
 *   injectedConfig?: object,
 * }} args
 */
export async function runPreflight({
  epicId,
  dryRun = false,
  post = false,
  cwd,
  perStoryInstallSeconds,
  perStoryApiRequests,
  perStoryClaudeTokens,
  injectedProvider,
  injectedConfig,
}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError('runPreflight: --epic must be a positive integer');
  }

  const config = injectedConfig ?? resolveConfig({ cwd });
  const provider = injectedProvider ?? createProvider(config);
  const thresholds = getPreflight(config);

  // Compose the same two phases /deliver Phase 1 runs so the
  // preflight numbers match the actual dispatch plan.
  const ctx = { epicId, provider };
  let state = {};
  state = await runSnapshotPhase(ctx, {}, state);
  state = await runBuildWaveDagPhase(ctx, {}, state);

  const storyCount = Array.isArray(state.stories) ? state.stories.length : 0;
  // Dependency depth = the dependency-DAG layer count (the longest chain of
  // `blocked by` edges). `runBuildWaveDagPhase` already computes this layering
  // as `state.waves`, so its length is the depth even though the ready-set
  // runtime no longer dispatches by wave (Story #4155).
  const dependencyDepth = Array.isArray(state.waves) ? state.waves.length : 0;

  // Persist the snapshot/DAG envelope so `epic-deliver-prepare.js` can
  // reuse it instead of re-walking the hierarchy. The cache key is a
  // deterministic fingerprint of the Epic ticket returned by the same
  // `getTicket(epicId)` call that drove `runSnapshotPhase` **plus** the
  // Story snapshots that drove the wave DAG (Story #4019), so any drift —
  // Epic label/body/updatedAt or a Story-dependency edit — forces a cache
  // miss in prepare.
  const baseSha = computeBaseSha(state.epic, state.stories);
  let cacheWritten = false;
  if (!dryRun) {
    await writePreflightCache({
      epicId,
      baseSha,
      epic: state.epic,
      stories: state.stories,
      waves: state.waves,
      cwd,
    });
    cacheWritten = true;
  }

  const estimate = computeEstimate({
    storyCount,
    dependencyDepth,
    perStoryInstallSeconds,
    perStoryApiRequests,
    perStoryClaudeTokens,
  });
  const breaches = detectBreaches(estimate, thresholds);

  const envelope = {
    epicId,
    ...estimate,
    breaches,
    thresholds,
    baseSha,
    cacheWritten,
  };

  if (post && !dryRun) {
    const body = renderPreflightBody({
      epicId,
      estimate,
      breaches,
      thresholds,
    });
    await upsertStructuredComment(provider, epicId, 'delivery-preflight', body);
    envelope.commentUpserted = true;
  } else {
    envelope.commentUpserted = false;
  }
  return envelope;
}

export function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      'dry-run': { type: 'boolean' },
      post: { type: 'boolean' },
      'per-story-install-seconds': { type: 'string' },
      'per-story-api-requests': { type: 'string' },
      'per-story-claude-tokens': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });
  return values;
}

function parseIntOrDefault(raw) {
  if (raw == null) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(
      `expected non-negative integer, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseArgv(argv);
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const epicId = Number.parseInt(values.epic ?? '', 10);
  if (!Number.isInteger(epicId) || epicId <= 0) {
    process.stderr.write(
      '[epic-deliver-preflight] ERROR: --epic <epicId> is required.\n',
    );
    process.stderr.write(HELP);
    process.exit(2);
  }
  const envelope = await runPreflight({
    epicId,
    dryRun: values['dry-run'] === true,
    post: values.post === true,
    perStoryInstallSeconds: parseIntOrDefault(
      values['per-story-install-seconds'],
    ),
    perStoryApiRequests: parseIntOrDefault(values['per-story-api-requests']),
    perStoryClaudeTokens: parseIntOrDefault(values['per-story-claude-tokens']),
  });
  Logger.info(JSON.stringify(envelope, null, 2));
}

// Re-export for tests that want to inspect the framework defaults.
export const PREFLIGHT_DEFAULTS = DEFAULTS;

runAsCli(import.meta.url, main, { source: 'epic-deliver-preflight' });
