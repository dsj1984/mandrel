// .agents/scripts/lib/orchestration/ci-rerun-guard.js
/**
 * ci-rerun-guard.js — the machine enforcement behind the no-rerun MUST in
 * [`rules/ci-remediation.md`](../../../rules/ci-remediation.md) § Verifier
 * (Story #4865). Owns the CI failure digest (write / read / retire), the
 * head-SHA discriminator, the auto-merge disarm, and the blocked-delivery
 * escalation. `pr-watch-with-update.js` is the enforcement point; this
 * module is the mechanism it drives.
 *
 * **Why the first red, and not the rerun-green.** The obvious design —
 * observe a green that arrives on a re-run of the same commit, then disarm
 * auto-merge and block — cannot enforce anything. GitHub's native
 * auto-merge fires server-side the moment branch protection is satisfied,
 * so it races the watcher's next poll: by the time the rerun-green is
 * observed, the PR may already be merged. The only race-free observation
 * point is the **first red**, which necessarily precedes any green. So the
 * watcher disarms on red and records the PR head SHA; the head SHA is then
 * read at **re-arm** time, not at merge time.
 *
 * **Head SHA is the discriminator.** A green on a *different* head SHA is a
 * fix at source — legal, and it retires the digest. A green on the *same*
 * head SHA is a re-run of a failed job, which the rule forbids: the
 * delivery hard-stops at `agent::blocked` and a CI-gap intake filing
 * (`file-ci-gap.js`, carrying the run link and failure signature the digest
 * already holds) is required before it can proceed.
 *
 * **Fail closed on an unverifiable green.** A digest whose head SHA is
 * missing, or a current head SHA that `gh` could not resolve, leaves no
 * evidence that the red was fixed at source. An unresolved red plus no
 * evidence of a new commit is treated as a violation rather than waved
 * through — the same unknown-is-blocking posture the arming probe takes on
 * an unrecognized check state.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnChild } from '../child-exec.js';
import { resolveConfig } from '../config-resolver.js';
import { Logger } from '../Logger.js';
import { createProvider } from '../provider-factory.js';
import {
  STATE_LABELS,
  transitionTicketState,
  upsertStructuredComment,
} from './ticketing.js';

/** How many superseded unresolved reds a digest carries before the oldest is dropped. */
const MAX_PRIOR_REDS = 10;

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
 * Resolve the `.json` / `.md` digest paths for a scope. Returns `null` when
 * no scope can be keyed (the digest is scoped by filename and has nothing
 * to key on).
 *
 * Module-private: `writeCiDigest` / `readCiDigest` / `retireCiDigest` are the
 * only callers and are the surface worth pinning, so the keying is asserted
 * through them rather than through an export nothing in production reaches.
 *
 * @param {{ storyId?: number|string|null, tempRoot: string, cwd: string }} opts
 * @returns {{ scope: { kind: 'story', id: number }, jsonPath: string, mdPath: string } | null}
 */
function ciDigestPaths({ storyId = null, tempRoot, cwd }) {
  const scope = resolveDigestScope({ storyId });
  if (!scope) return null;
  const dir = path.isAbsolute(tempRoot) ? tempRoot : path.join(cwd, tempRoot);
  const base = `${scope.kind}-${scope.id}-ci-digest`;
  return {
    scope,
    jsonPath: path.join(dir, `${base}.json`),
    mdPath: path.join(dir, `${base}.md`),
  };
}

/**
 * Default `gh run view --log-failed` spawn — pulls the tail of the failed
 * job log so the digest carries an actionable excerpt. Best-effort:
 * returns an empty tail when the run id is unknown or `gh` errors.
 * Injected into `writeCiDigest` so tests never shell out.
 */
function ghRunLogTail({ runId, cwd, spawnFn, maxLines = 40 }) {
  if (!runId) return '';
  const result = spawnChild(
    'gh',
    ['run', 'view', String(runId), '--log-failed'],
    { run: spawnFn, cwd },
  );
  const out = (result.stdout ?? '').trim();
  if (out.length === 0) return '';
  const lines = out.split('\n');
  return lines.slice(-maxLines).join('\n');
}

