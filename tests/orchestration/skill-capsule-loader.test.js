import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadSkillCapsule } from '../../.agents/scripts/lib/orchestration/skill-capsule-loader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const WELL_FORMED_SKILL = path.join(
  REPO_ROOT,
  'tests',
  'skills',
  'fixtures',
  'well-formed.md',
);
const NO_CAPSULE_FIXTURE = path.join(
  HERE,
  'fixtures',
  'skill-capsule',
  'no-capsule-skill',
  'SKILL.md',
);

function stageFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-capsule-'));
  const coreDir = path.join(
    root,
    '.agents',
    'skills',
    'core',
    'well-formed-skill',
  );
  fs.mkdirSync(coreDir, { recursive: true });
  fs.copyFileSync(WELL_FORMED_SKILL, path.join(coreDir, 'SKILL.md'));
  const noCapsuleDir = path.join(
    root,
    '.agents',
    'skills',
    'core',
    'no-capsule-skill',
  );
  fs.mkdirSync(noCapsuleDir, { recursive: true });
  fs.copyFileSync(NO_CAPSULE_FIXTURE, path.join(noCapsuleDir, 'SKILL.md'));
  return root;
}

describe('loadSkillCapsule', () => {
  /** @type {string[]} */
  let tempRoots = [];

  afterEach(() => {
    for (const root of tempRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    tempRoots = [];
  });

  it('returns the Policy Capsule span through the next ## heading', () => {
    const root = stageFixtureRoot();
    tempRoots.push(root);
    const skillsIndex = {
      skills: [
        {
          name: 'well-formed-skill',
          path: '.agents/skills/core/well-formed-skill/SKILL.md',
        },
      ],
    };

    const result = loadSkillCapsule('well-formed-skill', skillsIndex, {
      repoRoot: root,
    });

    assert.equal(result.source, 'capsule');
    assert.ok(
      result.capsule.startsWith('## Policy Capsule'),
      'capsule must include the Policy Capsule heading',
    );
    assert.ok(
      !result.capsule.includes('## Another Section'),
      'capsule must stop before the next ## heading',
    );
  });

  it('falls back to full body and warns when the marker is absent', () => {
    const root = stageFixtureRoot();
    tempRoots.push(root);
    const skillsIndex = {
      skills: [
        {
          name: 'no-capsule-skill',
          path: '.agents/skills/core/no-capsule-skill/SKILL.md',
        },
      ],
    };
    const warnings = [];

    const result = loadSkillCapsule('no-capsule-skill', skillsIndex, {
      repoRoot: root,
      warn: (msg) => warnings.push(msg),
    });

    assert.equal(result.source, 'full-body-fallback');
    assert.ok(result.capsule.includes('Body prose only'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /capsule marker missing: no-capsule-skill/);
  });

  it('returns the full SKILL.md when fullBodyOptIn is true', () => {
    const root = stageFixtureRoot();
    tempRoots.push(root);
    const rel = '.agents/skills/core/well-formed-skill/SKILL.md';
    const abs = path.join(root, rel);
    const fullBody = fs.readFileSync(abs, 'utf8');
    const skillsIndex = { skills: [{ name: 'well-formed-skill', path: rel }] };

    const result = loadSkillCapsule('well-formed-skill', skillsIndex, {
      repoRoot: root,
      fullBodyOptIn: true,
    });

    assert.equal(result.source, 'full-body-optin');
    assert.equal(result.capsule, fullBody);
  });
});
