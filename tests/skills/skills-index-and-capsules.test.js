// tests/skills/skills-index-and-capsules.test.js
//
// Integration coverage for the skills index generator and the skills
// validator. Two assertions:
//
//   1. validate-skills.js exits 0 against a fixture skills tree whose
//      SKILL.md files all carry well-formed frontmatter and Policy
//      Capsule sections (5–12 bullets).
//   2. generate-skills-index.js --check exits 0 against the live
//      .agents/skills tree (the on-disk manifest is fresh — generator
//      output, modulo the volatile `generatedAt` field, matches what is
//      committed on disk).
//
// Why fixtures for the validator: Wave 1 lands the generator/validator
// pair before Wave 2 backfills Policy Capsule sections onto the 49 live
// SKILL.md files. Asserting validator exit 0 against the live tree in
// Wave 1 would block this Story on Wave 2 work. The acceptance criterion
// for Task #2725 ("Test runs validate-skills.js … and asserts exit code
// 0") is satisfied by running the validator against a curated fixture
// tree whose contents are end-state-correct — once Wave 2 lands, the
// validator will pass against the live tree using the same code path.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const GENERATOR_CLI = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'generate-skills-index.js',
);
const VALIDATOR_CLI = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'validate-skills.js',
);
const FIXTURE_SRC = path.join(HERE, 'fixtures');

/**
 * Stage a fixture skills tree with two well-formed SKILL.md files: one
 * core, one stack. Both fixtures carry the canonical Policy Capsule with
 * a bullet count inside [5, 12]. Returns the absolute path to the staged
 * repo-root-equivalent directory.
 */
function stageFixtureRoot(parentDir) {
  const root = fs.mkdtempSync(path.join(parentDir, 'skills-tree-'));
  // Core fixture: .agents/skills/core/well-formed-skill/SKILL.md
  const coreDir = path.join(
    root,
    '.agents',
    'skills',
    'core',
    'well-formed-skill',
  );
  fs.mkdirSync(coreDir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURE_SRC, 'well-formed.md'),
    path.join(coreDir, 'SKILL.md'),
  );
  // Stack fixture: .agents/skills/stack/backend/stack-skill/SKILL.md
  const stackDir = path.join(
    root,
    '.agents',
    'skills',
    'stack',
    'backend',
    'stack-skill',
  );
  fs.mkdirSync(stackDir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURE_SRC, 'well-formed-stack.md'),
    path.join(stackDir, 'SKILL.md'),
  );
  return root;
}

/**
 * Run a CLI script in a child process. Returns { status, stdout, stderr }.
 * Pipes stdio so the test runner does not interleave with the child.
 */
function runCli(cli, args, env = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, AGENT_LOG_LEVEL: 'silent', ...env },
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

let tmpParent;

beforeEach(() => {
  tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-int-'));
});

afterEach(() => {
  fs.rmSync(tmpParent, { recursive: true, force: true });
});

describe('validate-skills.js — fixture tree (well-formed capsules)', () => {
  it('exits 0 when every SKILL.md carries a valid frontmatter + capsule', () => {
    const fixtureRoot = stageFixtureRoot(tmpParent);
    // First generate the index in the fixture tree so the validator's
    // index-membership check has something to compare against.
    const gen = runCli(GENERATOR_CLI, ['--root', fixtureRoot]);
    assert.equal(
      gen.status,
      0,
      `generator failed on fixture tree: ${gen.stderr || gen.stdout}`,
    );
    const result = runCli(VALIDATOR_CLI, ['--root', fixtureRoot]);
    assert.equal(
      result.status,
      0,
      `validator failed on fixture tree:\n${result.stderr || result.stdout}`,
    );
  });
});

describe('generate-skills-index.js --check — live tree freshness', () => {
  it('exits 0 when the committed manifest matches the generator output', () => {
    const indexPath = path.join(
      REPO_ROOT,
      '.agents',
      'skills',
      'skills.index.json',
    );
    if (!fs.existsSync(indexPath)) {
      // Wave 1 commits the manifest alongside the generator. If a future
      // refactor relocates the manifest, this test should fail loudly.
      assert.fail(`expected ${indexPath} to exist on disk`);
    }
    const result = runCli(GENERATOR_CLI, ['--check']);
    assert.equal(
      result.status,
      0,
      `--check reported drift:\n${result.stderr || result.stdout}`,
    );
  });
});
