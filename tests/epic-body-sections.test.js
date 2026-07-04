/**
 * tests/epic-body-sections.test.js — marker-delimited managed sections of
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
  EPIC_BODY_SECTIONS,
  extractEpicSection,
  hasEpicSection,
  hasTechSpecContent,
  stripEpicSection,
  stripPlanningArtifactsSection,
  upsertEpicSection,
} from '../.agents/scripts/lib/epic-body-sections.js';

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

describe('epic-body-sections', () => {
  describe('upsertEpicSection', () => {
    it('appends a marker-delimited region when absent', () => {
      const out = upsertEpicSection(IDEATION_BODY, 'techSpec', TECH_SPEC);
      assert.ok(out.includes(EPIC_BODY_SECTIONS.techSpec.start));
      assert.ok(out.includes(EPIC_BODY_SECTIONS.techSpec.end));
      assert.equal(extractEpicSection(out, 'techSpec'), TECH_SPEC);
      // Everything before the appended region is byte-preserved.
      assert.ok(out.startsWith(IDEATION_BODY));
    });

    it('replaces only the region content on re-upsert (section-scoped write)', () => {
      const withSpec = upsertEpicSection(IDEATION_BODY, 'techSpec', TECH_SPEC);
      const withBoth = upsertEpicSection(
        withSpec,
        'acceptanceTable',
        ACCEPTANCE_TABLE,
      );
      // Sentinel: hand-edit the ideation Context section between writes.
      const sentinel = withBoth.replace(
        'Some context.',
        'Some context. SENTINEL-EDIT-42',
      );
      const rewritten = upsertEpicSection(
        sentinel,
        'techSpec',
        `${TECH_SPEC}\n| Transport | seam | No |`,
      );
      assert.ok(rewritten.includes('SENTINEL-EDIT-42'));
      assert.equal(
        extractEpicSection(rewritten, 'acceptanceTable'),
        ACCEPTANCE_TABLE,
      );
      assert.ok(
        extractEpicSection(rewritten, 'techSpec').includes('Transport'),
      );
    });

    it('keeps canonical order: techSpec inserts before an existing acceptanceTable', () => {
      const acceptanceFirst = upsertEpicSection(
        IDEATION_BODY,
        'acceptanceTable',
        ACCEPTANCE_TABLE,
      );
      const out = upsertEpicSection(acceptanceFirst, 'techSpec', TECH_SPEC);
      assert.ok(
        out.indexOf(EPIC_BODY_SECTIONS.techSpec.start) <
          out.indexOf(EPIC_BODY_SECTIONS.acceptanceTable.start),
      );
      assert.equal(
        extractEpicSection(out, 'acceptanceTable'),
        ACCEPTANCE_TABLE,
      );
    });

    it('is idempotent: same content twice yields the same body', () => {
      const once = upsertEpicSection(IDEATION_BODY, 'techSpec', TECH_SPEC);
      const twice = upsertEpicSection(once, 'techSpec', TECH_SPEC);
      assert.equal(twice, once);
    });
  });

  describe('extract / has / strip', () => {
    it('extractEpicSection returns null when absent', () => {
      assert.equal(extractEpicSection(IDEATION_BODY, 'techSpec'), null);
      assert.equal(extractEpicSection('', 'acceptanceTable'), null);
    });

    it('hasEpicSection detects only well-formed regions', () => {
      const out = upsertEpicSection(
        IDEATION_BODY,
        'acceptanceTable',
        ACCEPTANCE_TABLE,
      );
      assert.equal(hasEpicSection(out, 'acceptanceTable'), true);
      assert.equal(hasEpicSection(out, 'techSpec'), false);
      // Orphaned start marker (no end) is treated as absent.
      const malformed = `${IDEATION_BODY}\n${EPIC_BODY_SECTIONS.techSpec.start}\ndangling`;
      assert.equal(hasEpicSection(malformed, 'techSpec'), false);
    });

    it('stripEpicSection removes the region and preserves the rest', () => {
      const withBoth = upsertEpicSection(
        upsertEpicSection(IDEATION_BODY, 'techSpec', TECH_SPEC),
        'acceptanceTable',
        ACCEPTANCE_TABLE,
      );
      const stripped = stripEpicSection(withBoth, 'acceptanceTable');
      assert.equal(hasEpicSection(stripped, 'acceptanceTable'), false);
      assert.equal(extractEpicSection(stripped, 'techSpec'), TECH_SPEC);
      assert.ok(stripped.includes('- [ ] bullet two'));
      // No-op when absent.
      assert.equal(stripEpicSection(IDEATION_BODY, 'techSpec'), IDEATION_BODY);
    });

    it('throws on an unknown section kind', () => {
      assert.throws(
        () => extractEpicSection(IDEATION_BODY, 'prd'),
        /unknown section kind/,
      );
    });
  });

  describe('hasTechSpecContent', () => {
    it('detects the managed region and a bare Delivery Slicing heading', () => {
      assert.equal(hasTechSpecContent(IDEATION_BODY), false);
      assert.equal(
        hasTechSpecContent(
          upsertEpicSection(IDEATION_BODY, 'techSpec', TECH_SPEC),
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
      const withSpec = upsertEpicSection(
        `${IDEATION_BODY}\n\n## Planning Artifacts\n- [ ] Tech Spec: #4001`,
        'techSpec',
        TECH_SPEC,
      );
      const out = stripPlanningArtifactsSection(withSpec);
      assert.ok(!out.includes('#4001'));
      assert.equal(extractEpicSection(out, 'techSpec'), TECH_SPEC);
    });

    it('passes bodies without the section through untouched', () => {
      assert.equal(stripPlanningArtifactsSection(IDEATION_BODY), IDEATION_BODY);
      assert.equal(stripPlanningArtifactsSection(''), '');
    });
  });
});
