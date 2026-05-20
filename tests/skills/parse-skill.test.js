// tests/skills/parse-skill.test.js
//
// Unit coverage for lib/skills/parse-skill.js. Uses fs fixtures under
// tests/skills/fixtures/ rather than the live .agents/skills/ tree so the
// suite stays stable as real SKILL.md files evolve.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { parseSkill } from '../../.agents/scripts/lib/skills/parse-skill.js';

const FIXTURE_ROOT = path.resolve(import.meta.dirname, 'fixtures');

/**
 * Build a transient repo-like tree under os.tmpdir() so parseSkill's
 * repo-root resolver finds an `.agents/skills` marker. Returns the
 * absolute path to the staged SKILL.md.
 *
 * Layout:
 *   <tmp>/
 *     .agents/skills/<tier>/<category?>/<name>/SKILL.md
 *
 * `category` is required for stack-tier; for core-tier the layout is
 * `.agents/skills/core/<name>/SKILL.md`.
 */
function stageFixture(
  tmpRoot,
  fixtureName,
  { tier, category, name, eol = '\n' },
) {
  const src = fs.readFileSync(path.join(FIXTURE_ROOT, fixtureName), 'utf8');
  const segments =
    tier === 'core'
      ? ['.agents', 'skills', 'core', name]
      : ['.agents', 'skills', 'stack', category, name];
  const skillDir = path.join(tmpRoot, ...segments);
  fs.mkdirSync(skillDir, { recursive: true });
  const target = path.join(skillDir, 'SKILL.md');
  const normalized =
    eol === '\r\n'
      ? src.replace(/\r?\n/g, '\r\n')
      : src.replace(/\r?\n/g, '\n');
  fs.writeFileSync(target, normalized);
  return target;
}

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-skill-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('parseSkill — well-formed SKILL with Policy Capsule', () => {
  it('extracts frontmatter, path metadata, and counts capsule bullets', () => {
    const target = stageFixture(tmpRoot, 'well-formed.md', {
      tier: 'core',
      name: 'well-formed-skill',
    });

    const result = parseSkill(target);

    assert.equal(result.name, 'well-formed-skill');
    assert.equal(result.tier, 'core');
    assert.equal(result.category, 'core');
    assert.ok(
      result.path.endsWith('.agents/skills/core/well-formed-skill/SKILL.md'),
    );
    assert.equal(result.frontmatter.name, 'well-formed-skill');
    assert.equal(
      result.frontmatter.description.includes('Capsule fixture'),
      true,
    );
    assert.deepEqual(result.frontmatter.allowed_tools, ['Read', 'Bash']);

    assert.equal(result.policyCapsule.found, true);
    assert.ok(result.policyCapsule.bulletCount >= 5);
    assert.ok(result.policyCapsule.bulletCount <= 12);
    assert.equal(typeof result.policyCapsule.sectionStart, 'number');
    assert.ok(result.policyCapsule.sectionStart > 0);
  });

  it('tolerates CRLF line endings without altering bullet count', () => {
    // Stage two isolated repo roots so both stagings can use the parent
    // directory name that matches the fixture's declared frontmatter name.
    const lfRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-skill-lf-'));
    const crlfRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'parse-skill-crlf-'),
    );
    try {
      const lfPath = stageFixture(lfRoot, 'well-formed.md', {
        tier: 'core',
        name: 'well-formed-skill',
        eol: '\n',
      });
      const crlfPath = stageFixture(crlfRoot, 'well-formed.md', {
        tier: 'core',
        name: 'well-formed-skill',
        eol: '\r\n',
      });

      const lf = parseSkill(lfPath);
      const crlf = parseSkill(crlfPath);

      assert.equal(
        crlf.policyCapsule.bulletCount,
        lf.policyCapsule.bulletCount,
      );
      assert.equal(crlf.policyCapsule.found, true);
      assert.equal(crlf.frontmatter.name, 'well-formed-skill');
    } finally {
      fs.rmSync(lfRoot, { recursive: true, force: true });
      fs.rmSync(crlfRoot, { recursive: true, force: true });
    }
  });

  it('derives stack tier + category from the path', () => {
    const target = stageFixture(tmpRoot, 'well-formed-stack.md', {
      tier: 'stack',
      category: 'backend',
      name: 'stack-skill',
    });

    const result = parseSkill(target);

    assert.equal(result.tier, 'stack');
    assert.equal(result.category, 'backend');
    assert.equal(result.name, 'stack-skill');
    assert.equal(result.frontmatter.vendor, 'example-vendor');
  });
});

describe('parseSkill — missing Policy Capsule', () => {
  it('returns policyCapsule.found === false when the heading is absent', () => {
    const target = stageFixture(tmpRoot, 'missing-capsule.md', {
      tier: 'core',
      name: 'no-capsule-skill',
    });

    const result = parseSkill(target);

    assert.equal(result.policyCapsule.found, false);
    assert.equal(result.policyCapsule.bulletCount, 0);
    assert.equal(result.policyCapsule.sectionStart, null);
    // Other fields still populate so the validator can report what *is* there.
    assert.equal(result.frontmatter.name, 'no-capsule-skill');
  });
});

describe('parseSkill — frontmatter name / directory mismatch', () => {
  it('throws an Error naming both the frontmatter name and the directory name', () => {
    // Fixture frontmatter declares name: "intended-name" but we stage it
    // under a directory called "actual-directory".
    const target = stageFixture(tmpRoot, 'name-mismatch.md', {
      tier: 'core',
      name: 'actual-directory',
    });

    assert.throws(
      () => parseSkill(target),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /intended-name/);
        assert.match(err.message, /actual-directory/);
        return true;
      },
    );
  });
});