/**
 * Resolve the failing check's run identity — the GitHub Actions run id AND
 * the run URL. Best-effort via `gh pr checks --json name,link`: the `link`
 * field carries the run URL whose trailing path segment is the run id. The
 * URL matters as much as the id, because the intake issue a
 * rerun violation demands must carry a run **link**.
 *
 * @returns {{ runId: string|null, url: string|null }}
 */
function resolveFailingCheckRun({ prRef, checkName, cwd, spawnFn }) {
  const result = spawnChild(
    'gh',
    ['pr', 'checks', prRef, '--json', 'name,link'],
    { run: spawnFn, cwd },
  );
  try {
    const parsed = JSON.parse((result.stdout ?? '').trim() || '[]');
    const entry = Array.isArray(parsed)
      ? parsed.find((e) => e?.name === checkName)
      : null;
    const link = entry?.link ? String(entry.link) : null;
    const m = link ? /\/runs\/(\d+)/.exec(link) : null;
    return { runId: m ? m[1] : null, url: link };
  } catch {
    return { runId: null, url: null };
  }
}

/**
 * Resolve the PR's current head SHA (`headRefOid`) — the discriminator
 * between a legal fix-at-source green and a forbidden rerun green. Returns
 * `null` when `gh` fails or the payload is unparseable; callers treat an
 * unresolvable head as unverifiable, never as "changed".
 *
 * @param {{ prRef: string, cwd: string, spawnFn?: Function }} opts
 * @returns {string|null}
 */
