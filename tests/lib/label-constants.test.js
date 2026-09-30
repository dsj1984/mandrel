import { strict as assert } from 'node:assert';
import test from 'node:test';

import { AUDIT_LABEL_TAXONOMY } from '../../.agents/scripts/lib/audit-to-stories/audit-label-taxonomy.js';
import * as labelConstants from '../../.agents/scripts/lib/label-constants.js';
import {
  ACCEPTANCE_LABELS,
  ACCEPTANCE_NA,
  AGENT_LABELS,
  isValidTransition,
  LABEL_COLORS,
  META_LABELS,
  PLANNING_HEALTHCHECK_WAIVED,
  PLANNING_LABELS,
  VALID_TRANSITIONS,
} from '../../.agents/scripts/lib/label-constants.js';
import { LABEL_TAXONOMY } from '../../.agents/scripts/lib/label-taxonomy.js';

// GitHub's published cap on a label description — an external API
// constraint, pinned as a literal so the assertion is independent of ours.
const LABEL_DESCRIPTION_MAX_LENGTH = 100;

// ── Story #2554 — meta-axis labels for retrospective signal routing ─────
test('META_LABELS.FRAMEWORK_GAP equals "meta::framework-gap"', () => {
  assert.equal(META_LABELS.FRAMEWORK_GAP, 'meta::framework-gap');
});

test('META_LABELS.CONSUMER_IMPROVEMENT equals "meta::consumer-improvement"', () => {
  assert.equal(META_LABELS.CONSUMER_IMPROVEMENT, 'meta::consumer-improvement');
});

// ── Story #4324 — context-ticket label classes retired (hard cutover) ───
test('context label exports are gone (Story #4324 hard cutover)', () => {
  assert.equal(labelConstants.CONTEXT_LABELS, undefined);
  assert.equal(labelConstants.CONTEXT_ACCEPTANCE_SPEC, undefined);
  assert.equal(LABEL_COLORS.CONTEXT, undefined);
});

test('ACCEPTANCE_LABELS.N_A equals "acceptance::n-a"', () => {
  assert.equal(ACCEPTANCE_LABELS.N_A, 'acceptance::n-a');
});

test('ACCEPTANCE_NA named export mirrors ACCEPTANCE_LABELS.N_A', () => {
  assert.equal(ACCEPTANCE_NA, 'acceptance::n-a');
  assert.equal(ACCEPTANCE_NA, ACCEPTANCE_LABELS.N_A);
});

// ── Story #2921 — planning-axis label for healthcheck waiver (F7) ────────
test('PLANNING_LABELS.HEALTHCHECK_WAIVED equals "planning::healthcheck-waived"', () => {
  assert.equal(
    PLANNING_LABELS.HEALTHCHECK_WAIVED,
    'planning::healthcheck-waived',
  );
});

test('PLANNING_HEALTHCHECK_WAIVED named export mirrors PLANNING_LABELS.HEALTHCHECK_WAIVED', () => {
  assert.equal(PLANNING_HEALTHCHECK_WAIVED, 'planning::healthcheck-waived');
  assert.equal(PLANNING_HEALTHCHECK_WAIVED, PLANNING_LABELS.HEALTHCHECK_WAIVED);
});

test('AJV settings schema accepts planning::healthcheck-waived in every planning-label enum', async () => {
  // AC #2 of Story #2921 Task #2933: "AJV schema accepts
  // 'planning::healthcheck-waived' wherever a planning label is
  // enumerated." Walk the runtime AJV schema and assert that any enum
  // whose values are planning labels (i.e. all values match
  // /^planning::/) includes the new constant. When no such enum exists
  // yet the assertion is trivially true; the test guards against a
  // future enum forgetting to extend with the canonical label.
  const schemaModule = await import(
    '../../.agents/scripts/lib/config-settings-schema.js'
  );
  const root =
    schemaModule.AGENTRC_SCHEMA ??
    schemaModule.default ??
    schemaModule.SETTINGS_SCHEMA;
  assert.ok(root, 'config-settings-schema did not export a schema root');
  const offenders = [];
  const walk = (node, pathParts) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.enum)) {
      const allPlanning =
        node.enum.length > 0 &&
        node.enum.every(
          (v) => typeof v === 'string' && v.startsWith('planning::'),
        );
      if (allPlanning && !node.enum.includes(PLANNING_HEALTHCHECK_WAIVED)) {
        offenders.push(pathParts.join('.'));
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'enum') continue;
      walk(child, [...pathParts, key]);
    }
  };
  walk(root, ['$root']);
  assert.deepEqual(
    offenders,
    [],
    `planning-label enum(s) missing PLANNING_HEALTHCHECK_WAIVED: ${offenders.join(', ')}`,
  );
});

test('LABEL_COLORS includes a dedicated PLANNING swatch', () => {
  assert.ok(
    typeof LABEL_COLORS.PLANNING === 'string' &&
      /^#[0-9A-Fa-f]{6}$/.test(LABEL_COLORS.PLANNING),
    `expected hex color for LABEL_COLORS.PLANNING, got ${LABEL_COLORS.PLANNING}`,
  );
});

test('LABEL_COLORS includes a dedicated ACCEPTANCE swatch', () => {
  assert.ok(
    typeof LABEL_COLORS.ACCEPTANCE === 'string' &&
      /^#[0-9A-Fa-f]{6}$/.test(LABEL_COLORS.ACCEPTANCE),
    `expected hex color for LABEL_COLORS.ACCEPTANCE, got ${LABEL_COLORS.ACCEPTANCE}`,
  );
});

