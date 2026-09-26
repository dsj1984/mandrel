/**
 * One finding's walk through the graduator, as route → dedup → file steps.
 * Every step receives the gh context as the single `gh` value.
 */

import { routeOwnership } from '../github/framework-repo.js';
import {
  createFollowUpIssue,
  ensureIssueLabels,
  findExistingFollowUp,
  probePathStatus,
  searchFollowUpByMarker,
  updateFollowUpIssue,
} from './graduator-gh.js';

/** @returns {Promise<string|null>} A skip reason, or `null` to continue. */
export async function probeFindingPath({ finding, gitRef, gh }) {
  // A path-less finding would misclassify as `file-removed`; skip the probe.
  if (typeof finding.path !== 'string' || finding.path.trim().length === 0) {
    return null;
  }
  const { exists, probeError } = await probePathStatus({
    ref: gitRef,
    path: finding.path,
    ...gh,
  });
  if (probeError) return 'probe-error';
  return exists ? null : 'file-removed';
}

/**
 * Unroutable findings are deferred and named, never re-pointed at the
 * consumer's repo.
 *
 * @returns {{ source: string, routedRepo: object|null, deferred: object|null, skipReason: string|null }}
 */
export function routeFinding({
  finding,
  classifier,
  repos,
  currentRepo,
  logger,
  spec,
}) {
  const source = classifier(finding.path, null);
  const routing = routeOwnership({ bucket: source, repos, currentRepo });
  if (!routing.routable) {
    const logLine = `[${spec.fnName}] unroutable ${source} finding (${routing.missingKey} is unset) — not filed: ${finding.title ?? finding.path ?? `finding ${finding.index}`}`;
    logger?.warn?.(logLine);
    const deferred = {
      finding,
      routedRepo: null,
      source,
      logLine,
      missingKey: routing.missingKey,
    };
    return { source, routedRepo: null, deferred, skipReason: 'unroutable' };
  }
  const routedRepo = routing.routedRepo;
  if (routing.crossRepo) {
    const logLine = spec.buildCrossRepoLog({ finding, routedRepo, source });
    logger?.info?.(logLine);
    const deferred = { finding, routedRepo, source, logLine };
    return { source, routedRepo, deferred, skipReason: 'cross-repo-deferred' };
  }
  return { source, routedRepo, deferred: null, skipReason: null };
}

/**
 * Checks the content-hash marker, then the legacy ordinal marker so
 * pre-fingerprint filings are not re-filed.
 *
 * @returns {Promise<{ number: number|null, state: string, url: string }|null>}
 */
export async function dedupFinding({
  finding,
  epicId,
  routedRepo,
  contentMarker,
  gh,
  spec,
}) {
  const probe = (marker) =>
    searchFollowUpByMarker({
      marker,
      owner: routedRepo.owner,
      repo: routedRepo.repo,
      ...gh,
    });
  const hit = await probe(contentMarker);
  if (hit) return hit;
  const legacyMarker =
    typeof spec.buildLegacyMarker === 'function'
      ? spec.buildLegacyMarker(epicId, finding.index)
      : null;
  return legacyMarker ? probe(legacyMarker) : null;
}

/**
 * An open, numbered match is refreshed and recorded on `filed` as
 * `action: 'updated'` (a live write, counted like a creation). Anything else
 * is `already-filed` and untouched: a closed follow-up is a human's decision.
 */
export async function recordRecurrence(walk, existing, body) {
  const { finding, source, routedRepo, envelope, decorate, skip, gh } = walk;
  walk.filedMarkers?.add(walk.contentMarker);
  if (existing.state !== 'open' || existing.number === null) {
    skip('already-filed');
    return;
  }
  const updated = await updateFollowUpIssue({
    owner: routedRepo.owner,
    repo: routedRepo.repo,
    number: existing.number,
    body,
    ...gh,
  });
  if (updated.error) {
    envelope.errors.push(
      `finding ${finding.index} (${finding.path}): ${updated.error}`,
    );
    return;
  }
  envelope.filed.push(
    decorate(
      {
        index: finding.index,
        action: 'updated',
        issueNumber: existing.number,
        severity: finding.severity,
        path: finding.path,
        source,
        repo: `${routedRepo.owner}/${routedRepo.repo}`,
        url: updated.url || existing.url || null,
      },
      finding,
    ),
  );
}

function strongReadExisting(walk, labels) {
  const { epicId, finding, contentMarker, routedRepo, spec } = walk;
  return findExistingFollowUp({
    markers:
      typeof spec.buildMatchTokens === 'function'
        ? spec.buildMatchTokens({ epicId, finding, contentMarker })
        : [contentMarker],
    owner: routedRepo.owner,
    repo: routedRepo.repo,
    labels,
    ...walk.gh,
  });
}

/** Cap → label mint → strong-read confirm → create. */
export async function fileFinding(walk, { title, body, labels }) {
  const { finding, routedRepo, envelope, decorate, skip, gh } = walk;
  if (envelope.filed.length >= walk.maxFilingsPerRun) {
    return skip('cap-reached');
  }
  // Before the strong read too: `gh issue list --label <absent>` exits 0
  // with `[]`, silently defeating the dedup confirm.
  const ensured = await ensureIssueLabels({
    owner: routedRepo.owner,
    repo: routedRepo.repo,
    labels,
    labelCache: walk.labelCache,
    ...gh,
  });
  envelope.errors.push(...ensured.errors);
  if (ensured.missing.length > 0) return skip('label-ensure-failed');

  const confirmed = await strongReadExisting(walk, labels);
  if (confirmed) return recordRecurrence(walk, confirmed, body);

  const created = await createFollowUpIssue({
    owner: routedRepo.owner,
    repo: routedRepo.repo,
    title,
    body,
    labels,
    ...gh,
  });
  if (created.error) {
    envelope.errors.push(
      `finding ${finding.index} (${finding.path}): ${created.error}`,
    );
    return;
  }
  walk.filedMarkers?.add(walk.contentMarker);
  envelope.filed.push(
    decorate(
      {
        index: finding.index,
        action: 'created',
        severity: finding.severity,
        path: finding.path,
        source: walk.source,
        repo: `${routedRepo.owner}/${routedRepo.repo}`,
        url: created.url,
      },
      finding,
    ),
  );
}
