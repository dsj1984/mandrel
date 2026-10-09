/**
 * Render a standalone audit Story body that clears the inline-contract bar,
 * with audit extras appended as informational markdown. Pure.
 */

import path from 'node:path';
import { sortBySeverity } from '../findings/severity.js';
import { RISK_LABELS, TYPE_LABELS } from '../label-constants.js';
import { serialize } from '../story-body/story-body.js';
import { definesAuditLabel } from './audit-label-taxonomy.js';
import { auditLabelsForFindings } from './audit-lenses.js';
import {
  renderFingerprintFooter,
  renderSemanticKeyFooter,
} from './finding-adapter.js';
import { findingBullets, STORY_FINDING_FIELDS } from './finding-bullets.js';

// Deliberately no `agent::` state label: audit prose is not ready for pickup.
// `/mandrel-plan` stamps `agent::ready` once enriched; an absent state is a
// legal initial state for `isValidTransition`.
const STATIC_LABELS = Object.freeze([TYPE_LABELS.STORY]);

const DEFAULT_VERIFY = Object.freeze([
  'npm run lint (validate)',
  'npm test (unit)',
]);

function uniq(items) {
  return [...new Set(items)];
}

/**
 * The group intent only — no ordinal or `[SEVERITY]`/`(dimension)` prefix.
 *
 * @param {object} group
 * @returns {string}
 */
function goalFromGroup(group) {
  return (group.title ?? '').trim();
}

/**
 * @param {object} group
 * @returns {Array<{ path: string, assumption: string }>}
 */
function changesFromGroup(group) {
  const fromGroup = Array.isArray(group.files) ? group.files : [];
  const fromFindings = (group.findings ?? []).flatMap((f) =>
    Array.isArray(f.files) ? f.files : [],
  );
  const paths = uniq(
    [...fromGroup, ...fromFindings].filter(
      (p) => typeof p === 'string' && p.length > 0,
    ),
  );
  return paths.map((path) => ({ path, assumption: 'refactors-existing' }));
}

/**
 * A checkable end-state anchored on title and primary file, for a finding
 * whose lens wrote no Acceptance signal.
 *
 * @param {object} finding
 * @param {string} title
 * @returns {string}
 */
function synthesizedAcceptance(finding, title) {
  const primaryFile =
    Array.isArray(finding.files) && finding.files.length > 0
      ? finding.files[0]
      : null;
  const where = primaryFile ? ` in \`${primaryFile}\`` : '';
  return `${title} is remediated${where}: the recommended end-state holds and the finding is no longer reproducible`;
}

/**
 * The lens's own Acceptance signal when it wrote one, else the synthesized
 * end-state — never the verbatim recommendation, which stays in `## Findings`.
 *
 * @param {object} finding
 * @returns {string}
 */
function acceptanceItemFromFinding(finding) {
  const title = (finding.title ?? 'finding').trim();
  return finding.acceptanceSignal
    ? `${title} — ${finding.acceptanceSignal}`
    : synthesizedAcceptance(finding, title);
}

function acceptanceCriteriaFromGroup(group) {
  return sortBySeverity(group.findings ?? []).map(acceptanceItemFromFinding);
}

/**
 * @param {object} group
 * @param {Array<{ fromGroupKey: string, toGroupKey: string }>} edges
 * @returns {string[]}
 */
function sequencingDepsForGroup(group, edges) {
  if (!Array.isArray(edges) || edges.length === 0) return [];
  const deps = edges
    .filter((e) => e && e.fromGroupKey === group.groupKey)
    .map((e) => e.toGroupKey)
    .filter((k) => typeof k === 'string' && k.length > 0);
  return uniq(deps);
}

/**
 * Group keys → `#N` refs, or `[]` before issues are numbered (first pass).
 * Edges whose target was not created drop. `issueByGroupKey` must be a plain
 * object: `applyBlockedByDependencies` indexes the same map by property, so a
 * `Map` would silently skip every edge.
 *
 * @param {string[]} deps                     Group keys this group depends on.
 * @param {Record<string, number>|null} issueByGroupKey
 * @returns {string[]} `#N` refs, in `deps` order.
 */
function dependencyRefs(deps, issueByGroupKey) {
  if (!issueByGroupKey) return [];
  return deps
    .map((key) => issueByGroupKey[key])
    .filter((n) => Number.isInteger(n) && n > 0)
    .map((n) => `#${n}`);
}