// ── Story #2144 — agent::closing state machine ────────────────────────────

test('AGENT_LABELS.CLOSING equals "agent::closing"', () => {
  assert.equal(AGENT_LABELS.CLOSING, 'agent::closing');
});

test('VALID_TRANSITIONS permits executing → closing → done', () => {
  assert.ok(
    VALID_TRANSITIONS[AGENT_LABELS.EXECUTING].includes(AGENT_LABELS.CLOSING),
  );
  assert.ok(
    VALID_TRANSITIONS[AGENT_LABELS.CLOSING].includes(AGENT_LABELS.DONE),
  );
});

test('VALID_TRANSITIONS permits closing → blocked', () => {
  assert.ok(
    VALID_TRANSITIONS[AGENT_LABELS.CLOSING].includes(AGENT_LABELS.BLOCKED),
  );
});

test('isValidTransition allows executing → closing and closing → done', () => {
  assert.equal(
    isValidTransition(AGENT_LABELS.EXECUTING, AGENT_LABELS.CLOSING),
    true,
  );
  assert.equal(
    isValidTransition(AGENT_LABELS.CLOSING, AGENT_LABELS.DONE),
    true,
  );
});

test('isValidTransition rejects closing → executing (no backward escape)', () => {
  assert.equal(
    isValidTransition(AGENT_LABELS.CLOSING, AGENT_LABELS.EXECUTING),
    false,
  );
});

test('isValidTransition rejects closing → ready (must advance, not restart)', () => {
  assert.equal(
    isValidTransition(AGENT_LABELS.CLOSING, AGENT_LABELS.READY),
    false,
  );
});

test('isValidTransition rejects self-transitions', () => {
  assert.equal(
    isValidTransition(AGENT_LABELS.EXECUTING, AGENT_LABELS.EXECUTING),
    false,
  );
  assert.equal(
    isValidTransition(AGENT_LABELS.CLOSING, AGENT_LABELS.CLOSING),
    false,
  );
});

test('isValidTransition still allows the legacy executing → done path for Tasks (no regression)', () => {
  // Tasks never route through `agent::closing` — story-close fires at the
  // Story level only. The validator must continue to recognise the direct
  // `executing → done` edge so per-Task closes from `story-task-progress.js`
  // are not falsely rejected.
  assert.equal(
    isValidTransition(AGENT_LABELS.EXECUTING, AGENT_LABELS.DONE),
    true,
  );
});

test('isValidTransition still allows executing → blocked', () => {
  assert.equal(
    isValidTransition(AGENT_LABELS.EXECUTING, AGENT_LABELS.BLOCKED),
    true,
  );
});

test('isValidTransition rejects unknown source states', () => {
  assert.equal(isValidTransition('agent::unknown', AGENT_LABELS.DONE), false);
});

test('isValidTransition treats null fromState as initial entry and accepts any known label', () => {
  assert.equal(isValidTransition(null, AGENT_LABELS.EXECUTING), true);
  assert.equal(isValidTransition(undefined, AGENT_LABELS.CLOSING), true);
  assert.equal(isValidTransition(null, 'agent::bogus'), false);
});

test('done is terminal — no outbound transitions', () => {
  assert.deepEqual(VALID_TRANSITIONS[AGENT_LABELS.DONE], []);
  assert.equal(
    isValidTransition(AGENT_LABELS.DONE, AGENT_LABELS.EXECUTING),
    false,
  );
});

// ── Story #5201 — GitHub's label-description cap ────────────────────────
test('every shipped label description fits inside the cap', () => {
  // A description over the cap is not truncated — the create fails outright
  // with an HTTP 422, and `gh` reports it as a bare exit 1. Two ad-hoc
  // plan-persist descriptions shipped that way for the life of the cohort
  // label; this asserts the static taxonomies never join them.
  const rows = [
    ...LABEL_TAXONOMY.map((row) => ['LABEL_TAXONOMY', row]),
    ...AUDIT_LABEL_TAXONOMY.map((row) => ['AUDIT_LABEL_TAXONOMY', row]),
  ];
  assert.ok(rows.length > 0, 'the taxonomies are non-empty');
  for (const [source, row] of rows) {
    const length = (row.description ?? '').length;
    assert.ok(
      length <= LABEL_DESCRIPTION_MAX_LENGTH,
      `${source} row "${row.name}" description is ${length} characters, over ` +
        `the ${LABEL_DESCRIPTION_MAX_LENGTH} cap`,
    );
  }
});

// ── Story #5517 — one description per label, matching its runtime meaning ──
test('a label both taxonomies create carries the repo-wide description', () => {
  const repoWide = new Map(LABEL_TAXONOMY.map((row) => [row.name, row]));
  const shared = AUDIT_LABEL_TAXONOMY.filter((row) =>
    row.name.startsWith('agent::'),
  );
  assert.ok(shared.length > 0, 'the audit taxonomy creates an agent:: label');
  for (const row of shared) {
    assert.equal(row.description, repoWide.get(row.name)?.description);
  }
});

test('agent::review-spec and agent::ready describe planning, not a manifest', () => {
  const byName = new Map(LABEL_TAXONOMY.map((row) => [row.name, row]));
  assert.match(
    byName.get('agent::review-spec').description,
    /awaiting planning before delivery/,
  );
  for (const row of [...LABEL_TAXONOMY, ...AUDIT_LABEL_TAXONOMY]) {
    assert.doesNotMatch(row.description ?? '', /manifest/i, row.name);
  }
});
