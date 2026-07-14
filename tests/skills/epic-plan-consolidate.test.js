/**
 * Smoke + contract spec for the `epic-plan-consolidate` Skill (Story #3797).
 *
 * The consolidation pass is the holistic, pre-persist critic added to
 * `/plan` Phase 8 (sub-step 8.3). These specs pin the Skill's
 * front-matter contract and assert its body documents:
 *   - the scope-preserving operation set (merge Stories / rewire depends_on)
 *     and the MUST-NOT-add-scope invariant,
 *   - graceful degradation when the Tech Spec "Delivery Slicing" section is
 *     absent,
 *   - the HITL diff gate before persist.
 *
 * The host LLM is not invoked here — the smoke spec proves the contract
 * surface, not the consolidation output. A separate unit spec below proves
 * scope conservation against a synthetic over-fragmented draft using a pure
 * helper so the invariant is machine-checked, not just documented.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runSkillSmoke } from './_harness/run-skill-smoke.js';

describe('skill:epic-plan-consolidate — smoke', () => {
  it('declares name, description, and allowed_tools', async () => {
    const result = await runSkillSmoke({
      skillName: 'epic-plan-consolidate',
      expectedTools: ['Read', 'Write'],
    });
    assert.equal(
      result.pass,
      true,
      `Skill failed front-matter contract: ${result.errors.join('; ')}`,
    );
    assert.equal(result.skill.name, 'epic-plan-consolidate');
  });

  it('documents the consolidation contract in the Skill body', async () => {
    const result = await runSkillSmoke({
      skillName: 'epic-plan-consolidate',
      validator: async ({ body }) => {
        const errors = [];

        // Reads the draft tickets.json and writes a consolidated one + report.
        if (!/temp\/run-<Epic_ID>\/tickets\.json/.test(body)) {
          errors.push(
            'Skill body must reference the temp/run-<Epic_ID>/tickets.json artifact',
          );
        }
        if (!/consolidation-report\.md/.test(body)) {
          errors.push(
            'Skill body must emit a human-readable consolidation-report.md (HITL diff)',
          );
        }

        // The two permitted, scope-preserving operations.
        for (const op of [/merge .*Stories/i, /rewire .*depends_on/i]) {
          if (!op.test(body)) {
            errors.push(
              `Skill body must document the operation matching ${op}`,
            );
          }
        }

        // Scope conservation is the load-bearing invariant.
        if (!/MUST NOT add scope|never add scope|not add scope/i.test(body)) {
          errors.push(
            'Skill body must state it MUST NOT add scope or invent tickets',
          );
        }
        if (!/scope conservation|conserve scope|conserving scope/i.test(body)) {
          errors.push('Skill body must name the scope-conservation invariant');
        }

        // Missing reason-to-exist cohesion check (Story #4164). The critic
        // must document that it flags any Story whose body carries no
        // non-empty "reason to exist" meta field.
        if (!/reason[_ ]to[_ ]exist|reason to exist/i.test(body)) {
          errors.push(
            'Skill body must document the reason_to_exist cohesion field',
          );
        }
        if (
          !/(flag|check)[^.]*\breason[_ ]to[_ ]exist|\breason to exist[^.]*\b(flag|check|missing|no\b|non-empty)/i.test(
            body,
          )
        ) {
          errors.push(
            'Skill body must document a check that flags Stories missing a non-empty reason to exist',
          );
        }

        // Delivery Slicing ceiling + graceful degradation.
        if (!/Delivery Slicing/.test(body)) {
          errors.push(
            'Skill body must consume the Tech Spec "Delivery Slicing" section as the grouping ceiling',
          );
        }
        if (!/degrade gracefully|graceful(ly)?[- ]degrade|absent/i.test(body)) {
          errors.push(
            'Skill body must degrade gracefully when Delivery Slicing is absent',
          );
        }
        // Story #4311 — the Delivery Slicing count is a CEILING, not a target:
        // the consolidator may merge below it but never splits above it.
        if (!/ceiling/i.test(body)) {
          errors.push(
            'Skill body must describe the Delivery Slicing count as a ceiling (Story #4311)',
          );
        }
        if (!/never split(s)? above/i.test(body)) {
          errors.push(
            'Skill body must state the consolidator never splits above the ceiling (Story #4311)',
          );
        }
        // Story #4311 — a below-ceiling merge must be surfaced in the report
        // with a one-line rationale so the operator sees the coarsening.
        if (
          !/below[- ]ceiling|below the (Delivery-Slicing )?ceiling/i.test(body)
        ) {
          errors.push(
            'Skill body report format must surface below-ceiling merges (Story #4311)',
          );
        }

        // Separate critic pass with fresh context (not self-review).
        if (!/critic/i.test(body)) {
          errors.push(
            'Skill body must frame the pass as a critic separate from the generator',
          );
        }

        // HITL diff gate before persist.
        if (!/HITL|operator (review|approv)/i.test(body)) {
          errors.push('Skill body must require an operator HITL diff gate');
        }

        // The deterministic validator stays as the backstop.
        if (!/ticket-validator/.test(body)) {
          errors.push(
            'Skill body must name the ticket validator as the post-consolidation backstop',
          );
        }

        return { ok: errors.length === 0, errors };
      },
    });
    assert.equal(
      result.pass,
      true,
      `validator failed: ${result.errors.join('; ')}`,
    );
  });
});

/**
 * Scope-conservation invariant — documented against a pure model, NOT the
 * Skill's runtime output.
 *
 * The consolidation pass merges/collapses Stories but MUST NOT add or drop
 * scope: the union of every acceptance item and every verify entry across the
 * draft must equal the union across the consolidated array. This test models
 * the scope-preserving merge as a pure helper and asserts the union is
 * conserved on an over-fragmented fixture — it documents *what the intended
 * merge looks like*, but it does **not** inspect the host LLM's actual output.
 * There is no runtime acceptance-union diff on the critic's result (see
 * Story #3910 and the Skill's Policy Capsule): scope conservation is the
 * critic's deliberate contract, not a machine-enforced guarantee.
 */
