import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  ACCEPTANCE_LABELS,
  ACCEPTANCE_NA,
  AGENT_LABELS,
  CONTEXT_ACCEPTANCE_SPEC,
  CONTEXT_LABELS,
  isValidTransition,
  LABEL_COLORS,
  META_LABELS,
  PLANNING_HEALTHCHECK_WAIVED,
  PLANNING_LABELS,
  VALID_TRANSITIONS,
} from '../../.agents/scripts/lib/label-constants.js';

// ── Story #2554 — meta-axis labels for retrospective signal routing ─────
test('META_LABELS.FRAMEWORK_GAP equals "meta::framework-gap"', () => {
  assert.equal(META_LABELS.FRAMEWORK_GAP, 'meta::framework-gap');
});

test('META_LABELS.CONSUMER_IMPROVEMENT equals "meta::consumer-improvement"', () => {
  assert.equal(META_LABELS.CONSUMER_IMPROVEMENT, 'meta::consumer-improvement');
});

test('CONTEXT_LABELS.ACCEPTANCE_SPEC equals "context::acceptance-spec"', () => {
  assert.equal(CONTEXT_LABELS.ACCEPTANCE_SPEC, 'context::acceptance-spec');
});

test('CONTEXT_ACCEPTANCE_SPEC named export mirrors CONTEXT_LABELS.ACCEPTANCE_SPEC', () => {
  assert.equal(CONTEXT_ACCEPTANCE_SPEC, 'context::acceptance-spec');
  assert.equal(CONTEXT_ACCEPTANCE_SPEC, CONTEXT_LABELS.ACCEPTANCE_SPEC);
});

test('ACCEPTANCE_LABELS.N_A equals "acceptance::n-a"', () => {
  assert.equal(ACCEPTANCE_LABELS.N_A, 'acceptance::n-a');
});

test('ACCEPTANCE_NA named export mirrors ACCEPTANCE_LABELS.N_A', () => {
  assert.equal(ACCEPTANCE_NA, 'acceptance::n-a');
  assert.equal(ACCEPTANCE_NA, ACCEPTANCE_LABELS.N_A);
});

test('existing CONTEXT_LABELS entries are still exposed', () => {
  assert.equal(CONTEXT_LABELS.PRD, 'context::prd');
  assert.equal(CONTEXT_LABELS.TECH_SPEC, 'context::tech-spec');
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
  assert.equal(
    PLANNING_HEALTHCHECK_WAIVED,
    PLANNING_LABELS.HEALTHCHECK_WAIVED,
  );
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
