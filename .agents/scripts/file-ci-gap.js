#!/usr/bin/env node
/**
 * file-ci-gap.js — the CI-remediation Option-2 filing command.
 *
 * `rules/ci-remediation.md` sends three verdicts here — `pre-existing`,
 * `capacity`, `unreproducible-tier` — each meaning "this red check is real,
 * and fixing it is not this delivery's job". The rule used to say "file a
 * `meta::framework-gap` issue" and stop, leaving the agent to hand-run
 * `gh issue create` wherever it was standing. This is the mechanism behind
 * that sentence: evidence from the CI digest, ownership routing, fingerprint
 * dedup, the `friction` comment, and the `agent::blocked` flip in one call.
 *
 * It files an **intake** issue, never a Story: `/mandrel-plan <id>` graduates
 * it on the next planning pass. Delivery never blocks on planning — see
 * `lib/orchestration/ci-gap-intake.js` for why that split is load-bearing.
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import {
  createFollowUpIssue,
  ensureIssueLabels,
  updateFollowUpIssue,
} from './lib/feedback-loop/graduator-core.js';
import { issueNumberFromUrl } from './lib/feedback-loop/retro-proposals-graduator.js';
import {
  resolveOwnershipRepos,
  routeOwnership,
} from './lib/github/framework-repo.js';
import { Logger } from './lib/Logger.js';
import {
  fileCiGapIntake,
  INTAKE_VERDICTS,
  REFUSED_VERDICT,
} from './lib/orchestration/ci-gap-intake.js';
import {
  RERUN_ALLOWANCE_VERDICTS,
  readCiDigest,
  recordRerunAllowance,
} from './lib/orchestration/ci-rerun-guard.js';
import {
  STATE_LABELS,
  transitionTicketState,
  upsertStructuredComment,
} from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';

const USAGE = {
  invocation:
    'node .agents/scripts/file-ci-gap.js --story <id> --verdict <verdict> --owner <bucket> [--evidence "<proof reading>"] [--pr <n>] [--block] [--dry-run]',
  summary:
    'File (or update) the CI-gap intake issue for an Option-2 verdict in .agents/rules/ci-remediation.md, routed to the repository that owns the fault and deduped by failure signature.',
  flags: [
    [
      '--story <id>',
      'Story the red check blocked (required — keys the CI digest).',
    ],
    [
      '--verdict <verdict>',
      `One of ${INTAKE_VERDICTS.join(' | ')}. "${REFUSED_VERDICT}" is refused: it routes to Option 1, fix at source. ${RERUN_ALLOWANCE_VERDICTS.join(' / ')} also record the one-rerun allowance on the CI digest.`,
    ],
    [
      '--owner <bucket>',
      'Who owns the fault: consumer | framework | platform. Resolves through github.followUpRepos.*.',
    ],
    [
      '--evidence <text>',
      "The verdict's proof reading (the exhausted-limit log line, the failed attach). Recorded in the body.",
    ],
    ['--pr <n>', 'PR number the red check ran on; recorded as an occurrence.'],
    [
      '--block',
      'Also flip the Story to agent::blocked. Without it the friction comment is posted but the Story is left where it is.',
    ],
    ['--dry-run', 'Compose the filing and print it; write nothing.'],
  ],
  notes: [
    'Requires a CI digest at temp/story-<id>-ci-digest.json — pr-watch-with-update.js --story <id> writes it on the first red.',
    'A repeat occurrence of a known signature UPDATES the existing intake issue rather than opening a second one.',
    'The issue it files is intake, not an executable Story: graduate it with /mandrel-plan <issue number>.',
  ],
};

/**
 * Wire the live GitHub ports the intake filer writes through.
 *
 * `gh` is the transport rather than the provider facade because a filing can
 * target a repository other than the configured one, and `gh issue create
 * --repo` is the surface that already does that (the graduators file
 * cross-repo the same way).
 *
 * @param {object} opts
 * @returns {object} ports for `fileCiGapIntake`
 */
