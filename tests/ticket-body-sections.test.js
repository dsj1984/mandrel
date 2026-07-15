/**
 * tests/ticket-body-sections.test.js — marker-delimited managed sections of
 * the Epic body (Story #4324).
 *
 * The section-scoped-writes guardrail lives here at the unit tier: every
 * helper must preserve, byte for byte, everything outside the managed
 * region it touches. The end-to-end sentinel oracles (spec persist +
 * acceptance reconciler leave an unrelated edit untouched) live in
 * `tests/epic-planner.test.js` and `tests/acceptance-spec-reconciler.test.js`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACCEPTANCE_TABLE_HEADING,
  extractTicketSection,
  hasTechSpecContent,
  hasTicketSection,
  sliceTicketBodyForDelivery,
  stripPlanningArtifactsSection,
  stripTicketSection,
  TICKET_BODY_SECTIONS,
  upsertTicketSection,
} from '../.agents/scripts/lib/ticket-body-sections.js';

const IDEATION_BODY = [
  '## Context',
  'Some context.',
  '',
  '## Goal',
  'A goal.',
  '',
  '## Acceptance Criteria',
  '- [ ] bullet one',
  '- [ ] bullet two',
].join('\n');

const TECH_SPEC = [
  '## Delivery Slicing',
  '| Slice | What ships | Independent? |',
  '| --- | --- | --- |',
  '| Foundation | core | Yes |',
].join('\n');

const ACCEPTANCE_TABLE = [
  ACCEPTANCE_TABLE_HEADING,
  '| AC ID | Outcome | Feature File | Scenario | Disposition |',
  '| --- | --- | --- | --- | --- |',
  '| AC-1 | Epic AC 1: it works | tests/features/x.feature | works | new |',
].join('\n');

describe('ticket-body-sections', () => {
  describe('upsertTicketSection', () => {
    it('appends a marker-delimited region when absent', () => {
      const out = upsertTicketSection(IDEATION_BODY, 'techSpec', TECH_SPEC);
      assert.ok(out.includes(TICKET_BODY_SECTIONS.techSpec.start));
      assert.ok(out.includes(TICKET_BODY_SECTIONS.techSpec.end));
      assert.equal(extractTicketSection(out, 'techSpec'), TECH_SPEC);
      // Everything before the appended region is byte-preserved.
      assert.ok(out.startsWith(IDEATION_BODY));
    });

    it('replaces only the region content on re-upsert (section-scoped write)', () => {
      const withSpec = upsertTicketSection(
        IDEATION_BODY,
        'techSpec',
        TECH_SPEC,
      );
      const withBoth = upsertTicketSection(
        withSpec,
        'acceptanceTable',
        ACCEPTANCE_TABLE,
      );
      // Sentinel: hand-edit the ideation Context section between writes.
      const sentinel = withBoth.replace(
        'Some context.',
        'Some context. SENTINEL-EDIT-42',
      );
      const rewritten = upsertTicketSection(
        sentinel,
        'techSpec',
        `${TECH_SPEC}\n| Transport | seam | No |`,
      );
      assert.ok(rewritten.includes('SENTINEL-EDIT-42'));
      assert.equal(
        extractTicketSection(rewritten, 'acceptanceTable'),
        ACCEPTANCE_TABLE,
      );
      assert.ok(
        extractTicketSection(rewritten, 'techSpec').includes('Transport'),
      );
    });

    it('keeps canonical order: techSpec inserts before an existing acceptanceTable', () => {
      const acceptanceFirst = upsertTicketSection(
        IDEATION_BODY,
        'acceptanceTable',
        ACCEPTANCE_TABLE,
      );
      const out = upsertTicketSection(acceptanceFirst, 'techSpec', TECH_SPEC);
      assert.ok(
        out.indexOf(TICKET_BODY_SECTIONS.techSpec.start) <
          out.indexOf(TICKET_BODY_SECTIONS.acceptanceTable.start),
      );
      assert.equal(
        extractTicketSection(out, 'acceptanceTable'),
        ACCEPTANCE_TABLE,
      );
    });

    it('is idempotent: same content twice yields the same body', () => {
      const once = upsertTicketSection(IDEATION_BODY, 'techSpec', TECH_SPEC);
      const twice = upsertTicketSection(once, 'techSpec', TECH_SPEC);
      assert.equal(twice, once);
    });
  });

  describe('extract / has / strip', () => {
    it('extractTicketSection returns null when absent', () => {
      assert.equal(extractTicketSection(IDEATION_BODY, 'techSpec'), null);
      assert.equal(extractTicketSection('', 'acceptanceTable'), null);
    });

    it('hasTicketSection detects only well-formed regions', () => {
      const out = upsertTicketSection(
        IDEATION_BODY,
        'acceptanceTable',
        ACCEPTANCE_TABLE,
      );
      assert.equal(hasTicketSection(out, 'acceptanceTable'), true);
      assert.equal(hasTicketSection(out, 'techSpec'), false);
      // Orphaned start marker (no end) is treated as absent.
      const malformed = `${IDEATION_BODY}\n${TICKET_BODY_SECTIONS.techSpec.start}\ndangling`;
      assert.equal(hasTicketSection(malformed, 'techSpec'), false);
    });

    it('stripTicketSection removes the region and preserves the rest', () => {
      const withBoth = upsertTicketSection(
        upsertTicketSection(IDEATION_BODY, 'techSpec', TECH_SPEC),
        'acceptanceTable',
        ACCEPTANCE_TABLE,
      );
      const stripped = stripTicketSection(withBoth, 'acceptanceTable');
      assert.equal(hasTicketSection(stripped, 'acceptanceTable'), false);
      assert.equal(extractTicketSection(stripped, 'techSpec'), TECH_SPEC);
      assert.ok(stripped.includes('- [ ] bullet two'));
      // No-op when absent.
      assert.equal(
        stripTicketSection(IDEATION_BODY, 'techSpec'),
        IDEATION_BODY,
      );
    });

    it('throws on an unknown section kind', () => {
      assert.throws(
        () => extractTicketSection(IDEATION_BODY, 'prd'),
        /unknown section kind/,
      );
    });
  });

  describe('hasTechSpecContent', () => {
    it('detects the managed region and a bare Delivery Slicing heading', () => {
      assert.equal(hasTechSpecContent(IDEATION_BODY), false);
      assert.equal(
        hasTechSpecContent(
          upsertTicketSection(IDEATION_BODY, 'techSpec', TECH_SPEC),
        ),
        true,
      );
      assert.equal(
        hasTechSpecContent(`${IDEATION_BODY}\n\n## Delivery Slicing\ntable`),
        true,
      );
    });
  });

  describe('stripPlanningArtifactsSection', () => {
    it('removes the retired checklist and keeps neighbouring sections', () => {
      const legacy = [
        IDEATION_BODY,
        '',
        '## Planning Artifacts',
        '- [ ] Tech Spec: #4001',
        '- [ ] Acceptance Spec: #4002',
        '',
        '## Notes',
        'keep me',
      ].join('\n');
      const out = stripPlanningArtifactsSection(legacy);
      assert.ok(!out.includes('Planning Artifacts'));
      assert.ok(!out.includes('#4001'));
      assert.ok(out.includes('## Notes'));
      assert.ok(out.includes('keep me'));
      assert.ok(out.includes('- [ ] bullet one'));
    });

    it('stops at a managed-region marker boundary', () => {
      const withSpec = upsertTicketSection(
        `${IDEATION_BODY}\n\n## Planning Artifacts\n- [ ] Tech Spec: #4001`,
        'techSpec',
        TECH_SPEC,
      );
      const out = stripPlanningArtifactsSection(withSpec);
      assert.ok(!out.includes('#4001'));
      assert.equal(extractTicketSection(out, 'techSpec'), TECH_SPEC);
    });

    it('passes bodies without the section through untouched', () => {
      assert.equal(stripPlanningArtifactsSection(IDEATION_BODY), IDEATION_BODY);
      assert.equal(stripPlanningArtifactsSection(''), '');
    });
  });

  describe('sliceTicketBodyForDelivery', () => {
    // A full Epic body with the keep/drop matrix, the techSpec managed
    // region (inner ## Delivery Slicing heading), the acceptanceTable
    // managed region, and an unknown operator-authored section.
    const FULL_BODY = [
      'Epic #1 — Deliver the widget',
      '',
      '## Context',
      'Ideation context that a story agent never acts on.',
      '',
      '## Goal',
      'Ship the widget.',
      '',
      '## Non-Goals',
      'Not the gadget.',
      '',
      '## Scope',
      'Only the widget module.',
      '',
      '## User Stories',
      '- As a user I want a widget.',
      '',
      '## Acceptance Criteria',
      '- [ ] widget renders',
      '',
      '## Operator Notes',
      'Hand-authored content that must survive.',
      '',
      TICKET_BODY_SECTIONS.techSpec.start,
      '',
      '## Delivery Slicing',
      '| Slice | What ships | Independent? |',
      '| --- | --- | --- |',
      '| S1 | the widget | yes |',
      '',
      TICKET_BODY_SECTIONS.techSpec.end,
      '',
      TICKET_BODY_SECTIONS.acceptanceTable.start,
      '',
      ACCEPTANCE_TABLE,
      '',
      TICKET_BODY_SECTIONS.acceptanceTable.end,
    ].join('\n');

    it('keeps title/Goal/Non-Goals/User Stories and drops Context/Scope/Acceptance Criteria', () => {
      const out = sliceTicketBodyForDelivery(FULL_BODY);
      // KEEP
      assert.ok(out.includes('Epic #1 — Deliver the widget'));
      assert.ok(out.includes('## Goal'));
      assert.ok(out.includes('Ship the widget.'));
      assert.ok(out.includes('## Non-Goals'));
      assert.ok(out.includes('Not the gadget.'));
      assert.ok(out.includes('## User Stories'));
      assert.ok(out.includes('As a user I want a widget.'));
      // DROP
      assert.ok(!out.includes('## Context'));
      assert.ok(!out.includes('Ideation context'));
      assert.ok(!out.includes('## Scope'));
      assert.ok(!out.includes('Only the widget module.'));
      assert.ok(!out.includes('## Acceptance Criteria'));
      assert.ok(!out.includes('widget renders'));
    });

    it('keeps the techSpec managed region (inner Delivery Slicing heading) and drops the acceptanceTable region', () => {
      const out = sliceTicketBodyForDelivery(FULL_BODY);
      assert.ok(out.includes('## Delivery Slicing'));
      assert.ok(out.includes('| S1 | the widget | yes |'));
      // acceptanceTable region and its AC-ID rows are gone.
      assert.ok(!out.includes('## Acceptance Table'));
      assert.ok(!/\|\s*AC-\d+\s*\|/.test(out));
    });

    it('preserves unknown / operator-authored sections (fail-open)', () => {
      const out = sliceTicketBodyForDelivery(FULL_BODY);
      assert.ok(out.includes('## Operator Notes'));
      assert.ok(out.includes('Hand-authored content that must survive.'));
    });

    it('handles a body with no managed regions (plain heading slice only)', () => {
      const plain = [
        '## Goal',
        'do it',
        '',
        '## Context',
        'drop me',
        '',
        '## User Stories',
        '- story',
      ].join('\n');
      const out = sliceTicketBodyForDelivery(plain);
      assert.ok(out.includes('## Goal'));
      assert.ok(out.includes('## User Stories'));
      assert.ok(!out.includes('## Context'));
      assert.ok(!out.includes('drop me'));
    });

    it('returns empty string for empty / non-string input', () => {
      assert.equal(sliceTicketBodyForDelivery(''), '');
      assert.equal(sliceTicketBodyForDelivery(null), '');
      assert.equal(sliceTicketBodyForDelivery(undefined), '');
    });
  });
});