/**
 * @param {object} finding
 * @returns {string} a `###` title and the finding's present fields.
 */
function findingBlock(finding) {
  return [
    `### ${finding.title}`,
    '',
    ...findingBullets(finding, STORY_FINDING_FIELDS),
  ].join('\n');
}

/**
 * One block per finding, worst first, carrying the remediation detail the
 * acceptance list deliberately leaves out.
 *
 * @param {object} group
 * @returns {string}
 */
function findingsSection(group) {
  return sortBySeverity(group.findings).map(findingBlock).join('\n\n');
}

/**
 * Link each source report once (basename label, path target); repeating the
 * path is a token the footprint guard can scrape as edit intent.
 *
 * @param {object} group
 * @returns {string}
 */
function contextLinksFromGroup(group) {
  const reports = uniq(
    (group.findings ?? [])
      .map((f) => f.sourceReport)
      .filter((s) => typeof s === 'string'),
  );
  if (reports.length === 0) return '_(no source audit reports captured)_';
  // `path.basename` splits on both separators on win32; `split('/')` would
  // leave a Windows path whole and render it twice.
  return reports.map((r) => `- [${path.basename(r)}](${r})`).join('\n');
}

function labelsForGroup(group) {
  // `audit::<lens>` comes from each `sourceReport` basename, never from the
  // free-form `dimension` text, which mints non-existent labels.
  const auditLabels = auditLabelsForFindings(group.findings ?? []);
  const labels = [...STATIC_LABELS, ...auditLabels];
  const hasCritical = (group.findings ?? []).some(
    (f) => f.severity === 'critical',
  );
  if (hasCritical) labels.push(RISK_LABELS.HIGH);
  return assertLabelsInTaxonomy(uniq(labels));
}

/**
 * Throws rather than emit a label the repo lacks: a create would drop or fail
 * on it, and silently losing `risk::high` on a Critical is worse.
 *
 * @param {string[]} labels
 * @returns {string[]} the same labels, when every one is defined.
 * @throws {Error} naming the offending labels.
 */
function assertLabelsInTaxonomy(labels) {
  const undefinedLabels = labels.filter((l) => !definesAuditLabel(l));
  if (undefinedLabels.length > 0) {
    throw new Error(
      `buildStoryBody: generated label(s) ${undefinedLabels.join(', ')} are not ` +
        'defined by the audit label taxonomy (audit-label-taxonomy.js). Add ' +
        'them there — or stop generating them — rather than emitting a label ' +
        'the repository does not have.',
    );
  }
  return labels;
}

/**
 * Second pass passes `issueByGroupKey` so edges render as `blocked by #N`.
 *
 * @param {object} params
 * @param {object} params.group — output of `groupFindings` (one entry).
 * @param {Array<{ fromGroupKey: string, toGroupKey: string }>} [params.edges]
 * @param {Record<string, number>|null} [params.issueByGroupKey] Second pass only.
 * @returns {{ title: string, body: string, labels: string[], groupKey: string, dependsOn: string[] }}
 */
export function buildStoryBody({ group, edges = [], issueByGroupKey = null }) {
  if (!group || !Array.isArray(group.findings)) {
    throw new Error('buildStoryBody: group with findings[] is required');
  }
  const title = group.title;
  const dependsOn = sequencingDepsForGroup(group, edges);

  const storyBody = {
    goal: goalFromGroup(group),
    changes: changesFromGroup(group),
    acceptance: acceptanceCriteriaFromGroup(group),
    verify: [...DEFAULT_VERIFY],
    references: [],
    wide: null,
    reason_to_exist: null,
    depends_on: dependencyRefs(dependsOn, issueByGroupKey),
  };

  // The serializer's own footer, so `/mandrel-deliver` reads the ordering
  // where it reads every other Story's.
  const canonicalSections = serialize(storyBody, {
    includeFooter: storyBody.depends_on.length > 0,
  });

  const body = [
    canonicalSections,
    '',
    '## Findings',
    '',
    findingsSection(group),
    '',
    '## Context',
    '',
    'This Story was opened by `/audit-to-stories` from the following audit reports:',
    '',
    contextLinksFromGroup(group),
    '',
    renderFingerprintFooter(group.findings),
    renderSemanticKeyFooter(group.findings),
  ].join('\n');

  return {
    title,
    body,
    labels: labelsForGroup(group),
    groupKey: group.groupKey,
    dependsOn,
  };
}
