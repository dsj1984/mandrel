/**
 * Unit tests for the skill smoke-test harness (Epic #1181 / Story #1441 /
 * Task #1453). The harness itself is the foundation every per-Skill smoke
 * spec depends on, so we exercise its three core surfaces here:
 *
 *   1. parseSkillMarkdown() — front-matter parser shape + failure modes
 *   2. runSkillSmoke() — happy path against a real migrated Skill
 *   3. runSkillSmoke() — negative controls (missing skill, missing tools)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  fixturePath,
  parseSkillMarkdown,
  runSkillSmoke,
} from './run-skill-smoke.js';

describe('parseSkillMarkdown', () => {
  it('extracts scalar fields and the allowed_tools list', () => {
    const src = [
      '---',
      'name: sample-skill',
      'description: A sample skill for tests.',
      'allowed_tools:',
      '  - Read',
      '  - Write',
      '---',
      '',
      '# Body',
      '',
      'Body content.',
      '',
    ].join('\n');
    const { frontMatter, body } = parseSkillMarkdown(src);
    assert.equal(frontMatter.name, 'sample-skill');
    assert.equal(frontMatter.description, 'A sample skill for tests.');
    assert.deepEqual(frontMatter.allowed_tools, ['Read', 'Write']);
    assert.match(body, /# Body/);
  });

  it('joins folded ">-" scalars onto a single line', () => {
    const src = [
      '---',
      'name: sample',
      'description: >-',
      '  Multi-line',
      '  description',
      '  block.',
      'allowed_tools:',
      '  - Read',
      '---',
      '',
      'body',
      '',
    ].join('\n');
    const { frontMatter } = parseSkillMarkdown(src);
    assert.equal(frontMatter.description, 'Multi-line description block.');
  });

  it('throws when the front-matter fence is missing', () => {
    assert.throws(
      () => parseSkillMarkdown('# No front matter here\n'),
      /front-matter fence/,
    );
  });

  it('throws when the front-matter fence is unterminated', () => {
    assert.throws(
      () => parseSkillMarkdown('---\nname: skill\nno-closing-fence\n'),
      /unterminated/,
    );
  });
});

describe('runSkillSmoke', () => {
  it('returns pass=true for the epic-plan-spec-author skill (real, on-disk)', async () => {
    const result = await runSkillSmoke({
      skillName: 'epic-plan-spec-author',
    });
    assert.equal(
      result.pass,
      true,
      `Expected pass=true; errors=${JSON.stringify(result.errors)}`,
    );
    assert.equal(result.skill.name, 'epic-plan-spec-author');
    assert.ok(Array.isArray(result.skill.allowed_tools));
    assert.ok(result.skill.allowed_tools.length > 0);
  });

  it('returns pass=false with a clear error when the skill does not exist', async () => {
    const result = await runSkillSmoke({
      skillName: 'this-skill-does-not-exist-' + Date.now(),
    });
    assert.equal(result.pass, false);
    assert.equal(result.skill, null);
    assert.match(result.errors.join('\n'), /not found/);
  });

  it('flags missing tools when expectedTools is given', async () => {
    const result = await runSkillSmoke({
      skillName: 'epic-plan-spec-author',
      expectedTools: ['Read', 'Write', 'NonExistentTool'],
    });
    assert.equal(result.pass, false);
    assert.match(
      result.errors.join('\n'),
      /omits required tools.*NonExistentTool/,
    );
  });

  it('invokes the validator with the parsed skill + fixture', async () => {
    let received = null;
    const result = await runSkillSmoke({
      skillName: 'epic-plan-spec-author',
      fixture: fixturePath('epic-1181-sample', 'epic.md'),
      validator: async (ctx) => {
        received = ctx;
        return { ok: true };
      },
    });
    assert.equal(result.pass, true);
    assert.ok(received !== null, 'validator must be invoked on the happy path');
    assert.equal(received.skill.name, 'epic-plan-spec-author');
    assert.match(received.fixture, /epic\.md$/);
  });

  it('surfaces validator-reported failure as errors', async () => {
    const result = await runSkillSmoke({
      skillName: 'epic-plan-spec-author',
      validator: async () => ({
        ok: false,
        errors: ['custom validator failure'],
      }),
    });
    assert.equal(result.pass, false);
    assert.match(result.errors.join('\n'), /custom validator failure/);
  });
});

describe('fixturePath', () => {
  it('resolves under tests/skills/_fixtures', () => {
    const p = fixturePath('epic-1181-sample', 'epic.md');
    assert.match(
      p.replace(/\\/g, '/'),
      /tests\/skills\/_fixtures\/epic-1181-sample\/epic\.md$/,
    );
  });
});
