// .agents/scripts/lib/orchestration/ci-rerun-guard.js
/**
 * ci-rerun-guard.js — mechanism behind the no-rerun MUST in
 * `rules/ci-remediation.md` § Verifier, driven by `pr-watch-with-update.js`:
 * the CI failure digest, the head-SHA discriminator, and the block.
 *
 * Enforcement happens at the first red, not the rerun-green: native
 * auto-merge fires server-side and races the watcher, so only the red is a
 * race-free observation point. The watcher disarms on red and records the
 * head SHA. A later green on a different SHA is a fix at source; on the
 * same SHA it is a forbidden rerun, unless `file-ci-gap.js` recorded a
 * `capacity`/`unreproducible-tier` allowance for that SHA (one rerun; it
 * dies with the digest). A missing SHA on either side fails closed.
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
import { isRerunPermitted } from './check-state.js';
import {
  STATE_LABELS,
  transitionTicketState,
  upsertStructuredComment,
} from './ticketing.js';

/** How many superseded unresolved reds a digest carries before the oldest is dropped. */
const MAX_PRIOR_REDS = 10;

/**
 * Verdicts earning the one same-SHA rerun: proven environment faults no
 * commit can fix. `pre-existing` is excluded — a real defect on `main`.
 *
 * @type {readonly ['capacity', 'unreproducible-tier']}
 */
export const RERUN_ALLOWANCE_VERDICTS = Object.freeze([
  'capacity',
  'unreproducible-tier',
]);

/**
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
 * Coarse classification from a check name; steers the next move, not a
 * root-cause verdict.
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
 * Digest paths for a scope; `null` without a Story id to key on.
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
 * Tail of the failed job log; best-effort, empty on any failure.
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
 * The failing check's run id and URL (the intake filing needs the link).
 * Best-effort.
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
 * The PR's head SHA; `null` on failure, which callers treat as
 * unverifiable, never as "changed".
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
 * The digest, or `null`; a malformed one carries no evidence and counts as
 * absent.
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
 * Retire the digest once its red is resolved.
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
 * Summary kept in `priorReds` so a new red never erases an unresolved one.
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
 * A re-red on the same head is not duplicated into history.
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
    'new commit — the head SHA moving is what clears this digest. The one',
    'exception: `file-ci-gap.js --verdict capacity|unreproducible-tier` records',
    'an allowance for this head SHA, and exactly one rerun is then admitted.',
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
 * Write the digest (`.json` + `.md`); `null` without a Story id.
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
 * @param {Function} [opts.spawnFn] Child runner for the default `gh` probes.
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
 * Stamp the one-rerun allowance, called by `file-ci-gap.js` after filing.
 * Keyed on the digest's own head SHA so it cannot apply to a later head.
 * Non-throwing; `null` when nothing was written (the guard keeps blocking).
 *
 * @param {{
 *   storyId?: number|string|null,
 *   verdict: string,
 *   tempRoot: string,
 *   cwd: string,
 *   now?: () => Date,
 * }} opts
 * @returns {{ verdict: string, headSha: string, recordedAt: string } | null}
 */
export function recordRerunAllowance({
  storyId = null,
  verdict,
  tempRoot,
  cwd,
  now = () => new Date(),
}) {
  if (!RERUN_ALLOWANCE_VERDICTS.includes(verdict)) return null;
  const paths = ciDigestPaths({ storyId, tempRoot, cwd });
  const digest = readCiDigest({ storyId, tempRoot, cwd });
  if (!paths || !digest?.headSha) return null;
  const allowance = {
    verdict,
    headSha: digest.headSha,
    recordedAt: now().toISOString(),
  };
  try {
    writeFileSync(
      paths.jsonPath,
      `${JSON.stringify({ ...digest, rerunAllowance: allowance }, null, 2)}\n`,
    );
  } catch {
    return null;
  }
  return allowance;
}

/**
 * @param {object|null} digest
 * @param {string|null} headSha
 * @returns {{ verdict: string, headSha: string } | null}
 */
function allowanceFor(digest, headSha) {
  const allowance = digest?.rerunAllowance;
  return allowance &&
    typeof allowance === 'object' &&
    headSha &&
    allowance.headSha === headSha &&
    RERUN_ALLOWANCE_VERDICTS.includes(allowance.verdict)
    ? allowance
    : null;
}

/**
 * Adjudicate an all-green watch against the scope's digest (see header).
 *
 * @param {{ digest: object|null, headSha: string|null }} opts
 * @returns {{ verdict: 'clean'|'fix-at-source'|'rerun-permitted'|'rerun'|'unverifiable', reason: string }}
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
    // Digests only record required checks.
    const allowance = allowanceFor(digest, headSha);
    return isRerunPermitted({
      required: true,
      allowanceRecorded: allowance !== null,
    })
      ? {
          verdict: 'rerun-permitted',
          reason: `one rerun admitted: \`${allowance.verdict}\` verdict recorded for this head SHA (${headSha})`,
        }
      : {
          verdict: 'rerun',
          reason: `green on the SAME head SHA the red was recorded against (${headSha})`,
        };
  }
  return {
    verdict: 'fix-at-source',
    reason: `head SHA moved ${recorded} → ${headSha}`,
  };
}

/** First non-blank failed-log line: the signature an intake filing carries. */
function failureSignature(digest) {
  const tail = String(digest?.logTail ?? '');
  const line = tail
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? '(no failed-log output captured)';
}

/**
 * The friction comment body, also the watcher's stderr report.
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
    '   signature has been seen before. A `capacity` or `unreproducible-tier`',
    '   verdict also records the one-rerun allowance for this head SHA, so a',
    '   single rerun of the failed job is then admitted; `pre-existing` does',
    '   not, because it names a real defect a rerun cannot remove.',
  ].join('\n');
}

/**
 * Post the `friction` comment and flip to `agent::blocked` (via
 * `transitionTicketState` so the board column syncs). Best-effort: the
 * watcher's non-zero exit is what actually stops delivery.
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
