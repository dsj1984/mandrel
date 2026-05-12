/**
 * Smoke spec for the `diagnose-friction` Skill
 * (Epic #1181 / Story #1441 / Task #1456).
 *
 * Asserts the Skill is loadable with the expected allowed_tools (Bash,
 * Read) and that its body documents the diagnosis-report contract:
 *   - friction record kind + category + detail
 *   - story / epic resolution order
 *   - best-effort observation (does not mutate the wrapped exit code)
 *
 * Runs the validator against a fixture story-closure.json so a future
 * change to the friction-report shape forces this spec to be updated
 * in lock-step with the Skill body.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { fixturePath, runSkillSmoke } from './_harness/run-skill-smoke.js';

describe('skill:diagnose-friction — smoke', () => {
  it('declares name, description, and allowed_tools (Bash + Read)', async () => {
    const result = await runSkillSmoke({
      skillName: 'diagnose-friction',
      expectedTools: ['Bash'],
    });
    assert.equal(
      result.pass,
      true,
      `Skill failed front-matter contract: ${result.errors.join('; ')}`,
    );
    assert.equal(result.skill.name, 'diagnose-friction');
  });

  it('end-to-end: validator confirms diagnosis-report shape against fixture closure', async () => {
    const fixtureFile = fixturePath('epic-1181-sample', 'story-closure.json');
    const closure = JSON.parse(await readFile(fixtureFile, 'utf8'));
    assert.ok(
      Array.isArray(closure.events),
      'fixture closure must list events',
    );
    assert.ok(
      closure.events.length > 0,
      'fixture closure must contain at least one event',
    );

    const result = await runSkillSmoke({
      skillName: 'diagnose-friction',
      fixture: fixtureFile,
      validator: async ({ body }) => {
        const errors = [];
        // The Skill body is authoritative on the friction-record shape.
        // If any of these surface terms disappears, the analyzer's
        // attribution pipeline silently breaks.
        if (!/friction/.test(body)) {
          errors.push('Skill body must describe the "friction" record kind');
        }
        if (!/signals\.ndjson/.test(body)) {
          errors.push('Skill body must point at signals.ndjson');
        }
        if (!/best-effort/i.test(body)) {
          errors.push(
            'Skill body must state the best-effort observation contract',
          );
        }
        if (!/exit code/i.test(body)) {
          errors.push(
            'Skill body must state that the wrapped exit code is preserved',
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
