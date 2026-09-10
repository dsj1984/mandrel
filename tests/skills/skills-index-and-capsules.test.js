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
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { run as runGenerator } from '../../.agents/scripts/generate-skills-index.js';
import {
  collectLocalSkillFiles,
  collectSkillFiles,
  resolveSkillFile,
} from '../../.agents/scripts/lib/skills/walk-skill-files.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

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
  tmpParent = makeTempDir('skills-int-');
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

describe('generate-skills-index.js — format stability (Story #4546)', () => {
  const LIVE_INDEX = path.join(
    REPO_ROOT,
    '.agents',
    'skills',
    'skills.index.json',
  );

  it('the committed manifest passes the project format gate', () => {
    const result = spawnSync(
      'npx',
      ['--no', 'biome', 'ci', '.agents/skills/skills.index.json'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      },
    );
    assert.equal(
      result.status,
      0,
      `biome ci rejected the committed manifest:\n${result.stdout || result.stderr}`,
    );
  });

  it('regenerating on a clean tree reproduces the committed bytes', () => {
    // The regression: the generator emitted raw `JSON.stringify` output,
    // which expands short arrays (`"allowedTools": ["Read", "Bash"]`)
    // across multiple lines, while the committed manifest is
    // Biome-formatted by lint-staged at commit time. `npm run
    // skills:index` therefore left the tree format-dirty on every run and
    // a `skills:index` → `lint` sequence failed on `biome ci` — even
    // though `skills:check` reported the index semantically fresh.
    //
    // `generatedAt` is a deliberately volatile field, so a byte-for-byte
    // match needs it pinned to whatever the committed manifest carries.
    // With it pinned, byte equality is the strongest available statement
    // of "regenerating leaves the tree clean": everything a plain `git
    // status` could report — formatting included — is covered, and the
    // timestamp is the one field it cannot speak to.
    const committed = fs.readFileSync(LIVE_INDEX, 'utf8');
    const committedGeneratedAt = JSON.parse(committed).generatedAt;
    assert.ok(
      committedGeneratedAt,
      'committed manifest is missing generatedAt',
    );

    // Write to a scratch path so the test never mutates the real repo;
    // the generator still resolves its Biome config from REPO_ROOT.
    const outPath = path.join(tmpParent, 'skills.index.json');
    const result = runGenerator({
      argv: ['--out', outPath],
      now: new Date(committedGeneratedAt),
    });
    assert.equal(result.status, 0, `generator failed: ${result.output}`);

    assert.equal(
      fs.readFileSync(outPath, 'utf8'),
      committed,
      'generator output diverges from the committed manifest — if the ' +
        'skills corpus did not change, this is format drift: the ' +
        'generator is no longer emitting Biome-formatted JSON',
    );
  });
});