export function resolvePrHeadSha({ prRef, cwd, spawnFn }) {
  const result = spawnChild(
    'gh',
    ['pr', 'view', prRef, '--json', 'headRefOid'],
    {
      run: spawnFn,
      cwd,
    },
  );
  if ((result?.status ?? 1) !== 0) return null;
  try {
    const parsed = JSON.parse((result.stdout ?? '').trim() || '{}');
    const sha = parsed?.headRefOid;
    return typeof sha === 'string' && sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * A `gh` refusal that means auto-merge was never armed in the first place —
 * there is nothing to disarm, so the PR is already in the un-armed posture
 * the guard wants. Distinguishing this from a genuine disarm failure is
 * load-bearing: an armed PR that could not be disarmed is a blocker, while
 * a never-armed PR is the desired end state.
 */
const NOT_ARMED = /not enabled|isn't enabled|is not set|no auto-?merge/i;

/**
 * Disarm GitHub native auto-merge for the PR — the race-free response to the
 * first red. Never throws.
 *
 * @param {{ prRef: string, cwd: string, spawnFn?: Function }} opts
 * @returns {{ disarmed: boolean, alreadyUnarmed: boolean, detail: string }}
 *   `disarmed` is true when the PR is (now) un-armed; `alreadyUnarmed`
 *   distinguishes "there was nothing armed" from an executed disarm.
 */
export function disarmAutoMerge({ prRef, cwd, spawnFn }) {
  let result;
  try {
    result = spawnChild('gh', ['pr', 'merge', prRef, '--disable-auto'], {
      run: spawnFn,
      cwd,
    });
  } catch (err) {
    return {
      disarmed: false,
      alreadyUnarmed: false,
      detail: `gh-spawn-error: ${err?.message ?? err}`,
    };
  }
  const status = result?.status ?? 1;
  const stderr = String(result?.stderr ?? '').trim();
  if (status === 0) {
    return { disarmed: true, alreadyUnarmed: false, detail: 'disarmed' };
  }
  if (NOT_ARMED.test(stderr)) {
    return {
      disarmed: true,
      alreadyUnarmed: true,
      detail: `auto-merge was not armed: ${stderr.slice(0, 160)}`,
    };
  }
  return {
    disarmed: false,
    alreadyUnarmed: false,
    detail: `gh-exit-${status}: ${stderr.slice(0, 200)}`,
  };
}

/**
 * Read the CI failure digest for a scope, or `null` when none exists (or it
 * is unreadable / malformed — an unparseable digest carries no enforceable
 * evidence, so it is treated as absent).
 *
 * @param {{ storyId?: number|string|null, tempRoot: string, cwd: string }} opts
 * @returns {object|null}
 */
export function readCiDigest({ storyId = null, tempRoot, cwd }) {
  const paths = ciDigestPaths({ storyId, tempRoot, cwd });
  if (!paths || !existsSync(paths.jsonPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(paths.jsonPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Retire the digest for a scope — the red it recorded was resolved at
 * source. Best-effort; returns the paths removed (or `null`).
 *
 * @param {{ storyId?: number|string|null, tempRoot: string, cwd: string }} opts
 * @returns {{ jsonPath: string, mdPath: string } | null}
 */
export function retireCiDigest({ storyId = null, tempRoot, cwd }) {
  const paths = ciDigestPaths({ storyId, tempRoot, cwd });
  if (!paths) return null;
  rmSync(paths.jsonPath, { force: true });
  rmSync(paths.mdPath, { force: true });
  return { jsonPath: paths.jsonPath, mdPath: paths.mdPath };
}

/**
 * Condense a digest into the record kept in a successor digest's
 * `priorReds`, so a second red on a new head never silently erases the
 * evidence of an unresolved earlier one.
 */
function summarizeRed(digest) {
  return {
    headSha: digest?.headSha ?? null,
    failingCheck: digest?.failingCheck ?? null,
    runId: digest?.runId ?? null,
    runUrl: digest?.runUrl ?? null,
    generatedAt: digest?.generatedAt ?? null,
  };
}

/**
 * Carry forward the unresolved reds an incoming digest must not lose. A
 * re-red on the SAME head is the same unresolved red observed again, so it
 * is not duplicated into the history.
 */
function carryPriorReds(previous, headSha) {
  if (!previous) return [];
  const inherited = Array.isArray(previous.priorReds) ? previous.priorReds : [];
  const history =
    previous.headSha && previous.headSha === headSha
      ? inherited
      : [...inherited, summarizeRed(previous)];
  return history.slice(-MAX_PRIOR_REDS);
}

/**
 * Render the human-readable digest. Names the head SHA, because that is the
 * field the green path adjudicates on.
 */
function renderDigestMarkdown(digest, failures) {
  return [
    `# CI failure digest — Story #${digest.storyId} (PR #${digest.prNumber})`,
    '',
    `- **Failing check:** \`${digest.failingCheck}\` (${digest.failingOutcome})`,
    `- **Head SHA:** ${digest.headSha ?? 'unresolved'}`,
    `- **Run id:** ${digest.runId ?? 'unresolved'}`,
    `- **Run link:** ${digest.runUrl ?? 'unresolved'}`,
    `- **Classification:** ${digest.classification}`,
    `- **Generated:** ${digest.generatedAt}`,
    '',
    failures.length > 1
      ? `Other non-green checks: ${failures
          .slice(1)
          .map((f) => `\`${f.name}\`=${f.outcome}`)
          .join(', ')}`
      : '',
    digest.priorReds.length > 0
      ? `Unresolved earlier red(s): ${digest.priorReds
          .map((r) => `\`${r.failingCheck}\`@${r.headSha ?? 'unknown'}`)
          .join(', ')}`
      : '',
    '',
    'A green on THIS head SHA is a re-run of a failed job and is forbidden',
    '(`.agents/rules/ci-remediation.md` § Verifier). Fix at source and push a',
    'new commit — the head SHA moving is what clears this digest.',
    '',
    '## `gh run view --log-failed` tail',
    '',
    '```text',
    digest.logTail || '(no failed-log output available)',
    '```',
    '',
  ].join('\n');
}

/**
 * Write the CI failure digest (`.json` + `.md`) for a red watch. Returns
 * the two paths written, or `null` when no story id was supplied (the
 * digest is scoped by filename and has nothing to key on).
 *
 * @param {object} opts
 * @param {number|string|null} [opts.storyId] The v2 delivery scope.
 * @param {number} opts.prNumber
 * @param {string|null} [opts.headSha] PR head SHA at the moment of the red.
 * @param {Array<{name:string, outcome:string}>} opts.failures
 * @param {string} opts.tempRoot
 * @param {string} opts.cwd
 * @param {string} opts.prRef
 * @param {Function} [opts.checkRunFn]
 * @param {Function} [opts.logTailFn]
 * @param {Function} [opts.spawnFn] Child runner handed to the two default
 *   `gh` probes, so their real bodies can be exercised without shelling out.
 *   Ignored when `checkRunFn` / `logTailFn` are replaced outright.
 * @returns {{ jsonPath: string, mdPath: string } | null}
 */
export function writeCiDigest({
  storyId = null,
  prNumber,
  headSha = null,
  failures,
  tempRoot,
  cwd,
  prRef,
  checkRunFn = resolveFailingCheckRun,
  logTailFn = ghRunLogTail,
  spawnFn,
}) {
  const paths = ciDigestPaths({ storyId, tempRoot, cwd });
  if (!paths) return null;
  const primary = failures[0] ?? { name: 'unknown', outcome: 'failure' };
  const checkRun =
    checkRunFn({ prRef, checkName: primary.name, cwd, spawnFn }) ?? {};
  const logTail = logTailFn({ runId: checkRun.runId, cwd, spawnFn });
  const previous = readCiDigest({ storyId, tempRoot, cwd });
  const digest = {
    storyId: paths.scope.id,
    prNumber,
    headSha,
    failingCheck: primary.name,
    failingOutcome: primary.outcome,
    runId: checkRun.runId ?? null,
    runUrl: checkRun.url ?? null,
    failingCheckRun: {
      name: primary.name,
      outcome: primary.outcome,
      runId: checkRun.runId ?? null,
      url: checkRun.url ?? null,
    },
    classification: classifyFailure(primary.name),
    allFailures: failures,
    priorReds: carryPriorReds(previous, headSha),
    logTail,
    generatedAt: new Date().toISOString(),
  };
  mkdirSync(path.dirname(paths.jsonPath), { recursive: true });
  writeFileSync(paths.jsonPath, `${JSON.stringify(digest, null, 2)}\n`);
  writeFileSync(paths.mdPath, renderDigestMarkdown(digest, failures));
  return { jsonPath: paths.jsonPath, mdPath: paths.mdPath };
}

/**
 * Adjudicate an all-green watch against any digest recorded for the scope.
 *
 * @param {{ digest: object|null, headSha: string|null }} opts
 * @returns {{ verdict: 'clean'|'fix-at-source'|'rerun'|'unverifiable', reason: string }}
 *   - `clean`         — no digest: this delivery never went red.
 *   - `fix-at-source` — the head SHA moved since the red; legal.
 *   - `rerun`         — green on the SAME head SHA; forbidden.
 *   - `unverifiable`  — an unresolved red with no head-SHA evidence either
 *                       side; fail closed and treat it as a rerun.
 */
export function classifyGreenVerdict({ digest, headSha }) {
  if (!digest) return { verdict: 'clean', reason: 'no digest for this scope' };
  const recorded = digest.headSha ?? null;
  if (!recorded || !headSha) {
    return {
      verdict: 'unverifiable',
      reason: `cannot prove the red was fixed at source (digest head=${recorded ?? 'unknown'}, current head=${headSha ?? 'unresolved'})`,
    };
  }
  if (recorded === headSha) {
    return {
      verdict: 'rerun',
      reason: `green on the SAME head SHA the red was recorded against (${headSha})`,
    };
  }
  return {
    verdict: 'fix-at-source',
    reason: `head SHA moved ${recorded} → ${headSha}`,
  };
}

/**
 * The failure signature an intake filing must carry (see `file-ci-gap.js`):
 * the first
 * distinctive line of the captured failed-job log.
 */
function failureSignature(digest) {
  const tail = String(digest?.logTail ?? '');
  const line = tail
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? '(no failed-log output captured)';
}

/**
 * Render the rerun-violation report — used verbatim as the friction comment
 * body and, line by line, as the watcher's stderr report.
 *
 * @param {{ digest: object, headSha: string|null, prNumber: number, reason: string }} opts
 * @returns {string}
 */
export function formatRerunViolation({ digest, headSha, prNumber, reason }) {
  return [
    '### Forbidden CI re-run detected — delivery blocked',
    '',
    `Required check \`${digest.failingCheck}\` went red on PR #${prNumber}, and the checks are`,
    `now green with no new commit: ${reason}.`,
    '',
    `- **Head SHA:** ${headSha ?? 'unresolved'}`,
    `- **Run link:** ${digest.runUrl ?? `run id ${digest.runId ?? 'unresolved'}`}`,
    `- **Failure signature:** \`${failureSignature(digest)}\``,
    `- **Classification:** ${digest.classification ?? 'unknown'}`,
    '',
    'A green reached by re-running a failed job masks the defect and is',
    'prohibited by `.agents/rules/ci-remediation.md` § Verifier. Native',
    'auto-merge was disarmed when the check first went red, so nothing merged.',
    '',
    '**To proceed**, do exactly one of:',
    '',
    '1. Fix the root cause on `story-<id>` and push a new commit — the head SHA',
    '   moving is what clears the block.',
    '2. When the root cause is outside this delivery, file the routed intake',
    '   issue — `node .agents/scripts/file-ci-gap.js --story <id> --verdict',
    '   <pre-existing|capacity|unreproducible-tier> --owner',
    '   <consumer|framework|platform> --evidence "<proof reading>"` — then',
    '   resume. It carries the run link and signature above, routes the filing',
    '   to whoever owns the fault, and updates the existing ticket when this',
    '   signature has been seen before.',
  ].join('\n');
}

/**
 * Hard-stop the delivery: post the `friction` comment and flip the Story to
 * `agent::blocked`. Both halves are best-effort — a failure to reach GitHub
 * must not turn the block into a crash, and the watcher's non-zero exit is
 * what actually stops the delivery.
 *
 * Routed through `transitionTicketState` rather than a bare label write so
 * the Projects v2 column sync runs (Story #2548 / #4539).
 *
 * @param {{
 *   storyId: number|string,
 *   body: string,
 *   provider?: object,
 *   config?: object,
 *   logger?: object,
 * }} opts
 * @returns {Promise<{ blocked: boolean, commented: boolean }>}
 */
export async function blockStoryDelivery({
  storyId,
  body,
  provider,
  config,
  logger = Logger,
}) {
  const scope = resolveDigestScope({ storyId });
  if (!scope) {
    logger?.error?.(
      '[ci-rerun-guard] no Story id — cannot flip agent::blocked; the non-zero exit is the only stop.',
    );
    return { blocked: false, commented: false };
  }
  let ticketing;
  try {
    ticketing = provider ?? createProvider(config ?? resolveConfig());
  } catch (err) {
    logger?.error?.(
      `[ci-rerun-guard] could not resolve the ticketing provider: ${err?.message ?? err}`,
    );
    return { blocked: false, commented: false };
  }
  let commented = false;
  try {
    await upsertStructuredComment(ticketing, scope.id, 'friction', body);
    commented = true;
  } catch (err) {
    logger?.error?.(
      `[ci-rerun-guard] failed to post the friction comment: ${err?.message ?? err}`,
    );
  }
  let blocked = false;
  try {
    await transitionTicketState(ticketing, scope.id, STATE_LABELS.BLOCKED, {});
    blocked = true;
  } catch (err) {
    logger?.error?.(
      `[ci-rerun-guard] failed to flip Story #${scope.id} to blocked: ${err?.message ?? err}`,
    );
  }
  return { blocked, commented };
}
