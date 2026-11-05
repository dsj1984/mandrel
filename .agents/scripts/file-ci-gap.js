#!/usr/bin/env node
/**
 * CI-remediation Option-2 filing: for a red check that is real but not this
 * delivery's to fix, files (or updates, by fingerprint) an intake issue in
 * the owning repo, comments `friction` on the Story, and optionally blocks it.
 * It files intake, never a Story, so delivery never blocks on planning.
 * `governance-label` is the one non-filing verdict: an audited recovery for
 * a fresh green run an operator-approved label started on the red head.
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
import { runGh } from './lib/gh-exec.js';
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
  GOVERNANCE_LABEL_VERDICT,
  readCiDigest,
  recordRerunAllowance,
  resolvePassingCheckRun,
} from './lib/orchestration/ci-rerun-guard.js';
import {
  STATE_LABELS,
  transitionTicketState,
  upsertStructuredComment,
} from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';

const USAGE = {
  invocation:
    'node .agents/scripts/file-ci-gap.js --story <id> --verdict <verdict> --owner <bucket> [--evidence "<proof reading>"] [--pr <n>] [--block] [--dry-run]\n  node .agents/scripts/file-ci-gap.js --story <id> --verdict governance-label --label <name> [--pr <n>] [--dry-run]',
  summary:
    'File (or update) the CI-gap intake issue for an Option-2 verdict in .agents/rules/ci-remediation.md, routed to the repository that owns the fault and deduped by failure signature.',
  flags: [
    [
      '--story <id>',
      'Story the red check blocked (required — keys the CI digest).',
    ],
    [
      '--verdict <verdict>',
      `One of ${INTAKE_VERDICTS.join(' | ')} | ${GOVERNANCE_LABEL_VERDICT}. "${REFUSED_VERDICT}" is refused: it routes to Option 1, fix at source. capacity / unreproducible-tier also record the one-rerun allowance on the CI digest. ${GOVERNANCE_LABEL_VERDICT} files nothing: it proves --label was added after the red and records the allowance for that fresh run.`,
    ],
    [
      '--label <name>',
      `The operator-approved governance label (${GOVERNANCE_LABEL_VERDICT} only).`,
    ],
    [
      '--owner <bucket>',
      'Who owns the fault: consumer | framework | platform. Resolves through github.followUpRepos.*.',
    ],
    [
      '--evidence <text>',
      "The verdict's proof reading (the exhausted-limit log line, the failed attach). Recorded in the body.",
    ],
    [
      '--pr <n>',
      'PR number the red check ran on; recorded as an occurrence. Defaults to the digest PR.',
    ],
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
 * `gh` rather than the provider facade: a filing may target another repo.
 * @param {object} opts
 * @returns {object}
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
      // `gh issue create` fails outright on an absent label; ensure first.
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

const GRADUATE_LINE =
  'Graduate the intake issue with `/mandrel-plan <issue number>` to turn it into a Story.';

/**
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

/** The injected digest, else the Story's on-disk one; throws when absent. */
function loadCiDigest({ sid, digest, digestRoot, cwd }) {
  const ciDigest =
    digest ?? readCiDigest({ storyId: sid, tempRoot: digestRoot, cwd });
  if (!ciDigest) {
    throw new Error(
      `no CI digest for Story #${sid}. The digest is written by \`pr-watch-with-update.js --story ${sid}\` on the first red; without it there is no run link or failure signature to file.`,
    );
  }
  return ciDigest;
}

/**
 * @param {object} opts
 * @returns {Promise<object>}
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
  label = null,
  labelHistoryFn = readPrLabelHistory,
  greenRunFn = resolvePassingCheckRun,
} = {}) {
  const sid = Number(storyId);
  if (!Number.isInteger(sid) || sid <= 0) {
    throw new Error('--story <id> is required (a positive issue number).');
  }
  const resolved = config ?? resolveConfig();
  // Must resolve exactly as `pr-watch-with-update.js` does when writing it.
  const digestRoot = tempRoot ?? resolved?.project?.paths?.tempRoot ?? 'temp';
  const ciDigest = loadCiDigest({ sid, digest, digestRoot, cwd });

  if (verdict === GOVERNANCE_LABEL_VERDICT) {
    return runGovernanceRecovery({
      sid,
      label,
      prNumber,
      digest: ciDigest,
      digestRoot,
      cwd,
      dryRun,
      provider,
      config: resolved,
      labelHistoryFn,
      greenRunFn,
    });
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

  // A proven-environmental verdict earns one same-SHA rerun; never on dry run.
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

/** Parsed JSON of a `gh api` read; `null` on a failed or unparseable one. */
function readGhApi(args, cwd) {
  const res = runGh(['api', ...args], { cwd });
  if ((res?.status ?? 1) !== 0) return null;
  try {
    return JSON.parse((res.stdout ?? '').trim() || 'null');
  } catch {
    return null;
  }
}

/**
 * The PR's current label names and every issue event; `null` when a read
 * fails (the recovery then refuses).
 *
 * @returns {{ labels: string[], events: object[] } | null}
 */