function liveIntakePorts({ provider, searchRepo, cwd, logger }) {
  const labelCache = new Map();
  return {
    searchIssues: (query) =>
      provider.searchIssues({
        query,
        owner: searchRepo.owner,
        repo: searchRepo.repo,
      }),
    createIssue: async ({ owner, repo, title, body, labels }) => {
      // `gh issue create --label <absent>` fails outright, so a brand-new
      // routing label (meta::platform-gap, friction::unreproducible-tier)
      // has to exist before the create — not after it errors.
      const ensured = await ensureIssueLabels({
        owner,
        repo,
        labels,
        labelCache,
        cwd,
      });
      for (const err of ensured.errors) logger?.warn?.(`[file-ci-gap] ${err}`);
      const created = await createFollowUpIssue({
        owner,
        repo,
        title,
        body,
        labels,
        ghPath: 'gh',
        cwd,
      });
      return {
        url: created.url,
        number: created.url ? issueNumberFromUrl(created.url) : null,
        error: created.error,
      };
    },
    updateIssue: ({ owner, repo, number, body }) =>
      updateFollowUpIssue({ owner, repo, number, body, ghPath: 'gh', cwd }),
  };
}

/**
 * Render the `friction` comment the Story carries so the blocker is legible
 * on the ticket itself, not only in the intake issue.
 *
 * @param {object} opts
 * @returns {string}
 */
export function renderFrictionComment({
  verdict,
  result,
  digest,
  rerunAllowance = null,
}) {
  const target = result.issue?.url ?? result.issue?.number ?? '(not filed)';
  const lines = [
    `### CI gap filed — verdict \`${verdict}\``,
    '',
    `- **Failing check:** \`${digest?.failingCheck ?? 'unknown'}\``,
    `- **Run:** ${digest?.runUrl ?? `run id ${digest?.runId ?? 'unresolved'}`}`,
    `- **Intake issue:** ${target} (${result.decision})`,
    `- **Owner:** \`${result.routing.bucket}\` → \`${result.routing.routedRepo.owner}/${result.routing.routedRepo.repo}\``,
  ];
  if (!result.routing.routable) {
    lines.push(
      `- **Routing:** \`unroutable\` — \`${result.routing.missingKey}\` is unset, so the intake issue was filed locally.`,
    );
  }
  if (result.routing.deferredFrom) {
    lines.push(
      `- **Routing:** deferred from \`${result.routing.deferredFrom}\` (${result.routing.deferralReason}) — filed locally instead.`,
    );
  }
  lines.push('', renderRerunLine(rerunAllowance), GRADUATE_LINE);
  return lines.join('\n');
}

/** The graduation instruction every filing carries, verdict-independent. */
const GRADUATE_LINE =
  'Graduate the intake issue with `/mandrel-plan <issue number>` to turn it into a Story.';

/**
 * What this filing says about rerunning the failed job (Story #5343). An
 * allowance is stated with its head SHA and its one-shot bound, because the
 * comment is where an operator reads whether the rerun they are about to do
 * is the sanctioned one.
 *
 * @param {{ headSha: string } | null} rerunAllowance
 * @returns {string}
 */
function renderRerunLine(rerunAllowance) {
  return rerunAllowance
    ? 'This verdict is environmental and proven, so **one** rerun of the failed ' +
        `job is now admitted on head \`${rerunAllowance.headSha}\` — and one only. ` +
        'A second red after it is real and routes to Option 1.'
    : 'This verdict does **not** license a re-run of the failed job.';
}

/**
 * File the CI-gap intake issue for one Story, post the `friction` comment,
 * and optionally flip the Story to `agent::blocked`.
 *
 * Every port is injectable so the unit tests exercise the whole command with
 * no network and no live tracker.
 *
 * @param {object} opts
 * @returns {Promise<object>} the intake result, plus what the command did.
 */
