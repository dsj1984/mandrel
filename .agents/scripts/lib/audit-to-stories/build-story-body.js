/**
 * lib/audit-to-stories/build-story-body.js
 *
 * Render the canonical Story body for the standalone grouping mode. The
 * body follows the contract spelled out in Story #2583 acceptance
 * criteria #8: Title (caller), Summary, Acceptance Criteria, Agent
 * Prompts, Context block, fingerprint footer.
 *
 * Pure: returns { title, body, labels }. Labels carry one canonical
 * `audit::<lens>` per distinct source report represented in the merge
 * (derived from each finding's `sourceReport` basename, NEVER from the
 * fine-grained `dimension` text — see Story #4195), plus the standard
 * `type::story`, `agent::ready`, and (when any finding is Critical)
 * `risk::high`.
 *
 * The body is serialized via the canonical story-body serializer
 * (`.agents/scripts/lib/story-body/story-body.js`) so the output is
 * parseable by `parse()` and round-trippable. Audit-specific content
 * (agent prompts, context links, fingerprint footer) is appended after
 * the canonical sections as extended markdown.
 */

import { serialize } from '../story-body/story-body.js';
import { auditLabelsForFindings } from './audit-lenses.js';
import { renderFingerprintFooter } from './finding-adapter.js';

const STATIC_LABELS = Object.freeze(['type::story', 'agent::ready']);

function uniq(items) {
  return [...new Set(items)];
}

function summaryFromGroup(group) {
  const lines = group.findings.map((f, idx) => {
    const sev = f.severity ? `[${f.severity.toUpperCase()}]` : '[—]';
    const dim = f.dimension ? `(${f.dimension})` : '';
    return `${idx + 1}. ${sev} ${dim} **${f.title}** — ${
      f.currentState || '_(no current-state captured)_'
    }`;
  });
  return lines.join('\n');
}

function goalFromGroup(group) {
  // Derive a concise goal statement from the group title + finding summary.
  const summary = summaryFromGroup(group);
  return `${group.title}\n\n${summary}`;
}

function acceptanceCriteriaFromGroup(group) {
  return group.findings.map((f) => {
    const rec = f.recommendation || '_(no recommendation captured)_';
    return `${f.title} — ${rec}`;
  });
}

function agentPromptsSection(group) {
  const blocks = group.findings
    .filter(
      (f) => typeof f.agentPrompt === 'string' && f.agentPrompt.length > 0,
    )
    .map((f) => `**${f.title}**\n\n\`\`\`\n${f.agentPrompt}\n\`\`\``);
  return blocks.join('\n\n') || '_(no copy-pasteable prompts captured)_';
}

function contextLinksFromGroup(group) {
  const reports = uniq(
    group.findings
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
 * @returns {{ title: string, body: string, labels: string[] }}
 */
export function buildStoryBody({ group }) {
  if (!group || !Array.isArray(group.findings)) {
    throw new Error('buildStoryBody: group with findings[] is required');
  }
  const title = group.title;

  // Build the canonical StoryBody object from the audit group data.
  const storyBody = {
    goal: goalFromGroup(group),
    changes: [],
    acceptance: acceptanceCriteriaFromGroup(group),
    verify: [],
    references: [],
    wide: null,
    depends_on: [],
    estimated_test_files: null,
  };

  // Serialize via the canonical serializer.
  const canonicalSections = serialize(storyBody);

  // Append audit-specific extended sections (agent prompts, context links,
  // fingerprint footer) that are not part of the canonical shape.
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
  ].join('\n');

  return { title, body, labels: labelsForGroup(group) };
}