function readPrLabelHistory({ prNumber, cwd }) {
  const labels = readGhApi(
    [`repos/{owner}/{repo}/issues/${prNumber}/labels?per_page=100`],
    cwd,
  );
  const pages = readGhApi(
    [
      '--paginate',
      '--slurp',
      `repos/{owner}/{repo}/issues/${prNumber}/events?per_page=100`,
    ],
    cwd,
  );
  if (!Array.isArray(labels) || !Array.isArray(pages)) return null;
  return {
    labels: labels.map((l) => l?.name).filter(Boolean),
    events: pages.flat(),
  };
}

/**
 * The newest `labeled` event for `label` after `since`, while the label is
 * still on the PR; `null` when the transition is unproven.
 *
 * @returns {{ label: string, actor: string|null, labeledAt: string } | null}
 */
export function proveLabelTransition({ history, label, since }) {
  const sinceMs = Date.parse(since ?? '');
  if (!history || !Number.isFinite(sinceMs)) return null;
  if (!history.labels.includes(label)) return null;
  const hits = history.events.filter(
    (e) =>
      e?.event === 'labeled' &&
      e?.label?.name === label &&
      Date.parse(e?.created_at ?? '') > sinceMs,
  );
  const latest = hits.sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  )[0];
  return latest
    ? {
        label,
        actor: latest.actor?.login ?? null,
        labeledAt: latest.created_at,
      }
    : null;
}

/**
 * @param {{ digest: object, evidence: object }} opts
 * @returns {string}
 */
export function renderGovernanceComment({ digest, evidence }) {
  const red = digest?.runUrl ?? `run id ${digest?.runId ?? 'unresolved'}`;
  const green =
    evidence.greenRun?.url ??
    `run id ${evidence.greenRun?.runId ?? 'unresolved'}`;
  return [
    `### CI recovery recorded — verdict \`${GOVERNANCE_LABEL_VERDICT}\``,
    '',
    `- **Failing check:** \`${digest?.failingCheck ?? 'unknown'}\``,
    `- **Red run:** ${red}`,
    `- **Green run:** ${green}`,
    `- **Label:** \`${evidence.label}\` added by ${evidence.actor ? `@${evidence.actor}` : 'an unknown actor'} at ${evidence.labeledAt} (PR #${evidence.prNumber})`,
    `- **Head SHA:** \`${digest?.headSha ?? 'unresolved'}\``,
    '',
    'An operator-approved governance label started a fresh run on the red head,',
    'so **one** green on that head is admitted. No intake issue was filed: this',
    'is a recovery, not a CI gap. A second red after it is real and routes to',
    'Option 1.',
  ].join('\n');
}

/**
 * `governance-label`: prove the label transition, record the allowance and
 * post the audit comment. Throws (non-zero exit, nothing written) when the
 * transition is unproven.
 *
 * @returns {Promise<object>}
 */
async function runGovernanceRecovery({
  sid,
  label,
  prNumber: prFlag,
  digest,
  digestRoot,
  cwd,
  dryRun,
  provider,
  config,
  labelHistoryFn,
  greenRunFn,
}) {
  const prNumber = prFlag ?? digest.prNumber ?? null;
  if (!label) {
    throw new Error(
      `--verdict ${GOVERNANCE_LABEL_VERDICT} requires --label <name>: the operator-approved label that started the fresh run.`,
    );
  }
  if (!prNumber) {
    throw new Error('no PR number: pass --pr <n> (the digest records none).');
  }
  const proof = proveLabelTransition({
    history: labelHistoryFn({ prNumber, cwd }),
    label,
    since: digest.generatedAt,
  });
  if (!proof) {
    throw new Error(
      `refused: PR #${prNumber} shows no \`labeled\` event for "${label}" after the red (${digest.generatedAt ?? 'unrecorded'}), or the label is no longer on it — nothing recorded.`,
    );
  }
  const greenRun = greenRunFn({
    prRef: String(prNumber),
    checkName: digest.failingCheck,
    cwd,
  });
  const evidence = { ...proof, prNumber, greenRun };
  const body = renderGovernanceComment({ digest, evidence });
  const result = {
    storyId: sid,
    verdict: GOVERNANCE_LABEL_VERDICT,
    decision: dryRun ? 'dry-run' : 'recovered',
    issue: null,
    errors: [],
    actions: { commented: false, blocked: false },
    rerunAllowance: null,
    evidence,
    comment: body,
  };
  if (dryRun) return result;
  result.rerunAllowance = recordRerunAllowance({
    storyId: sid,
    verdict: GOVERNANCE_LABEL_VERDICT,
    tempRoot: digestRoot,
    cwd,
    evidence,
  });
  if (!result.rerunAllowance) {
    throw new Error(
      `could not record the allowance on the CI digest for Story #${sid}.`,
    );
  }
  const ticketing = provider ?? createProvider(config);
  if (ticketing) {
    try {
      await upsertStructuredComment(ticketing, sid, 'friction', body);
      result.actions.commented = true;
    } catch (err) {
      result.errors.push(`friction comment failed: ${err?.message ?? err}`);
    }
  }
  return result;
}

/**
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
      label: { type: 'string' },
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
    label: values.label ?? null,
  });

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