describe('local skills zone — second resolution root (Story #5135)', () => {
  /**
   * Add a consumer-authored skill under `.agents/local/skills/` in a staged
   * tree, reusing the same well-formed fixture body as the payload skills so
   * the only variable under test is which root it sits in.
   *
   * @param {string} root staged repo root
   * @param {string} skillId tier-relative id, e.g. `stack/qa/acme-sso`
   */
  function stageLocalSkill(root, skillId) {
    const dir = path.join(
      root,
      '.agents',
      'local',
      'skills',
      ...skillId.split('/'),
    );
    fs.mkdirSync(dir, { recursive: true });
    const body = fs.readFileSync(
      path.join(FIXTURE_SRC, 'well-formed-stack.md'),
      'utf8',
    );
    // Frontmatter `name` must match the parent directory name.
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      body.replace(/^name: .*$/m, `name: ${path.basename(skillId)}`),
    );
  }

  it('collects local skills alongside payload skills, payload-wins on a collision', () => {
    const root = stageFixtureRoot(tmpParent);
    stageLocalSkill(root, 'stack/qa/acme-sso');
    // Same id as the staged payload skill — must not displace it.
    stageLocalSkill(root, 'stack/backend/stack-skill');

    const rel = (f) => path.relative(root, f).split(path.sep).join('/');
    const payload = collectSkillFiles(root).map(rel);
    const local = collectLocalSkillFiles(root).map(rel);

    // Each root enumerates only its own files — the property the shipped
    // manifest's payload-only guarantee rests on.
    assert.ok(
      payload.includes('.agents/skills/stack/backend/stack-skill/SKILL.md'),
    );
    assert.ok(
      !payload.some((f) => f.includes('/local/')),
      'payload root is payload-only',
    );
    assert.deepEqual(local.sort(), [
      '.agents/local/skills/stack/backend/stack-skill/SKILL.md',
      '.agents/local/skills/stack/qa/acme-sso/SKILL.md',
    ]);

    // Lookup unifies the two, payload-wins on a collision.
    assert.equal(
      rel(resolveSkillFile(root, 'stack/backend/stack-skill').path),
      '.agents/skills/stack/backend/stack-skill/SKILL.md',
    );
    assert.equal(
      rel(resolveSkillFile(root, 'stack/qa/acme-sso').path),
      '.agents/local/skills/stack/qa/acme-sso/SKILL.md',
    );
    assert.equal(resolveSkillFile(root, 'stack/qa/absent'), null);
    // Story #5285: a malformed id is a distinct return, so a caller can say
    // "fix the id" instead of "author the skill".
    assert.deepEqual(resolveSkillFile(root, '../../secrets'), {
      reason: 'invalid-id',
    });
  });

  it('keeps the shipped manifest payload-only and writes local skills to their own index', () => {
    // Load-bearing: `.agents/skills/skills.index.json` is a committed payload
    // file that `mandrel doctor` / `mandrel sync-agents` compare against the
    // installed package. Folding local skills into it would make every
    // consumer who authors one look like payload drift, and those commands
    // would refuse.
    const root = stageFixtureRoot(tmpParent);
    const shippedIndex = path.join(
      root,
      '.agents',
      'skills',
      'skills.index.json',
    );
    const localIndex = path.join(
      root,
      '.agents',
      'local',
      'skills',
      'skills.index.json',
    );

    assert.equal(runGenerator({ argv: ['--root', root] }).status, 0);
    const before = JSON.parse(fs.readFileSync(shippedIndex, 'utf8'));
    assert.equal(
      fs.existsSync(localIndex),
      false,
      'no local skills, no local index',
    );

    stageLocalSkill(root, 'stack/qa/acme-sso');
    assert.equal(runGenerator({ argv: ['--root', root] }).status, 0);
    const after = JSON.parse(fs.readFileSync(shippedIndex, 'utf8'));

    // Identical modulo the volatile `generatedAt` — the field `--check`
    // itself ignores.
    assert.deepEqual(after.skills, before.skills);
    assert.ok(
      !after.skills.some((s) => s.path.includes('/local/')),
      'no local skill leaked into the shipped manifest',
    );

    const local = JSON.parse(fs.readFileSync(localIndex, 'utf8'));
    assert.deepEqual(
      local.skills.map((s) => s.path),
      ['.agents/local/skills/stack/qa/acme-sso/SKILL.md'],
    );
  });

  it('--check stays green on a committed shipped manifest when a local skill exists', () => {
    const root = stageFixtureRoot(tmpParent);
    assert.equal(runGenerator({ argv: ['--root', root] }).status, 0);
    const committed = fs.readFileSync(
      path.join(root, '.agents', 'skills', 'skills.index.json'),
      'utf8',
    );

    stageLocalSkill(root, 'stack/qa/acme-sso');
    assert.equal(runGenerator({ argv: ['--root', root] }).status, 0);
    // The shipped manifest is regenerated but must still match what was
    // committed, modulo `generatedAt`.
    assert.equal(runGenerator({ argv: ['--check', '--root', root] }).status, 0);
    const a = JSON.parse(committed);
    const b = JSON.parse(
      fs.readFileSync(
        path.join(root, '.agents', 'skills', 'skills.index.json'),
        'utf8',
      ),
    );
    assert.deepEqual(b.skills, a.skills);
  });

  it('reaps the local index when the last local skill is removed', () => {
    const root = stageFixtureRoot(tmpParent);
    stageLocalSkill(root, 'stack/qa/acme-sso');
    assert.equal(runGenerator({ argv: ['--root', root] }).status, 0);
    const localIndex = path.join(
      root,
      '.agents',
      'local',
      'skills',
      'skills.index.json',
    );
    assert.equal(fs.existsSync(localIndex), true);

    fs.rmSync(path.join(root, '.agents', 'local', 'skills', 'stack'), {
      recursive: true,
    });
    // A stale index would otherwise keep advertising a skill that is gone.
    assert.equal(runGenerator({ argv: ['--check', '--root', root] }).status, 1);
    assert.equal(runGenerator({ argv: ['--root', root] }).status, 0);
    assert.equal(fs.existsSync(localIndex), false);
  });

  it('holds a consumer-authored skill to the same validation bar as a shipped one', () => {
    const root = stageFixtureRoot(tmpParent);
    stageLocalSkill(root, 'stack/qa/acme-sso');
    assert.equal(runGenerator({ argv: ['--root', root] }).status, 0);
    assert.equal(runCli(VALIDATOR_CLI, ['--root', root]).status, 0);

    // Break the capsule in the LOCAL skill only.
    const skillPath = path.join(
      root,
      '.agents',
      'local',
      'skills',
      'stack',
      'qa',
      'acme-sso',
      'SKILL.md',
    );
    const kept = [];
    let bullets = 0;
    for (const line of fs.readFileSync(skillPath, 'utf8').split('\n')) {
      if (line.startsWith('- ') && ++bullets > 2) continue;
      kept.push(line);
    }
    fs.writeFileSync(skillPath, kept.join('\n'));

    const broken = runCli(VALIDATOR_CLI, ['--root', root]);
    assert.equal(broken.status, 1);
    assert.match(
      broken.stdout,
      /local[/\\]skills[/\\]stack[/\\]qa[/\\]acme-sso/,
    );
  });
});
