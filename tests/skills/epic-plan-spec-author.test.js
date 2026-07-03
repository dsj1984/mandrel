/**
 * Smoke spec for the `epic-plan-spec-author` Skill
 * (Epic #1181 / Story #1441 / Task #1455).
 *
 * The validator runs against a fixture planner-context.json. It pins the
 * Skill's allowed_tools list (Read, Write, Bash) and asserts the Skill
 * body references the two output artifacts the persist script reads back
 * (prd.md, techspec.md). The tests intentionally do *not* call the host
 * LLM — they prove the Skill's contract is intact so the dispatcher in
 * /plan keeps wiring up correctly.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { fixturePath, runSkillSmoke } from './_harness/run-skill-smoke.js';

describe('skill:epic-plan-spec-author — smoke', () => {
  it('declares name, description, and allowed_tools', async () => {
    const result = await runSkillSmoke({
      skillName: 'epic-plan-spec-author',
      expectedTools: ['Read', 'Write'],
    });
    assert.equal(
      result.pass,
      true,
      `Skill failed front-matter contract: ${result.errors.join('; ')}`,
    );
    assert.equal(result.skill.name, 'epic-plan-spec-author');
    assert.ok(
      result.skill.allowed_tools.includes('Read'),
      'allowed_tools must include Read (Skill reads planner-context.json)',
    );
    assert.ok(
      result.skill.allowed_tools.includes('Write'),
      'allowed_tools must include Write (Skill writes prd.md + techspec.md)',
    );
  });

  it('end-to-end: validator can locate the prd.md / techspec.md contract in the Skill body', async () => {
    const fixtureFile = fixturePath('epic-1181-sample', 'planner-context.json');
    const ctx = JSON.parse(await readFile(fixtureFile, 'utf8'));
    assert.ok(ctx.epic.id > 0, 'fixture must carry a sample Epic ID');

    const result = await runSkillSmoke({
      skillName: 'epic-plan-spec-author',
      fixture: fixtureFile,
      validator: async ({ body }) => {
        const errors = [];
        // The Skill is the source of truth for the PRD + Tech Spec output
        // contract that epic-plan-spec.js --persist reads back. If these
        // path conventions ever drift, the persist half breaks silently.
        if (!/temp\/epic-<Epic_ID>\/prd\.md/.test(body)) {
          errors.push(
            'Skill body must reference temp/epic-<Epic_ID>/prd.md output path',
          );
        }
        if (!/temp\/epic-<Epic_ID>\/techspec\.md/.test(body)) {
          errors.push(
            'Skill body must reference temp/epic-<Epic_ID>/techspec.md output path',
          );
        }
        if (!/## Overview/.test(body)) {
          errors.push('PRD prompt must require "## Overview" heading');
        }
        if (!/## Technical Overview/.test(body)) {
          errors.push(
            'Tech Spec prompt must require "## Technical Overview" heading',
          );
        }
        // Story #3797 — the Tech Spec must carry a "Delivery Slicing" section
        // proposing how PRD capabilities cluster into N shippable Stories;
        // it is the target the Phase 8 consolidation pass reconciles against.
        if (!/## Delivery Slicing/.test(body)) {
          errors.push(
            'Tech Spec prompt must require a "## Delivery Slicing" section (Story #3797)',
          );
        }
        if (!/shippable Stor/i.test(body)) {
          errors.push(
            'Delivery Slicing must propose shippable Stories (Story #3797)',
          );
        }
        // Story #3797 — the PRD capability enumeration is NOT coarsened; the
        // grouping recommendation is the granularity lever.
        if (!/not coarsen|do not coarsen|without coarsening/i.test(body)) {
          errors.push(
            'Skill body must state the PRD enumeration is not coarsened (Story #3797)',
          );
        }
        // Story #4311 — the Delivery Slicing count is a CEILING, not a target,
        // and an "Independent? No" slice must justify staying separate.
        if (!/ceiling/i.test(body)) {
          errors.push(
            'Tech Spec prompt must frame the Delivery Slicing count as a ceiling (Story #4311)',
          );
        }
        if (
          !/parallelism|risk isolation|delivery-envelope|envelope pressure/i.test(
            body,
          )
        ) {
          errors.push(
            'Tech Spec prompt must require a justification (parallelism, risk isolation, or envelope pressure) for an "Independent? No" slice (Story #4311)',
          );
        }
        if (!/fold(s)? into (its )?consumer/i.test(body)) {
          errors.push(
            'Tech Spec prompt must state an unjustified dependent single-consumer slice folds into its consumer (Story #4311)',
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
