/**
 * ci-gap-intake.js — the mechanism behind `rules/ci-remediation.md` Option 2.
 *
 * ## What was here before: nothing
 *
 * The rule told a delivering agent to "file a `meta::framework-gap` issue
 * carrying the run link and the failure signature". That sentence was the
 * whole implementation. The agent hand-ran `gh issue create` in whatever
 * repository it happened to be standing in, which produced two failures every
 * time:
 *
 *   1. **Unactionable.** A hand-typed issue has no `## Spec`, no
 *      `acceptance[]` / `verify[]` and no `agent::*` label, so
 *      `/mandrel-deliver` cannot take it. `/mandrel-plan` Phase 0 re-surfaces
 *      it as a recurring-defect row forever and nothing ever acts on it.
 *   2. **Mis-routed.** It lands in the consumer's repo no matter who owns the
 *      fault — including when the root cause is a shared base config or the
 *      runner host, which no amount of work in the consumer repo can fix.
 *
 * ## Two phases, never one
 *
 * Delivery files an **intake issue**; planning graduates it. This module
 * never invokes `/mandrel-plan`, never blocks on it, and never authors a
 * Story body. It runs mid-delivery while the Story is heading to
 * `agent::blocked` with nobody at the keyboard, so a synchronous planning
 * call would couple the CI path to an interactive workflow. Instead the
 * intake issue is written in a shape Phase 0 can recognise (the
 * {@link CI_GAP_INTAKE_MARKER}) and `/mandrel-plan <id>` rewrites it into a
 * Story on the next planning pass.
 *
 * ## Dedup is the point, not a nicety
 *
 * Runner-host contention is a repeat offender: the same signature reds an
 * unrelated PR weekly. The Nth occurrence must land on the existing ticket —
 * an occurrence count is the evidence that turns "a flake" into "a defect
 * worth someone's afternoon". Routing goes through `findings/route-finding.js`,
 * the same fingerprint dedup `audit-to-stories` and `qa-explore` share, so
 * there is one dedup implementation in the repo rather than three.
 *
 * Pure orchestration: **no network I/O lives here.** Every GitHub side effect
 * flows through injected ports (`searchIssues`, `createIssue`, `updateIssue`),
 * so the unit tests run with no network and the CLI wires them to the
 * provider.
 */

import {
  fingerprintFinding,
  fingerprintFooter,
  routeFinding,
} from '../findings/route-finding.js';
import { OWNERSHIP_BUCKETS, routeOwnership } from '../github/framework-repo.js';
import { META_LABELS } from '../label-constants.js';

/**
 * Body marker identifying a CI-gap intake issue. `/mandrel-plan` Phase 0
 * keys graduation off it, so it is a contract: bump the version suffix only
 * alongside a reader that understands both.
 */
export const CI_GAP_INTAKE_MARKER = '<!-- ci-gap-intake: v1 -->';

/**
 * The verdicts that route to Option 2 in `rules/ci-remediation.md`. Closed by
 * construction: this is the rule's own set, not a second taxonomy invented
 * here. Each becomes a `friction::<verdict>` label, which is what
 * `prior-feedback-fetcher.js` already counts into `recurringDefectClasses[]`.
 */
export const INTAKE_VERDICTS = Object.freeze([
  'pre-existing',
  'capacity',
  'unreproducible-tier',
]);

/**
 * The Option-1 verdict. Named rather than merely absent so refusing it can
 * say *why*: a defect in the diff under review is fixed at source on the
 * branch, and filing an intake issue for it would launder a real defect into
 * someone else's backlog.
 */
export const REFUSED_VERDICT = 'defect-in-diff';

/** Ownership bucket → the `meta::*` label that marks who owns the work. */
const BUCKET_META_LABEL = Object.freeze({
  consumer: META_LABELS.CONSUMER_IMPROVEMENT,
  framework: META_LABELS.FRAMEWORK_GAP,
  platform: META_LABELS.PLATFORM_GAP,
});

