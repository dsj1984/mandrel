/**
 * Smoke spec for the `epic-plan-decompose-author` Skill
 * (Epic #1181 / Story #1441 / Task #1455).
 *
 * The validator pins the Skill's allowed_tools (Read, Write, Bash) and
 * asserts the Skill body still describes the JSON-array output the
 * downstream `epic-plan-decompose.js --tickets` validator consumes.
 * The host LLM is not invoked here — the smoke spec proves the contract
 * surface, not the planning output.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { fixturePath, runSkillSmoke } from './_harness/run-skill-smoke.js';

describe('skill:epic-plan-decompose-author — smoke', () => {
  it('declares name, description, and allowed_tools', async () => {
    const result = await runSkillSmoke({
      skillName: 'epic-plan-decompose-author',
      expectedTools: ['Read', 'Write'],
    });
    assert.equal(
      result.pass,
      true,
      `Skill failed front-matter contract: ${result.errors.join('; ')}`,
    );
    assert.equal(result.skill.name, 'epic-plan-decompose-author');
  });

  it('end-to-end: validator confirms the tickets.json contract is in the Skill body', async () => {
    const fixtureFile = fixturePath(
      'epic-1181-sample',
      'decomposer-context.json',
    );
    const ctx = JSON.parse(await readFile(fixtureFile, 'utf8'));
    assert.ok(ctx.epic.id > 0, 'fixture must carry a sample Epic ID');
    assert.ok(ctx.prd.length > 0, 'fixture must carry a PRD body');
    assert.ok(ctx.techSpec.length > 0, 'fixture must carry a Tech Spec body');

    const result = await runSkillSmoke({
      skillName: 'epic-plan-decompose-author',
      fixture: fixtureFile,
      validator: async ({ body }) => {
        const errors = [];
        // The downstream validator in lib/orchestration/ticket-validator.js
        // reads back temp/epic-<Epic_ID>/tickets.json. The Skill must keep
        // that path documented, or the persist half will hunt the wrong
        // artifact.
        if (!/temp\/epic-<Epic_ID>\/tickets\.json/.test(body)) {
          errors.push(
            'Skill body must reference temp/epic-<Epic_ID>/tickets.json output path',
          );
        }
        // The three hierarchy levels are non-negotiable inputs to the
        // ticket validator.
        for (const level of ['Features', 'Stories', 'Tasks']) {
          if (!new RegExp(`\\b${level}\\b`).test(body)) {
            errors.push(
              `Skill body must describe the "${level}" level of the hierarchy`,
            );
          }
        }
        if (!/JSON array/i.test(body)) {
          errors.push('Skill body must require a JSON-array output shape');
        }
        // Story #2798 — the Skill must describe `maxTickets` as a
        // reviewability budget rather than a hard authoring cap, and
        // require an explicit over-budget rationale / operator override
        // path when the plan exceeds the budget.
        if (!/reviewability budget/i.test(body)) {
          errors.push(
            'Skill body must describe `maxTickets` as a reviewability budget',
          );
        }
        if (!/over[- ]budget rationale|--allow-over-budget/i.test(body)) {
          errors.push(
            'Skill body must require an over-budget rationale or describe the --allow-over-budget override path',
          );
        }
        if (/hard ceiling/i.test(body)) {
          errors.push(
            'Skill body must drop hard-cap / hard-ceiling phrasing in favor of reviewability-budget language',
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
