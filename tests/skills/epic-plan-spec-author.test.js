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

import { renderTechSpecSystemPrompt } from '../../.agents/scripts/lib/templates/spec-author-prompts.js';
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

  it('Skill body references the techspec.md output contract the persist half reads back', async () => {
    const fixtureFile = fixturePath('epic-1181-sample', 'planner-context.json');
    const ctx = JSON.parse(await readFile(fixtureFile, 'utf8'));
    assert.ok(ctx.epic.id > 0, 'fixture must carry a sample Epic ID');

    const result = await runSkillSmoke({
      skillName: 'epic-plan-spec-author',
      fixture: fixtureFile,
      validator: async ({ body }) => {
        const errors = [];
        // The Skill is the source of truth for the Tech Spec output contract
        // that epic-plan-spec.js --persist reads back. If this path convention
        // ever drifts, the persist half breaks silently.
        //
        // Story #4314 — the PRD artifact class is retired; the Skill no longer
        // authors prd.md and its User Stories section now lives inline in the
        // Epic body, so the prd.md / "## Overview" checks are dropped.
        if (!/temp\/epic-<Epic_ID>\/techspec\.md/.test(body)) {
          errors.push(
            'Skill body must reference temp/epic-<Epic_ID>/techspec.md output path',
          );
        }
        // Epic #4479 (M8) — the Tech Spec system prompt is single-sourced in
        // lib/templates/spec-author-prompts.js; the Skill body must NOT carry a
        // second verbatim copy. It points at the rendered systemPrompts.techSpec
        // instead (the prompt-content contract is asserted separately below).
        if (
          !/systemPrompts\.techSpec/.test(body) ||
          !/spec-author-prompts\.js/.test(body)
        ) {
          errors.push(
            'Skill body must defer the Tech Spec prompt to systemPrompts.techSpec / spec-author-prompts.js (Epic #4479)',
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

  // Epic #4479 (M8) — the Tech Spec prompt-content contract now lives on the
  // single-sourced renderTechSpecSystemPrompt() output, not the Skill body.
  // These assertions moved verbatim from the former Skill-body validator so the
  // behavioural coverage is preserved at the new source of truth.
  it('renderTechSpecSystemPrompt() carries the Delivery-Slicing-first contract', () => {
    const prompt = renderTechSpecSystemPrompt();
    // Story #4316 — opens with "## Delivery Slicing", forbids restatement.
    assert.match(
      prompt,
      /Open the document with the `## Delivery Slicing` section/,
      'Tech Spec prompt must instruct the document to OPEN with "## Delivery Slicing" (Story #4316)',
    );
    assert.doesNotMatch(
      prompt,
      /Start with ## Technical Overview/,
      'Tech Spec prompt must not retain the "Start with ## Technical Overview" contradiction (Story #4316)',
    );
    assert.match(
      prompt,
      /Do NOT restate the Epic's Context, Goal, or Scope/,
      "Tech Spec prompt must forbid restating the Epic's Context/Goal/Scope (Story #4316)",
    );
    // Story #3797 — a "## Delivery Slicing" section proposing shippable Stories,
    // without coarsening the enumeration.
    assert.match(prompt, /## Delivery Slicing/);
    assert.match(
      prompt,
      /shippable Stor/i,
      'Delivery Slicing must propose shippable Stories (Story #3797)',
    );
    assert.match(
      prompt,
      /not coarsen|do not coarsen|without coarsening/i,
      'prompt must state the enumeration is not coarsened (Story #3797)',
    );
    // Story #4311 — the count is a CEILING and an "Independent? No" slice must
    // justify staying separate or fold into its consumer.
    assert.match(
      prompt,
      /ceiling/i,
      'Tech Spec prompt must frame the Delivery Slicing count as a ceiling (Story #4311)',
    );
    assert.match(
      prompt,
      /parallelism|risk isolation|delivery-envelope|envelope pressure/i,
      'prompt must require a justification for an "Independent? No" slice (Story #4311)',
    );
    assert.match(
      prompt,
      /fold(s)? into (its )?consumer/i,
      'prompt must state an unjustified dependent single-consumer slice folds into its consumer (Story #4311)',
    );
  });
});
