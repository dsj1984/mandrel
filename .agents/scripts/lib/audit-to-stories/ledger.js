/**
 * lib/audit-to-stories/ledger.js — Cross-run audit findings ledger.
 *
 * Without a committed memory of what a prior sweep already saw, every
 * `/audit-to-stories` run re-litigates the whole backlog from zero: it cannot
 * tell a brand-new finding from one already filed, an intentionally-rejected
 * finding from an unseen one, or a genuine regression from routine churn. The
 * ledger is that memory. It is a small committed JSON file
 * (`baselines/audit-ledger.json`, the same envelope shape as the arch-cycles
 * baseline — `{ $schema, generatedAt, entries: [] }`) keyed by each finding's
 * shared-helper fingerprint plus a location-based `semanticKey` that survives a
 * reworded title.
 *
 * Each entry carries a lifecycle `status`:
 *   - `new`          — seen, not yet filed as an Issue.
 *   - `filed`        — an Issue was opened; re-detections are known, not new.
 *   - `fixed`        — the tracking Issue closed as completed.
 *   - `accepted-risk`— the tracking Issue closed as `not_planned`; the finding
 *                      is deliberately rejected and is SUPPRESSED on re-detect.
 *   - `regressed`    — a `fixed` finding re-appeared (closed-completed Issue,
 *                      finding detected again).
 *
 * `reconcileLedger` folds a fresh scan and the live Issue states onto the prior
 * ledger, returning the next ledger plus a per-finding classification whose
 * `action` (`propose` | `known` | `suppress` | `regressed`) tells the caller
 * whether to open a Story. Pure: filesystem access is confined to the tiny
 * {@link readLedger} / {@link writeLedger} helpers, which take an injectable
 * `fs` so tests never touch disk.
 */

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import {
  fingerprintAuditFinding,
  semanticKeyForAuditFinding,
} from './finding-adapter.js';

export const DEFAULT_LEDGER_PATH = 'baselines/audit-ledger.json';
const LEDGER_SCHEMA_URL =
  'https://mandrel.dev/baselines/audit-ledger.schema.json';

// Entry lifecycle states — `new | filed | fixed | accepted-risk | regressed`.
// The reconcile policy in `decideStatus` is the single source of truth.

/**
 * Build an empty ledger envelope (arch-cycles-baseline shape).
 * @param {string} [now] — ISO timestamp to stamp.
 * @returns {{ $schema: string, generatedAt: string, entries: [] }}
 */
function createEmptyLedger(now = new Date().toISOString()) {
  return { $schema: LEDGER_SCHEMA_URL, generatedAt: now, entries: [] };
}

/**
 * Compute a finding's stable identity: its fingerprint (title-sensitive) and
 * its location-based semantic key (title-insensitive).
 * @param {object} finding — a parsed/stamped audit finding.
 * @returns {{ fingerprint: string, semanticKey: string }}
 */
function findingIdentity(finding) {
  return {
    fingerprint: fingerprintAuditFinding(finding).full,
    semanticKey: semanticKeyForAuditFinding(finding),
  };
}

/**
 * Read the ledger from disk. Returns an empty ledger when the file is absent
 * or unparseable — a missing memory is an empty memory, never a hard error.
 * @param {string} filePath
 * @param {{ fs?: typeof import('node:fs') }} [deps]
 * @returns {{ $schema?: string, generatedAt?: string, entries: object[] }}
 */
export function readLedger(filePath, { fs } = {}) {
  const fsLike = fs ?? nodeFs;
  if (!fsLike || !fsLike.existsSync(filePath)) return createEmptyLedger();
  try {
    const parsed = JSON.parse(fsLike.readFileSync(filePath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.entries)) return createEmptyLedger();
    return parsed;
  } catch (_) {
    return createEmptyLedger();
  }
}

/**
 * Persist the ledger to disk with a stable 2-space indent and a trailing
 * newline (so the committed file diffs cleanly).
 * @param {string} filePath
 * @param {object} ledger
 * @param {{ fs?: typeof import('node:fs'), path?: typeof import('node:path') }} [deps]
 */
export function writeLedger(filePath, ledger, { fs, path } = {}) {
  const fsLike = fs ?? nodeFs;
  const pathLike = path ?? nodePath;
  if (!fsLike) return;
  fsLike.mkdirSync(pathLike.dirname(filePath), { recursive: true });
  fsLike.writeFileSync(filePath, `${JSON.stringify(ledger, null, 2)}\n`);
}

/**
 * Index a ledger's entries by fingerprint and by semanticKey for O(1) lookup.
 * @param {{ entries?: object[] }} ledger
 */
function indexLedger(ledger) {
  const byFingerprint = new Map();
  const bySemanticKey = new Map();
  for (const entry of ledger?.entries ?? []) {
    if (entry?.fingerprint) byFingerprint.set(entry.fingerprint, entry);
    if (entry?.semanticKey) bySemanticKey.set(entry.semanticKey, entry);
  }
  return { byFingerprint, bySemanticKey };
}

/**
 * Resolve the effective Issue state for a finding: an explicit override in
 * `issueStates` (keyed by fingerprint then semanticKey) wins over whatever the
 * prior ledger entry recorded.
 * @param {{ fingerprint: string, semanticKey: string }} id
 * @param {object|null} existing
 * @param {Record<string, { state?: string, stateReason?: string|null, number?: number }>} issueStates
 * @returns {{ state: string, stateReason: string|null, number: number|null }|null}
 */
