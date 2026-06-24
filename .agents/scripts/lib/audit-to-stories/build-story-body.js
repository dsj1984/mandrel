/**
 * lib/audit-to-stories/build-story-body.js
 *
 * Render the canonical Story body for the standalone grouping mode so a
 * generated audit Story clears the same inline-contract bar the decomposer
 * enforces (`assertEveryStoryHasInlineContract`): a clean goal, observable
 * `acceptance[]`, a populated `changes[]` footprint, and a non-empty,
 * tier-tagged `verify[]` (Story #4270).
 *
 * Pure: returns { title, body, labels }. Labels carry one canonical
 * `audit::<lens>` per distinct source report represented in the merge
 * (derived from each finding's `sourceReport` basename, NEVER from the
 * fine-grained `dimension` text — see Story #4195), plus the standard
 * `type::story`, `agent::ready`, and (when any finding is Critical)
 * `risk::high`.
 *
 * The body is serialized via the canonical story-body serializer
 * (`.agents/scripts/lib/story-body/story-body.js`) so the output round-trips
 * through `parse()` / `serialize()`. Audit-specific content (agent prompts,
 * context links, fingerprint footer) is appended after the canonical sections
 * as extended markdown — it is informational only and is not part of the
 * structured contract.
 */

import { serialize } from '../story-body/story-body.js';
import { auditLabelsForFindings } from './audit-lenses.js';
import { renderFingerprintFooter } from './finding-adapter.js';

const STATIC_LABELS = Object.freeze(['type::story', 'agent::ready']);

// The verify[] contract every generated audit Story carries. These commands
// exist in this repo's harness (package.json scripts) so the Story satisfies
// the inline-contract bar with runnable, tier-tagged gates rather than
// placeholder prose. Kept as a frozen constant so the same contract is
// asserted by the unit suite.
const DEFAULT_VERIFY = Object.freeze([
  'npm run lint (validate)',
  'npm test (unit)',
]);

function uniq(items) {
  return [...new Set(items)];
}

/**
 * The goal is the group intent only — the synthesized `group.title`. It
 * carries no leading ordinal (`1.`/`2.`) and no `[SEVERITY]` / `(dimension)`
 * prefix (the polluted shape Story #4270 replaced); those signals live in the
 * per-finding fingerprint footer and the extended Agent Prompts section, not
 * in the goal.
 *
 * @param {object} group
 * @returns {string}
 */
function goalFromGroup(group) {
  return (group.title ?? '').trim();
}

/**
 * Map every distinct file mentioned across the merge onto a canonical
 * `changes[]` PathEntry (`{ path, assumption }`). Audit findings remediate
 * code that already exists, so the assumption is `refactors-existing`.
 *
 * `group.files` is an array post-`groupFindings`; fall back to scanning the
 * findings' own `files[]` when an upstream caller hands a group whose `files`
 * aggregate was not materialized.
 *
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
 * Build an observable acceptance item from a single finding: a checkable
 * end-state a reviewer can confirm, NOT the verbatim recommendation
 * paragraph. The recommendation prose is preserved verbatim in the Agent
 * Prompts / fingerprint footer for the implementer; the acceptance line is
 * the binding, confirmable outcome.
 *
 * Shape: `<title> is remediated in <primary file>: the recommended end-state
 * holds and the finding is no longer reproducible.` — anchored on the finding
 * title and primary file so the reviewer knows exactly what to check.
 *
 * @param {object} finding
 * @returns {string}
 */
function acceptanceItemFromFinding(finding) {
  const title = (finding.title ?? 'finding').trim();
  const primaryFile =
    Array.isArray(finding.files) && finding.files.length > 0
      ? finding.files[0]
      : null;
  const where = primaryFile ? ` in \`${primaryFile}\`` : '';
  return `${title} is remediated${where}: the recommended end-state holds and the finding is no longer reproducible`;
}

function acceptanceCriteriaFromGroup(group) {
  return (group.findings ?? []).map(acceptanceItemFromFinding);
}