/**
 * Validate a verdict against the rule's Option-2 set.
 *
 * Throws rather than defaulting: a mis-verdicted filing routes real work to
 * the wrong owner, and the caller can always fix the flag.
 *
 * @param {string} verdict
 * @returns {string} the validated verdict
 */
export function assertIntakeVerdict(verdict) {
  if (verdict === REFUSED_VERDICT) {
    throw new Error(
      `verdict "${REFUSED_VERDICT}" routes to Option 1 (fix at source on the branch), not to an intake filing — see .agents/rules/ci-remediation.md`,
    );
  }
  if (!INTAKE_VERDICTS.includes(verdict)) {
    throw new Error(
      `unknown verdict "${verdict}" — expected one of ${INTAKE_VERDICTS.join(', ')}`,
    );
  }
  return verdict;
}

/**
 * Validate an ownership bucket against the closed set.
 *
 * @param {string} bucket
 * @returns {string} the validated bucket
 */
export function assertOwnershipBucket(bucket) {
  if (!OWNERSHIP_BUCKETS.includes(bucket)) {
    throw new Error(
      `unknown ownership bucket "${bucket}" — expected one of ${OWNERSHIP_BUCKETS.join(', ')}`,
    );
  }
  return bucket;
}

/**
 * The failure signature: the first distinctive line of the captured
 * failed-job log. Mirrors `ci-rerun-guard.js`'s reading of the same digest
 * field — this is the line a human recognises a repeat occurrence by.
 *
 * @param {object} digest
 * @returns {string}
 */
