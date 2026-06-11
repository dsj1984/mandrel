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
        // The Story level is the only ticket tier the validator accepts
        // (2-tier: Epic → Story, no Feature or Task tier).
        if (!/\bStories\b/.test(body)) {
          errors.push(
            'Skill body must describe the "Stories" level of the hierarchy',
          );
        }
        if (!/no Feature/i.test(body)) {
          errors.push(
            'Skill body must state there is no Feature tier (Story #4041)',
          );
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
        // Story #3760 — sizing thresholds have exactly one definition
        // (DEFAULT_TASK_SIZING). The Skill body must advertise the relaxed
        // ceilings (maxAcceptance=14, hardFiles=30 — Story #3874) and name
        // the single constant.
        if (!(/maxAcceptance/.test(body) && /\b14\b/.test(body))) {
          errors.push(
            'Skill body must advertise the maxAcceptance ceiling of 14 (Story #3874)',
          );
        }
        if (!(/hardFiles/.test(body) && /\b30\b/.test(body))) {
          errors.push(
            'Skill body must advertise the hardFiles ceiling of 30 (Story #3874)',
          );
        }
        if (!/DEFAULT_TASK_SIZING/.test(body)) {
          errors.push(
            'Skill body must name DEFAULT_TASK_SIZING as the single sizing source of truth (Story #3760)',
          );
        }
        // Story #3760 — cohesion is the primary heuristic; the numeric ceiling
        // is only a backstop.
        if (!/cohesion/i.test(body)) {
          errors.push(
            'Skill body must lead the sizing section with a cohesion heuristic (Story #3760)',
          );
        }
        // Story #3760 — the wide declaration replaced the sizingProfile enum.
        if (!/\bwide\b/i.test(body)) {
          errors.push(
            'Skill body must describe the wide declaration (Story #3760)',
          );
        }
        // Story #3760 — the retired profile enum / testSurface gates must be gone.
        if (
          /sizingProfile|atomic-rewrite|scaffolding|mechanical-sweep|profileCeilings|test-surface-overflow|large-test-surface/i.test(
            body,
          )
        ) {
          errors.push(
            'Skill body must not restate the retired sizingProfile enum or testSurface gates (Story #3760)',
          );
        }
        // Story #3263 — SKILL must document top-level acceptance[] and verify[]
        // arrays on the Story ticket object (not nested inside body object).
        // hasInlineAcceptanceAndVerify() in ticket-validator.js reads story.acceptance
        // and story.verify at the top level — nesting them inside body makes them
        // invisible to the validator.
        if (
          !/top[-\s]level.*acceptance|acceptance.*top[-\s]level/i.test(body)
        ) {
          errors.push(
            'Skill body must document that acceptance[] lives at the top level of the Story ticket object (Story #3263)',
          );
        }
        if (!/top[-\s]level.*verify|verify.*top[-\s]level/i.test(body)) {
          errors.push(
            'Skill body must document that verify[] lives at the top level of the Story ticket object (Story #3263)',
          );
        }
        // Story #3263 — SKILL must document that body is a STRING produced by
        // serialize(), not a nested object. composeStoryBody() in tickets.js
        // discards any non-string body silently.
        if (!/body.*must be.*string|body.*is.*string/i.test(body)) {
          errors.push(
            'Skill body must document that Story body must be a string (not an object) for the GitHub provider (Story #3263)',
          );
        }
        // Story #3263 — SKILL must not instruct emitting body as a structured
        // object for stories (the stale nested shape that the validator rejects).
        if (/body is a STRUCTURED OBJECT/i.test(body)) {
          errors.push(
            'Skill body must not instruct emitting body as a STRUCTURED OBJECT for stories (stale 4-tier shape; Story #3263)',
          );
        }
        // Story #3777 / #3874 — the SKILL must carry the re-anchored
        // deliverable-granularity definition (capability slice a frontier
        // model delivers and self-verifies in one pass; shippable slice a
        // reviewer would accept as a single PR; not a single module or
        // file) shared with the decomposer prompt via
        // DELIVERABLE_GRANULARITY_GUIDANCE.
        if (
          !/capability slice a frontier model delivers and self-verifies in one pass/i.test(
            body,
          )
        ) {
          errors.push(
            'Skill body must define a Story as a capability slice a frontier model delivers and self-verifies in one pass (Story #3874)',
          );
        }
        if (
          !/shippable slice .* reviewer would accept as a single PR/i.test(body)
        ) {
          errors.push(
            'Skill body must define a Story as a shippable slice a reviewer would accept as a single PR (Story #3777)',
          );
        }
        // Story #3874 — the retired sizing framing must be gone: no
        // "5-file rule" and no atomic-as-target phrasing anywhere in the
        // Skill body.
        if (/5-file rule|\batomic\b/i.test(body)) {
          errors.push(
            'Skill body must not retain the retired 5-file-rule / atomic framing (Story #3874)',
          );
        }
        if (!/not a single module or file/i.test(body)) {
          errors.push(
            'Skill body must say a Story is NOT a single module or file (Story #3777)',
          );
        }
        if (!/fold module-level slices/i.test(body)) {
          errors.push(
            'Skill body must instruct folding module-level slices into the capability (Story #3777)',
          );
        }
        // Story #3777 — the single-consumer merge rule.
        if (!/single-consumer merge rule/i.test(body)) {
          errors.push(
            'Skill body must state the single-consumer merge rule (Story #3777)',
          );
        }
        if (!/merged into that sibling/i.test(body)) {
          errors.push(
            'Skill body must say a single-consumer Story is merged into that sibling (Story #3777)',
          );
        }
        // Story #3263 — SKILL must document hyphen-case slug format.
        if (!/hyphen[-\s]case|\\^\\[a-z0-9\\]|a-z0-9.*-/i.test(body)) {
          errors.push(
            'Skill body must document hyphen-case slug format (Story #3263)',
          );
        }
        // Story #3797 — the decompose-author consumes the Tech Spec
        // "Delivery Slicing" section as the target grouping when present and
        // degrades gracefully when absent.
        if (!/Delivery Slicing/.test(body)) {
          errors.push(
            'Skill body must consume the Tech Spec "Delivery Slicing" target grouping (Story #3797)',
          );
        }
        if (
          !/degrade gracefully|graceful(ly)?[- ]degrade|when .*absent/i.test(
            body,
          )
        ) {
          errors.push(
            'Skill body must degrade gracefully when Delivery Slicing is absent (Story #3797)',
          );
        }
        // Story #3797 — name the consolidation pass that reconciles the draft.
        if (!/epic-plan-consolidate/.test(body)) {
          errors.push(
            'Skill body must reference the epic-plan-consolidate Phase 8 pass (Story #3797)',
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