/**
 * Resolve the `edges[]` sequencing anchored on this group. Each edge whose
 * `fromGroupKey` matches this group's key contributes its `toGroupKey`. Group
 * keys are the only stable identifier available at emit time — issues are not
 * numbered yet — so the relationship is preserved as machine-readable keys the
 * operator can resolve.
 *
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
 * Render the carried-through `edges[]` sequencing as a dedicated extended
 * markdown block. The canonical `depends_on[]` footer only round-trips `#N`
 * issue refs (`blocked by #123`), which do not exist before the issues are
 * opened; rendering the group-key sequencing as its own informational section
 * keeps the signal in the body (not discarded — Story #4270) and survives
 * `parse()` / `serialize()` round-tripping (it is preamble/extended content,
 * not a structured section). Returns the empty string when there is no
 * sequencing to surface.
 *
 * @param {string[]} deps
 * @returns {string}
 */
function sequencingSection(deps) {
  if (deps.length === 0) return '';
  const lines = deps.map((k) => `- depends on group \`${k}\``);
  return ['## Sequencing', '', lines.join('\n'), ''].join('\n');
}

function agentPromptsSection(group) {
  const blocks = (group.findings ?? [])
    .filter(
      (f) => typeof f.agentPrompt === 'string' && f.agentPrompt.length > 0,
    )
    .map((f) => `**${f.title}**\n\n\`\`\`\n${f.agentPrompt}\n\`\`\``);
  return blocks.join('\n\n') || '_(no copy-pasteable prompts captured)_';
}

function contextLinksFromGroup(group) {
  const reports = uniq(
    (group.findings ?? [])
      .map((f) => f.sourceReport)
      .filter((s) => typeof s === 'string'),
  );
  if (reports.length === 0) return '_(no source audit reports captured)_';
  return reports.map((r) => `- [\`${r}\`](${r})`).join('\n');
}

function labelsForGroup(group) {
  // Derive `audit::<lens>` from each finding's `sourceReport` basename
  // (`audit-<lens>-results.md` → `audit::<lens>`), NOT from the finding's
  // fine-grained `dimension` text. The dimension is free-form prose
  // ("stale-description", "dry", "efficiency (cpu)") and minting
  // `audit::<dimension>` from it produced non-existent labels; only the 14
  // canonical lens labels are valid. Multi-lens groups carry one label per
  // distinct source report. See Story #4195.
  const auditLabels = auditLabelsForFindings(group.findings ?? []);
  const labels = [...STATIC_LABELS, ...auditLabels];
  const hasCritical = (group.findings ?? []).some(
    (f) => f.severity === 'critical',
  );
  if (hasCritical) labels.push('risk::high');
  return uniq(labels);
}

/**
 * @param {object} params
 * @param {object} params.group — output of `groupFindings` (one entry).
 * @param {Array<{ fromGroupKey: string, toGroupKey: string }>} [params.edges]
 *   — the dependency `edges[]` emitted by `groupFindings`. Edges anchored on
 *   this group are carried through to `depends_on[]`; omit when no sequencing
 *   is known.
 * @returns {{ title: string, body: string, labels: string[] }}
 */
export function buildStoryBody({ group, edges = [] }) {
  if (!group || !Array.isArray(group.findings)) {
    throw new Error('buildStoryBody: group with findings[] is required');
  }
  const title = group.title;

  // Build the canonical StoryBody object from the audit group data. The
  // acceptance + verify arrays are populated so the body clears the
  // inline-contract bar; changes[] carries the file footprint. The edges[]
  // sequencing is carried through as an extended `## Sequencing` block (see
  // sequencingSection) — group keys are not `#N` refs, so they cannot ride the
  // canonical depends_on footer.
  const storyBody = {
    goal: goalFromGroup(group),
    changes: changesFromGroup(group),
    acceptance: acceptanceCriteriaFromGroup(group),
    verify: [...DEFAULT_VERIFY],
    references: [],
    wide: null,
    reason_to_exist: null,
    depends_on: [],
    estimated_test_files: null,
  };

  // Serialize via the canonical serializer (no footer — depends_on is empty).
  const canonicalSections = serialize(storyBody);
  const sequencing = sequencingSection(sequencingDepsForGroup(group, edges));

  // Append audit-specific extended sections (sequencing, agent prompts,
  // context links, fingerprint footer) that are not part of the canonical
  // shape.
  const body = [
    canonicalSections,
    '',
    ...(sequencing ? [sequencing] : []),
    '## Agent Prompts',
    '',
    agentPromptsSection(group),
    '',
    '## Context',
    '',
    'This Story was opened by `/audit-to-stories` from the following audit reports:',
    '',
    contextLinksFromGroup(group),
    '',
    renderFingerprintFooter(group.findings),
  ].join('\n');

  return { title, body, labels: labelsForGroup(group) };
}