export function failureSignature(digest) {
  const line = String(digest?.logTail ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? '(no failed-log output captured)';
}

/**
 * Normalise a signature line into fingerprint-stable text.
 *
 * Run-specific noise — timestamps, ports, run ids, hex object ids, absolute
 * temp paths — makes two occurrences of the SAME defect fingerprint
 * differently, which is precisely the dedup failure this module exists to
 * avoid. Stripping it is what lets the Nth occurrence find the first.
 *
 * @param {string} line
 * @returns {string}
 */
export function normaliseSignature(line) {
  return String(line ?? '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, '<ts>')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<sha>')
    .replace(/:\d{2,5}\b/g, ':<port>')
    .replace(/\b\d+(\.\d+)?(ms|s)\b/g, '<duration>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Build the canonical finding the dedup layer fingerprints.
 *
 * `area` folds in the verdict so the same signature reached under two
 * different verdicts stays two findings — the verdict is who owns the fix,
 * and merging those would merge two different pieces of work.
 *
 * @param {object} opts
 * @param {object} opts.digest — the CI failure digest.
 * @param {string} opts.verdict
 * @param {string} opts.bucket
 * @returns {object} canonical finding for `route-finding.js`
 */
export function buildIntakeFinding({ digest, verdict, bucket }) {
  return {
    title: normaliseSignature(failureSignature(digest)),
    area: `ci:${verdict}`,
    primaryFile: String(digest?.failingCheck ?? 'unknown-check'),
    severity: 'high',
    labels: [BUCKET_META_LABEL[bucket], `friction::${verdict}`],
  };
}

/**
 * Render one `## Occurrences` row.
 *
 * @param {object} occurrence
 * @returns {string}
 */
function renderOccurrenceRow({ at, runUrl, headSha, prNumber }) {
  const cells = [
    at ?? new Date().toISOString(),
    runUrl ? `[run](${runUrl})` : '_(no run link)_',
    headSha ? `\`${String(headSha).slice(0, 12)}\`` : '_(unresolved)_',
    prNumber ? `#${prNumber}` : '_(n/a)_',
  ];
  return `| ${cells.join(' | ')} |`;
}

/** Header of the occurrences table, matched verbatim when appending a row. */
const OCCURRENCES_HEADER = [
  '## Occurrences',
  '',
  '| When | Run | Head SHA | PR |',
  '| --- | --- | --- | --- |',
].join('\n');

/**
 * Render the `## Routing` block — the half of this module that exists purely
 * so a mis-route can never again be silent. It states the bucket, the
 * destination, and, when there is no destination, the exact config key that
 * would give it one.
 *
 * @param {object} routing
 * @returns {string}
 */
function renderRouting(routing) {
  const lines = ['## Routing', '', `- **Owner:** \`${routing.bucket}\``];
  if (!routing.routable) {
    lines.push(
      `- **Status:** \`unroutable\` — \`${routing.missingKey}\` is unset in \`.agentrc.json\`, so this was filed in the repository that surfaced it instead of the repository that owns it.`,
      '- **To fix the routing:** set that key and re-file, or move this issue by hand.',
    );
  } else if (routing.deferredFrom) {
    lines.push(
      `- **Status:** \`deferred to ${routing.deferredFrom}\` — the write to that repository was refused, so this was filed locally.`,
      `- **Refusal:** \`${routing.deferralReason}\``,
      '- **To fix the routing:** grant a token with write scope on the target repository and re-file, or move this issue by hand.',
    );
  } else {
    lines.push(
      `- **Status:** \`routed\` — filed in \`${routing.routedRepo.owner}/${routing.routedRepo.repo}\`.`,
    );
  }
  return lines.join('\n');
}

/**
 * Render the intake issue body.
 *
 * @param {object} opts
 * @returns {string}
 */
export function renderIntakeBody({
  digest,
  verdict,
  evidence,
  routing,
  fingerprint,
  occurrence,
}) {
  const runRef =
    digest?.runUrl ??
    (digest?.runId ? `run id ${digest.runId}` : '_(run link unresolved)_');
  return [
    CI_GAP_INTAKE_MARKER,
    '',
    '> Intake issue filed by the CI-remediation path. It is **not** an',
    "> executable Story: run `/mandrel-plan <this issue's number>` to graduate",
    '> it into one.',
    '',
    '## Signature',
    '',
    `- **Failing check:** \`${digest?.failingCheck ?? 'unknown'}\``,
    `- **Run:** ${runRef}`,
    `- **Classification:** ${digest?.classification ?? 'unknown'}`,
    '',
    '```text',
    failureSignature(digest),
    '```',
    '',
    '## Verdict',
    '',
    `- **Verdict:** \`${verdict}\` (see \`.agents/rules/ci-remediation.md\`)`,
    `- **Proof reading:** ${evidence?.trim() ? evidence.trim() : '_(none supplied — this verdict is unproven and should be re-triaged)_'}`,
    '',
    renderRouting(routing),
    '',
    OCCURRENCES_HEADER,
    renderOccurrenceRow(occurrence),
    '',
    fingerprintFooter([fingerprint]),
  ].join('\n');
}

/**
 * Append one occurrence row to an existing intake body.
 *
 * Appends to the existing table when the body carries one, and otherwise
 * grafts a fresh table onto the end — an intake issue an operator has
 * hand-edited must still accumulate occurrences rather than silently losing
 * them.
 *
 * @param {string} body — the existing issue body.
 * @param {object} occurrence
 * @returns {string}
 */
export function appendOccurrence(body, occurrence) {
  const row = renderOccurrenceRow(occurrence);
  const existing = String(body ?? '');
  if (!existing.includes('## Occurrences')) {
    return [existing.trimEnd(), '', OCCURRENCES_HEADER, row].join('\n');
  }
  const lines = existing.split('\n');
  // The table runs to the first blank line after the header; inserting there
  // (rather than appending to the body) keeps any footer below it intact.
  const headerIdx = lines.findIndex((l) => l.trim() === '## Occurrences');
  let insertAt = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const isRow = lines[i].trimStart().startsWith('|');
    if (isRow) insertAt = i + 1;
    else if (insertAt !== lines.length) break;
  }
  lines.splice(insertAt, 0, row);
  return lines.join('\n');
}

/**
 * Compose the intake issue title. Verdict-prefixed so a tracker list reads as
 * a triage queue rather than a wall of stack traces.
 *
 * @param {object} opts
 * @returns {string}
 */
export function buildIntakeTitle({ digest, verdict }) {
  const signature = failureSignature(digest).slice(0, 110);
  return `CI gap (${verdict}): \`${digest?.failingCheck ?? 'unknown check'}\` — ${signature}`;
}

/**
 * Append this occurrence to the intake issue already tracking the signature.
 *
 * The Nth occurrence is the evidence that turns "a flake" into a defect worth
 * someone's afternoon, so it lands on the existing ticket rather than minting
 * a second one.
 *
 * @param {object} opts
 * @returns {Promise<object>} the intake result envelope.
 */
async function recordRecurrence({
  matchedIssue,
  occurrence,
  routing,
  labels,
  title,
  fingerprint,
  ports,
  errors,
}) {
  const updatedBody = appendOccurrence(matchedIssue.body, occurrence);
  const res = await ports.updateIssue({
    owner: routing.routedRepo.owner,
    repo: routing.routedRepo.repo,
    number: matchedIssue.number,
    body: updatedBody,
  });
  if (res?.error) errors.push(`issue update failed: ${res.error}`);
  return {
    decision: 'update-existing',
    issue: {
      number: matchedIssue.number,
      url: res?.url ?? matchedIssue.url ?? null,
    },
    routing,
    labels,
    title,
    body: updatedBody,
    fingerprint,
    dryRun: false,
    errors,
  };
}

/**
 * Create the intake issue in the routed repository, degrading to a local
 * filing when that write is refused.
 *
 * A cross-repo write needs a token scoped to the target repo, which an
 * operator may simply not have granted. The refusal becomes a local filing
 * that names the repo the work belongs in — never a silent drop, and never a
 * pretend-success. `routing` is mutated so the caller's envelope and the
 * re-rendered body agree on where this landed.
 *
 * @param {object} opts
 * @param {Function} opts.render — re-render the body for a mutated routing.
 * @returns {Promise<{ created: object, body: string }>}
 */
async function createWithDegrade({
  routing,
  currentRepo,
  title,
  body,
  labels,
  ports,
  logger,
  render,
}) {
  const created = await ports.createIssue({
    owner: routing.routedRepo.owner,
    repo: routing.routedRepo.repo,
    title,
    body,
    labels,
  });
  if (!created?.error || !routing.crossRepo) return { created, body };

  const target = `${routing.routedRepo.owner}/${routing.routedRepo.repo}`;
  logger?.warn?.(
    `[ci-gap-intake] cross-repo write to ${target} refused (${created.error}) — filing in ${currentRepo.owner}/${currentRepo.repo} and recording the deferral.`,
  );
  routing.deferredFrom = target;
  routing.deferralReason = created.error;
  routing.routedRepo = currentRepo;
  routing.crossRepo = false;
  const localBody = render(routing);
  const retried = await ports.createIssue({
    owner: currentRepo.owner,
    repo: currentRepo.repo,
    title,
    body: localBody,
    labels,
  });
  return { created: retried, body: localBody };
}

/**
 * File (or update) the intake issue for one CI-gap verdict.
 *
 * Never throws for an I/O reason — every port failure lands in `errors[]` so
 * a filing fault cannot itself fail the delivery that is already blocking.
 * An invalid verdict or bucket DOES throw: that is operator input, caught
 * before any side effect, and silently proceeding would file the wrong thing.
 *
 * @param {object} opts
 * @param {object} opts.digest — CI failure digest (from `ci-rerun-guard.js`).
 * @param {string} opts.verdict — one of {@link INTAKE_VERDICTS}.
 * @param {string} opts.bucket — ownership bucket (`consumer|framework|platform`).
 * @param {string} [opts.evidence] — the verdict's proof reading.
 * @param {object} opts.repos — resolved ownership buckets.
 * @param {{owner: string, repo: string}} opts.currentRepo
 * @param {number|null} [opts.prNumber]
 * @param {boolean} [opts.dryRun] — compose everything, write nothing.
 * @param {object} opts.ports — `{ searchIssues, createIssue, updateIssue }`.
 * @param {object} [opts.logger]
 * @param {string} [opts.now] — ISO timestamp seam for deterministic tests.
 * @returns {Promise<object>} the intake result envelope.
 */
export async function fileCiGapIntake({
  digest,
  verdict,
  bucket,
  evidence = '',
  repos,
  currentRepo,
  prNumber = null,
  dryRun = false,
  ports = {},
  logger,
  now,
}) {
  assertIntakeVerdict(verdict);
  assertOwnershipBucket(bucket);

  const errors = [];
  const occurrence = {
    at: now ?? new Date().toISOString(),
    runUrl: digest?.runUrl ?? null,
    headSha: digest?.headSha ?? null,
    prNumber,
  };

  const routed = routeOwnership({ bucket, repos, currentRepo });
  // An unroutable bucket files where the run is standing and says so in the
  // body — the one thing it must never do is look routed.
  const routing = {
    bucket,
    routable: routed.routable,
    missingKey: routed.missingKey,
    crossRepo: routed.crossRepo,
    routedRepo: routed.routable ? routed.routedRepo : currentRepo,
    deferredFrom: null,
    deferralReason: null,
  };
  if (!routed.routable) {
    logger?.warn?.(
      `[ci-gap-intake] ${bucket} bucket is unroutable: ${routed.missingKey} is unset — filing in ${currentRepo.owner}/${currentRepo.repo} and saying so in the body.`,
    );
  }

  const finding = buildIntakeFinding({ digest, verdict, bucket });
  const labels = finding.labels;
  const title = buildIntakeTitle({ digest, verdict });

  let decision = 'new';
  let matchedIssue = null;
  let fingerprint = fingerprintFinding(finding).full;
  try {
    const routedDecision = await routeFinding(finding, {
      searchIssues: ports.searchIssues,
    });
    decision = routedDecision.decision;
    matchedIssue = routedDecision.matchedIssue;
    fingerprint = routedDecision.fingerprint;
  } catch (err) {
    // A degraded lookup must not mint a duplicate on a repeat offender, so
    // the filing stops here rather than guessing `new`.
    errors.push(`dedup lookup failed: ${err?.message ?? err}`);
    return {
      decision: 'lookup-failed',
      issue: null,
      routing,
      labels,
      title,
      body: null,
      fingerprint,
      dryRun,
      errors,
    };
  }

  const body = renderIntakeBody({
    digest,
    verdict,
    evidence,
    routing,
    fingerprint,
    occurrence,
  });

  // An open match is an occurrence of a defect already tracked; only a `new`
  // or a regression of something closed long ago earns a fresh ticket.
  const isRecurrence =
    (decision === 'update-existing' || decision === 'duplicate') &&
    matchedIssue?.number;

  if (dryRun) {
    return {
      decision,
      issue: matchedIssue ? { number: matchedIssue.number } : null,
      routing,
      labels,
      title,
      body: isRecurrence
        ? appendOccurrence(matchedIssue.body, occurrence)
        : body,
      fingerprint,
      dryRun: true,
      errors,
    };
  }

  if (isRecurrence) {
    return recordRecurrence({
      matchedIssue,
      occurrence,
      routing,
      labels,
      title,
      fingerprint,
      ports,
      errors,
    });
  }

  const { created, body: finalBody } = await createWithDegrade({
    routing,
    currentRepo,
    title,
    body,
    labels,
    ports,
    logger,
    render: (r) =>
      renderIntakeBody({
        digest,
        verdict,
        evidence,
        routing: r,
        fingerprint,
        occurrence,
      }),
  });

  if (created?.error) {
    errors.push(`issue create failed: ${created.error}`);
  }

  return {
    decision: created?.error ? 'create-failed' : 'new',
    issue: created?.error
      ? null
      : { number: created?.number ?? null, url: created?.url ?? null },
    routing,
    labels,
    title,
    body: finalBody,
    fingerprint,
    dryRun: false,
    errors,
  };
}