export async function runFileCiGap({
  storyId,
  verdict,
  owner: bucket,
  evidence = '',
  prNumber = null,
  dryRun = false,
  block = false,
  config,
  provider,
  ports,
  digest,
  tempRoot,
  cwd = process.cwd(),
  logger = Logger,
  now,
} = {}) {
  const sid = Number(storyId);
  if (!Number.isInteger(sid) || sid <= 0) {
    throw new Error('--story <id> is required (a positive issue number).');
  }
  const resolved = config ?? resolveConfig();
  // The digest's temp root, resolved exactly as `pr-watch-with-update.js`
  // resolves it when it WRITES the digest — the CLI never passed one, so the
  // default read crashed on `undefined` before it could find the file.
  const digestRoot = tempRoot ?? resolved?.project?.paths?.tempRoot ?? 'temp';
  const ciDigest =
    digest ?? readCiDigest({ storyId: sid, tempRoot: digestRoot, cwd });
  if (!ciDigest) {
    throw new Error(
      `no CI digest for Story #${sid}. The digest is written by \`pr-watch-with-update.js --story ${sid}\` on the first red; without it there is no run link or failure signature to file.`,
    );
  }

  const repos = resolveOwnershipRepos(resolved);
  const currentRepo = repos.consumer ?? { owner: 'unknown', repo: 'unknown' };
  // Dedup searches the repository the filing will land in — routing is a pure
  // function, so computing it here and inside the filer cannot disagree.
  const routed = routeOwnership({ bucket, repos, currentRepo });
  const searchRepo = routed.routable ? routed.routedRepo : currentRepo;

  const ticketing =
    provider ?? (dryRun ? null : (createProvider(resolved) ?? null));
  const livePorts =
    ports ??
    liveIntakePorts({
      provider: ticketing ?? createProvider(resolved),
      searchRepo,
      cwd,
      logger,
    });

  const result = await fileCiGapIntake({
    digest: ciDigest,
    verdict,
    bucket,
    evidence,
    repos,
    currentRepo,
    prNumber,
    dryRun,
    ports: livePorts,
    logger,
    now,
  });

  // Story #5343 — a proven-environmental verdict earns the one same-SHA
  // rerun the watcher's guard will admit. Recorded on the digest, keyed to
  // the head SHA the red was observed on, and never on a dry run.
  const rerunAllowance = dryRun
    ? null
    : recordRerunAllowance({
        storyId: sid,
        verdict,
        tempRoot: digestRoot,
        cwd,
      });

  const actions = { commented: false, blocked: false };
  if (!dryRun && ticketing) {
    const body = renderFrictionComment({
      verdict,
      result,
      digest: ciDigest,
      rerunAllowance,
    });
    try {
      await upsertStructuredComment(ticketing, sid, 'friction', body);
      actions.commented = true;
    } catch (err) {
      result.errors.push(`friction comment failed: ${err?.message ?? err}`);
    }
    if (block) {
      try {
        await transitionTicketState(ticketing, sid, STATE_LABELS.BLOCKED, {});
        actions.blocked = true;
      } catch (err) {
        result.errors.push(
          `agent::blocked transition failed: ${err?.message ?? err}`,
        );
      }
    }
  }

  return { storyId: sid, verdict, ...result, actions, rerunAllowance };
}

/**
 * CLI entrypoint.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      story: { type: 'string' },
      verdict: { type: 'string' },
      owner: { type: 'string' },
      evidence: { type: 'string' },
      pr: { type: 'string' },
      block: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  const result = await runFileCiGap({
    storyId: values.story,
    verdict: values.verdict,
    owner: values.owner,
    evidence: values.evidence ?? '',
    prNumber: values.pr ? Number(values.pr) : null,
    dryRun: values['dry-run'],
    block: values.block,
  });

  // Single-line JSON per the script-output contract — an orchestrator parses
  // this, and a pretty dump is noise in a delivery transcript.
  process.stdout.write(`${JSON.stringify(result)}\n`);
  for (const err of result.errors) {
    Logger.error(`[file-ci-gap] ${err}`);
  }
  if (result.errors.length > 0) process.exitCode = 1;
}

runAsCli(import.meta.url, main, {
  source: 'file-ci-gap',
  errorPrefix: '[file-ci-gap]',
  usage: USAGE,
});
