/**
 * Smoke spec for the `hydrate-context` Skill
 * (Epic #1181 / Story #1441 / Task #1456).
 *
 * Verifies the Skill is loadable, declares Read + Bash in allowed_tools,
 * and documents the `{ prompt }` JSON envelope the dispatcher consumes.
 * The validator also confirms the Skill body exposes the previously-
 * emitted persona / skills fields the context-hydration engine produces
 * — losing them silently would break every Epic-scoped sub-agent that
 * dispatches a hydrate-then-execute pair.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runSkillSmoke } from './_harness/run-skill-smoke.js';

describe('skill:hydrate-context — smoke', () => {
  it('declares name, description, and allowed_tools (Read + Bash)', async () => {
    const result = await runSkillSmoke({
      skillName: 'hydrate-context',
      expectedTools: ['Read', 'Bash'],
    });
    assert.equal(
      result.pass,
      true,
      `Skill failed front-matter contract: ${result.errors.join('; ')}`,
    );
    assert.equal(result.skill.name, 'hydrate-context');
  });

  it('Skill body documents the {prompt} envelope and persona/skill surface', async () => {
    const result = await runSkillSmoke({
      skillName: 'hydrate-context',
      validator: async ({ body }) => {
        const errors = [];
        if (!/\{\s*"prompt"\s*:/.test(body) && !/"prompt"/.test(body)) {
          errors.push(
            'Skill body must document the {"prompt": "..."} JSON envelope',
          );
        }
        if (!/persona::/.test(body)) {
          errors.push(
            'Skill body must reference the persona:: label surface (engine reads it)',
          );
        }
        if (!/skill::/.test(body)) {
          errors.push(
            'Skill body must reference the skill:: label surface (engine reads it)',
          );
        }
        if (!/--ticket/.test(body)) {
          errors.push(
            'Skill body must document the --ticket flag (entry-point contract)',
          );
        }
        if (!/--epic/.test(body)) {
          errors.push(
            'Skill body must document the --epic flag (fallback contract)',
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