function resolveIssueState(id, existing, issueStates) {
  const override = issueStates[id.fingerprint] ?? issueStates[id.semanticKey];
  const raw = override ?? existing?.issue ?? null;
  if (!raw) return null;
  return {
    state: (raw.state ?? '').toLowerCase(),
    stateReason: raw.stateReason ? String(raw.stateReason).toLowerCase() : null,
    number: typeof raw.number === 'number' ? raw.number : null,
  };
}

/**
 * The four verdicts the policy can reach, spelled once. Deduping them keeps
 * `decideStatus` readable as the decision table it is, rather than eight
 * near-identical object literals.
 * @type {Record<string, { status: string, action: string }>}
 */
const VERDICT = Object.freeze({
  filed: Object.freeze({ status: 'filed', action: 'known' }),
  propose: Object.freeze({ status: 'new', action: 'propose' }),
  suppress: Object.freeze({ status: 'accepted-risk', action: 'suppress' }),
  regressed: Object.freeze({ status: 'regressed', action: 'regressed' }),
});

/**
 * Decide the finding's next status + action from its prior ledger state and
 * the live Issue state. This is the whole reconciliation policy in one place.
 * @param {object|null} existing — prior ledger entry (or null when unseen).
 * @param {{ state: string, stateReason: string|null }|null} issue
 * @returns {{ status: string, action: 'propose'|'known'|'suppress'|'regressed' }}
 */
function decideStatus(existing, issue) {
  // A closed Issue is the strongest signal — its close reason drives the
  // verdict, and it is read FIRST so a recorded `filed` can never outrank it.
  if (issue && issue.state === 'closed') {
    return issue.stateReason === 'not_planned'
      ? VERDICT.suppress
      : // Closed as completed (or unspecified) but the finding is in this scan
        // → it came back. That is a regression, not a fresh proposal.
        VERDICT.regressed;
  }

  // An OPEN tracking Issue means the finding has been filed, whatever the prior
  // entry said — including when there is no prior entry at all. Until Story
  // #5305 nothing in the package ever assigned `filed`, so this fell through to
  // `new`/`propose` on every run and the `filed` arm below was unreachable in
  // production: the ledger suppressed nothing, and only the GitHub-search dedup
  // stopped a sweep re-filing what it had already filed. Reading it before the
  // `!existing` guard is what makes a record pass correct on its FIRST run
  // rather than its second.
  const unseen = issue?.state === 'open' ? VERDICT.filed : VERDICT.propose;
  if (!existing) return unseen;

  switch (existing.status) {
    case 'accepted-risk':
      return VERDICT.suppress;
    case 'filed':
      return VERDICT.filed;
    // Recorded fixed, yet detected again with no closed-Issue evidence → treat
    // as a regression the operator should look at. An open Issue does not
    // soften that: the finding came back either way.
    case 'fixed':
      return VERDICT.regressed;
    case 'regressed':
      return VERDICT.regressed;
    default:
      return unseen;
  }
}

/**
 * Fold a fresh scan and the live Issue states onto the prior ledger.
 *
 * @param {object} params
 * @param {{ entries?: object[] }} [params.ledger] — prior ledger (default empty).
 * @param {Array<object>} params.findings — parsed/stamped audit findings from this scan.
 * @param {Record<string, { state?: string, stateReason?: string|null, number?: number }>} [params.issueStates]
 *   Live Issue state keyed by fingerprint (or semanticKey). Optional — when a
 *   prior entry already records the Issue, that is used.
 * @param {string} [params.now] — ISO timestamp for firstSeen/lastSeen stamping.
 * @returns {{
 *   ledger: { $schema: string, generatedAt: string, entries: object[] },
 *   classifications: Array<{ fingerprint: string, semanticKey: string, status: string, action: string, issue: object|null }>,
 * }}
 */
export function reconcileLedger({
  ledger = createEmptyLedger(),
  findings,
  issueStates = {},
  now = new Date().toISOString(),
} = {}) {
  if (!Array.isArray(findings)) {
    throw new Error('reconcileLedger: findings must be an array');
  }

  const { byFingerprint, bySemanticKey } = indexLedger(ledger);
  // Preserve any prior entries NOT touched by this scan (their memory survives).
  const nextByFingerprint = new Map(byFingerprint);
  const classifications = [];

  for (const finding of findings) {
    const id = findingIdentity(finding);
    const existing =
      byFingerprint.get(id.fingerprint) ??
      (id.semanticKey ? bySemanticKey.get(id.semanticKey) : undefined) ??
      null;

    const issue = resolveIssueState(id, existing, issueStates);
    const { status, action } = decideStatus(existing, issue);

    const entry = {
      fingerprint: id.fingerprint,
      semanticKey: id.semanticKey,
      title: finding?.title ?? existing?.title ?? '',
      dimension: finding?.dimension ?? existing?.dimension ?? '',
      primaryFile:
        (Array.isArray(finding?.files) && finding.files[0]) ??
        existing?.primaryFile ??
        '',
      status,
      issue: issue
        ? {
            number: issue.number,
            state: issue.state,
            stateReason: issue.stateReason,
          }
        : (existing?.issue ?? null),
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
    };

    // Re-key under the fresh fingerprint; drop the old entry if it was matched
    // by semanticKey under a now-drifted fingerprint (reworded finding).
    if (existing?.fingerprint && existing.fingerprint !== id.fingerprint) {
      nextByFingerprint.delete(existing.fingerprint);
    }
    nextByFingerprint.set(id.fingerprint, entry);

    classifications.push({
      fingerprint: id.fingerprint,
      semanticKey: id.semanticKey,
      status,
      action,
      issue: entry.issue,
    });
  }

  return {
    ledger: {
      $schema: ledger?.$schema ?? LEDGER_SCHEMA_URL,
      generatedAt: now,
      entries: [...nextByFingerprint.values()],
    },
    classifications,
  };
}
