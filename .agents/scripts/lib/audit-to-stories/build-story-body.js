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
 * fine-grained `dimension` text — see Story #4195), plus `type::story` and
 * (when any finding is Critical) `risk::high`. Deliberately **no `agent::`
 * state label** — see {@link STATIC_LABELS}.
 *
 * The body is serialized via the canonical story-body serializer
 * (`.agents/scripts/lib/story-body/story-body.js`) so the output round-trips
 * through `parse()` / `serialize()`. Audit-specific content (agent prompts,
 * context links, fingerprint footer) is appended after the canonical sections
 * as extended markdown — it is informational only and is not part of the
 * structured contract.
 */

import path from 'node:path';
import { RISK_LABELS, TYPE_LABELS } from '../label-constants.js';
import { serialize } from '../story-body/story-body.js';
import { definesAuditLabel } from './audit-label-taxonomy.js';
import { auditLabelsForFindings } from './audit-lenses.js';
import {
  renderFingerprintFooter,
  renderSemanticKeyFooter,
} from './finding-adapter.js';

// The story-axis labels every generated audit Story carries, and the one it
// deliberately does NOT: an `agent::` state.
//
// This used to be `[TYPE_LABELS.STORY, AGENT_LABELS.READY]`, which put every
// Story the sweep filed one step from execution. `agent::ready` is precisely
// what `/mandrel-deliver` reads as "available for pickup", and the bodies
// reaching this function are audit prose — a synthesized acceptance line per
// finding and an Agent Prompts section that is empty whenever the lens
// captured no `agentPrompt`. Filing them ready contradicted the sweep's own
// shipped runbook, whose enrich-before-you-deliver step says not to point
// `/mandrel-deliver` at a freshly-filed audit Story; the label said the
// opposite of the prose, and the label is the half a machine reads.
//
// The state axis therefore belongs to whoever enriches the finding:
// `/mandrel-plan` stamps `agent::ready` as its terminal flip once the Story
// has a `## Spec`, real acceptance criteria and runnable verify lines. An
// absent `agent::` label is a legal initial state — `isValidTransition`
// treats a null from-state as the initial-entry edge and permits any target —
// so nothing downstream has to special-case the gap (Story #5229).
const STATIC_LABELS = Object.freeze([TYPE_LABELS.STORY]);

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
 * `fromGroupKey` matches this group's key contributes its `toGroupKey`.
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
 * Resolve this group's sequencing to canonical `#N` issue refs, or `[]` when
 * the caller has no issue numbers yet (Story #5044).
 *
 * Group keys are the only identifier that exists at *emit* time — the issues
 * are not numbered — which is why this used to render as a prose
 * `## Sequencing` block that nothing could act on. Standalone audit Stories
 * therefore hardcoded `depends_on: []`, and their only actual serializer was
 * an accident: their shared provenance footers collided under the delivery
 * footprint guard. Narrowing that scrape removes the accident, so the ordering
 * has to become real in the same change.
 *
 * The resolution is the two-pass shape `plan-persist` already uses: create every
 * issue first, then re-render each body with the now-known numbers and mirror
 * the same edges as native `blocked_by` relations. An edge whose target was not
 * created (deduped against an existing Issue, suppressed by the ledger) simply
 * drops — a `blocked by #undefined` would be worse than an absent edge.
 *
 * A **plain object**, deliberately, not a `Map`: the same map is handed to
 * `applyBlockedByDependencies`, which indexes it with property access, so a
 * `Map` there would silently resolve every lookup to `undefined`, skip every
 * edge, and report success having written nothing. One shape, both halves.
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

function agentPromptsSection(group) {
  const blocks = (group.findings ?? [])
    .filter(
      (f) => typeof f.agentPrompt === 'string' && f.agentPrompt.length > 0,
    )
    .map((f) => `**${f.title}**\n\n\`\`\`\n${f.agentPrompt}\n\`\`\``);
  return blocks.join('\n\n') || '_(no copy-pasteable prompts captured)_';
}

/**
 * Link each source audit report **once**.
 *
 * This used to render `- [\`path\`](path)` — the same
 * `temp/audits/audit-<lens>-results.md` in the link text and again in the URL,
 * byte-identical across every Story of a same-lens sweep. That doubled a token
 * the delivery footprint guard scraped as edit intent, so a lens's whole cohort
 * serialized on a report none of them would ever write to (Story #5044). The
 * guard now ignores markdown-link URLs and temp-root paths, but rendering the
 * path twice was never useful to a reader either: the file name is the label,
 * the path is the target.
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
  // `path.basename` rather than `split('/')`: on win32 it splits on both
  // separators, so an absolute Windows path yields the file name instead of
  // the whole path — which would render the path twice in one link and
  // re-create the very duplication this function exists to remove.
  return reports.map((r) => `- [${path.basename(r)}](${r})`).join('\n');
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
  if (hasCritical) labels.push(RISK_LABELS.HIGH);
  return assertLabelsInTaxonomy(uniq(labels));
}

/**
 * Refuse to generate a label the audit bootstrap taxonomy does not define
 * (Story #4877).
 *
 * Story #4195 fixed half of this: `audit::<dimension>` labels minted from
 * free-form dimension prose ("stale-description", "dry") named labels that did
 * not exist, so derivation moved to the closed lens list. The other half stayed
 * open — `risk::high` was a bare string literal here, defined by no taxonomy —
 * and nothing checked the generated set against anything at all. Throwing is
 * deliberate: a label the repo has never created is dropped or fails the create
 * outright, and a filer that silently loses `risk::high` on a Critical merge is
 * worse than a loud failure at the point of generation.
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
 * @param {object} params
 * @param {object} params.group — output of `groupFindings` (one entry).
 * @param {Array<{ fromGroupKey: string, toGroupKey: string }>} [params.edges]
 *   — the dependency `edges[]` emitted by `groupFindings`. Edges anchored on
 *   this group are carried through to `depends_on[]`; omit when no sequencing
 *   is known.
 * @param {Record<string, number>|null} [params.issueByGroupKey]
 *   — group key → opened issue number. Supplied on the **second** pass, once
 *   the issues exist, so this group's edges render as canonical
 *   `blocked by #N` footers (Story #5044). Omit on the first pass.
 * @returns {{ title: string, body: string, labels: string[], groupKey: string, dependsOn: string[] }}
 *   `groupKey` and `dependsOn` are the caller's handle on the second pass:
 *   they name this Story and the groups it must follow, so the caller can map
 *   both onto issue numbers without re-deriving the grouping.
 */
export function buildStoryBody({ group, edges = [], issueByGroupKey = null }) {
  if (!group || !Array.isArray(group.findings)) {
    throw new Error('buildStoryBody: group with findings[] is required');
  }
  const title = group.title;
  const dependsOn = sequencingDepsForGroup(group, edges);

  // Build the canonical StoryBody object from the audit group data. The
  // acceptance + verify arrays are populated so the body clears the
  // inline-contract bar; changes[] carries the file footprint. `depends_on`
  // is empty on the first pass (the blockers have no issue numbers yet) and
  // carries real `#N` refs on the second — see dependencyRefs.
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

  // The `---` / `blocked by #N` footer is the canonical serializer's own, so
  // the body round-trips through `parse()` and `/mandrel-deliver`'s resolver reads the
  // ordering from the same place it reads every other Story's.
  const canonicalSections = serialize(storyBody, {
    includeFooter: storyBody.depends_on.length > 0,
  });

  // Append audit-specific extended sections (agent prompts, context links,
  // provenance footers) that are not part of the canonical shape.
  const body = [
    canonicalSections,
    '',
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