describe('epic-plan-consolidate — scope conservation', () => {
  /**
   * Pure model of the scope-preserving merge: fold `sourceSlugs` Stories into
   * `targetSlug`, unioning their acceptance / verify / changes. Mirrors the
   * Skill's permitted "merge Stories" operation. Returns the consolidated
   * array.
   */
  function mergeStories(draft, targetSlug, sourceSlugs) {
    const sources = new Set(sourceSlugs);
    const target = draft.find((t) => t.slug === targetSlug);
    if (!target) throw new Error(`target slug ${targetSlug} not in draft`);
    const union = (a, b) => [...new Set([...(a ?? []), ...(b ?? [])])];
    for (const slug of sourceSlugs) {
      const src = draft.find((t) => t.slug === slug);
      if (!src) throw new Error(`source slug ${slug} not in draft`);
      target.acceptance = union(target.acceptance, src.acceptance);
      target.verify = union(target.verify, src.verify);
    }
    return draft
      .filter((t) => !sources.has(t.slug))
      .map((t) => ({
        ...t,
        // rewire depends_on: re-point edges naming a merged slug at the target,
        // drop self-edges, dedupe.
        depends_on: [
          ...new Set(
            (t.depends_on ?? [])
              .map((d) => (sources.has(d) ? targetSlug : d))
              .filter((d) => d !== t.slug),
          ),
        ],
      }));
  }

  const scopeUnion = (arr, field) =>
    new Set(arr.flatMap((t) => t[field] ?? []));

  it('conserves the union of acceptance + verify when merging over-fragmented Stories', () => {
    // Arrange — an over-fragmented 2-tier draft: three sibling atomic
    // Stories (chained via depends_on) that map to one coherent capability.
    const draft = [
      {
        slug: 'a-1',
        type: 'story',
        acceptance: ['ac-1'],
        verify: ['v-1 (unit)'],
        depends_on: [],
      },
      {
        slug: 'a-2',
        type: 'story',
        acceptance: ['ac-2'],
        verify: ['v-2 (unit)'],
        depends_on: ['a-1'],
      },
      {
        slug: 'a-3',
        type: 'story',
        acceptance: ['ac-3'],
        verify: ['v-3 (unit)'],
        depends_on: ['a-2'],
      },
    ];
    const beforeAcceptance = scopeUnion(draft, 'acceptance');
    const beforeVerify = scopeUnion(draft, 'verify');

    // Act — merge a-2 and a-3 into a-1 (the cohesive capability Story).
    const consolidated = mergeStories(draft, 'a-1', ['a-2', 'a-3']);

    // Assert — scope conserved: same acceptance + verify union, fewer Stories.
    const afterAcceptance = scopeUnion(consolidated, 'acceptance');
    const afterVerify = scopeUnion(consolidated, 'verify');
    assert.deepEqual([...afterAcceptance].sort(), [...beforeAcceptance].sort());
    assert.deepEqual([...afterVerify].sort(), [...beforeVerify].sort());

    const storyCount = consolidated.filter((t) => t.type === 'story').length;
    assert.equal(storyCount, 1, 'three Stories collapse into one');

    // No depends_on references a slug absent from the consolidated array, and
    // no self-edges survive.
    const slugs = new Set(consolidated.map((t) => t.slug));
    for (const t of consolidated) {
      for (const dep of t.depends_on ?? []) {
        assert.ok(slugs.has(dep), `dangling depends_on ${dep}`);
        assert.notEqual(dep, t.slug, 'self-edge survived');
      }
    }
  });

  it('does not invent acceptance items that were absent from the draft', () => {
    // Arrange
    const draft = [
      {
        slug: 'b-1',
        type: 'story',
        acceptance: ['only-ac'],
        verify: ['only-v (unit)'],
        depends_on: [],
      },
      {
        slug: 'b-2',
        type: 'story',
        acceptance: ['only-ac'],
        verify: ['only-v (unit)'],
        depends_on: [],
      },
    ];

    // Act — merging duplicates must not grow the union.
    const consolidated = mergeStories(draft, 'b-1', ['b-2']);

    // Assert — union is exactly the draft's union, nothing invented.
    assert.deepEqual([...scopeUnion(consolidated, 'acceptance')], ['only-ac']);
    assert.deepEqual(
      [...scopeUnion(consolidated, 'verify')],
      ['only-v (unit)'],
    );
  });
});
