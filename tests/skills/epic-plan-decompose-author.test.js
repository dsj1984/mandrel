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
        // Story #2798 — the maxTickets section MUST not call the budget a
        // "hard cap" or "hard ceiling". The unrelated task-sizing
        // validator phrasing ("validator's hard ceilings (default
        // maxAcceptance ...") stays legitimate, so the check is scoped
        // to lines that mention maxTickets in the same sentence.
        const maxTicketsLines = body
          .split('\n')
          .filter((l) => /maxTickets/.test(l));
        for (const line of maxTicketsLines) {
          if (/hard (cap|ceiling)/i.test(line)) {
            errors.push(
              `Skill body must drop hard-cap / hard-ceiling phrasing for maxTickets (line: "${line.trim()}")`,
            );
          }
        }
        // Story #3237 — recalibrated thresholds: maxAcceptance raised to 8
        // (Story #3231 Recal B). The Skill body must advertise the new ceiling.
        if (!/maxAcceptance:\s*8/.test(body)) {
          errors.push(
            'Skill body must advertise the recalibrated maxAcceptance ceiling of 8 (Story #3231 Recal B)',
          );
        }
        // Story #3237 — sizingProfile is now optional / informational hint,
        // not a hard rejection (Story #3231 Recal C).
        if (/missing-sizing-profile(?!-hint)/i.test(body)) {
          // Tolerate `missing-sizing-profile-hint` but not bare `missing-sizing-profile`
          // as a rejection token.
          const msp = body.match(/missing-sizing-profile[^\s-]*/g) ?? [];
          if (msp.some((m) => m === 'missing-sizing-profile')) {
            errors.push(
              'Skill body must not describe missing-sizing-profile as a hard rejection; use missing-sizing-profile-hint (Story #3231 Recal C)',
            );
          }
        }
        // Story #3237 — estimated_test_files field must be documented
        // (Story #3235 test-surface gates).
        if (!/estimated_test_files/i.test(body)) {
          errors.push(
            'Skill body must document the estimated_test_files field (Story #3235 test-surface gates)',
          );
        }
        // Story #3237 — per-profile change ceilings table must be present
        // (Story #3231 Recal A).
        if (!/profileCeilings|per-profile change ceiling/i.test(body)) {
          errors.push(
            'Skill body must describe per-profile change ceilings (Story #3231 Recal A)',
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
