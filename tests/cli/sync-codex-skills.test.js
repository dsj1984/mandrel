/**
 * Codex skill projection of the workflow set (Story #5655).
 *
 * The existing command projection (`sync-claude-commands.js`, reached by
 * `mandrel sync-commands` and the bootstrap-seeded `npm run sync:commands`)
 * also writes `.agents/skills/workflows/<name>/SKILL.md` — one pointer skill
 * per projectable workflow, from the same source set and exclusions.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

import {
  CODEX_SKILLS_DIR,
  expectedCodexSkills,
} from '../../.agents/scripts/lib/codex/skills-projection.js';
import { collectSkillFiles } from '../../.agents/scripts/lib/skills/walk-skill-files.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'mandrel.js');
const CLAUDE_SYNC = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'sync-claude-commands.js',
);
const CODEX_SYNC = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'sync-codex-skills.js',
);

/** Codex's skill-description limit. */
const CODEX_SKILL_DESCRIPTION_MAX = 1024;
const LONG = 'x'.repeat(CODEX_SKILL_DESCRIPTION_MAX + 200);

let root;

function write(rel, body) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

const wf = (description, body = 'WORKFLOW BODY TEXT\n') =>
  `---\ndescription: >-\n  ${description}\n---\n\n# Title\n\n${body}`;

function skillsDir() {
  return path.join(root, ...CODEX_SKILLS_DIR.split('/'));
}

function readSkill(name) {
  return fs.readFileSync(path.join(skillsDir(), name, 'SKILL.md'), 'utf8');
}

function frontmatter(text) {
  return yaml.load(/^---\n([\s\S]*?)\n---/.exec(text)[1]);
}

function run(script = CLAUDE_SYNC) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^SYNC_(CLAUDE|CODEX)_/.test(key)) delete env[key];
  }
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

beforeEach(() => {
  root = makeTempDir('sync-codex-skills-');
  write('.agents/workflows/alpha.md', wf('Alpha does: the "first" thing.'));
  write('.agents/workflows/long.md', wf(LONG));
  write(
    '.agents/workflows/hidden.md',
    '---\ndescription: x\ncommand: false\n---\n',
  );
  write('.agents/workflows/helpers/helper.md', wf('helper'));
  write('.agents/workflows/loops/tick.md', wf('A loop unit.'));
  write('.agents/workflows/loops/README.md', '# loops\n');
  write('.agents/local/workflows/gamma.md', wf('Local gamma.'));
  write('.agents/local/workflows/alpha.md', wf('Shadowed local alpha.'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('codex skill projection — the command entry point writes both hosts', () => {
  it('projects one skill per projectable workflow beside .claude/commands/', () => {
    run();
    assert.deepEqual(fs.readdirSync(skillsDir()).sort(), [
      'alpha',
      'gamma',
      'long',
      'loops-tick',
    ]);
    assert.ok(
      fs.existsSync(path.join(root, '.claude', 'commands', 'alpha.md')),
    );
  });

  it('carries name + workflow description front-matter and a pointer body', () => {
    run();
    const text = readSkill('alpha');
    const fm = frontmatter(text);
    assert.equal(fm.name, 'alpha');
    assert.equal(fm.description, 'Alpha does: the "first" thing.');
    assert.ok(text.includes('`.agents/workflows/alpha.md`'));
    assert.ok(text.includes('`$alpha`'));
    assert.ok(text.includes('ARGUMENTS'));
    assert.equal(text.includes('WORKFLOW BODY TEXT'), false, 'never a copy');
  });

  it('points local and loop skills at their own source paths', () => {
    run();
    assert.ok(
      readSkill('gamma').includes('`.agents/local/workflows/gamma.md`'),
    );
    assert.equal(frontmatter(readSkill('loops-tick')).name, 'loops-tick');
    assert.ok(
      readSkill('loops-tick').includes('`.agents/workflows/loops/tick.md`'),
    );
  });

  it("cuts a description to Codex's 1024-character limit", () => {
    run();
    const { description } = frontmatter(readSkill('long'));
    assert.equal(description.length, CODEX_SKILL_DESCRIPTION_MAX);
  });

  it('a second run changes nothing', () => {
    run();
    const before = readSkill('alpha');
    const mtime = fs.statSync(
      path.join(skillsDir(), 'alpha', 'SKILL.md'),
    ).mtimeMs;
    const second = run();
    assert.match(second.stdout, /0 file\(s\) synced, 4 total Codex skills/);
    assert.equal(readSkill('alpha'), before);
    assert.equal(
      fs.statSync(path.join(skillsDir(), 'alpha', 'SKILL.md')).mtimeMs,
      mtime,
    );
  });

  it("reaps a removed workflow's skill and leaves unmarked directories alone", () => {
    run();
    write(`${CODEX_SKILLS_DIR}/mine/SKILL.md`, '---\nname: mine\n---\n');
    fs.rmSync(path.join(root, '.agents', 'local', 'workflows', 'gamma.md'));
    run();
    assert.equal(fs.existsSync(path.join(skillsDir(), 'gamma')), false);
    assert.ok(fs.existsSync(path.join(skillsDir(), 'mine', 'SKILL.md')));
  });

  it('fails loudly when a projected name equals a payload skill name', () => {
    write(
      '.agents/skills/core/process/alpha/SKILL.md',
      '---\nname: alpha\n---\n',
    );
    const result = spawnSync(process.execPath, [CLAUDE_SYNC], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /collides with the skill of the same name/);
  });

  it('stays outside the skills index walk', () => {
    run();
    write(
      '.agents/skills/core/process/real/SKILL.md',
      '---\nname: real\n---\n',
    );
    const indexed = collectSkillFiles(root).map((f) =>
      path.relative(root, f).split(path.sep).join('/'),
    );
    assert.deepEqual(indexed, ['.agents/skills/core/process/real/SKILL.md']);
  });

  it('the standalone entry point writes the same projection', () => {
    run(CODEX_SYNC);
    assert.deepEqual(fs.readdirSync(skillsDir()).sort(), [
      'alpha',
      'gamma',
      'long',
      'loops-tick',
    ]);
  });

  it('`mandrel sync-commands` produces the Codex skills too', () => {
    const result = spawnSync(process.execPath, [BIN, 'sync-commands'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(skillsDir(), 'alpha', 'SKILL.md')));
  });

  it('a fixture DEST override skips the Codex half unless it is named', () => {
    const dest = path.join(root, 'claude-out');
    const result = spawnSync(process.execPath, [CLAUDE_SYNC], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, SYNC_CLAUDE_COMMANDS_DEST: dest },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(skillsDir()), false);
  });
});

describe('codex skill projection — expected set', () => {
  it('payload wins a name collision and command:false is skipped', () => {
    const expected = expectedCodexSkills({ projectRoot: root });
    assert.deepEqual(
      [...expected.keys()],
      ['alpha', 'gamma', 'long', 'loops-tick'],
    );
    assert.ok(expected.get('alpha').includes('`.agents/workflows/alpha.md`'));
    assert.equal(expected.get('alpha').includes('.agents/local/'), false);
  });

  it('a workflow with no description still gets a valid one', () => {
    write('.agents/workflows/bare.md', '# Bare\n');
    const fm = frontmatter(
      expectedCodexSkills({ projectRoot: root }).get('bare'),
    );
    assert.equal(fm.name, 'bare');
    assert.ok(fm.description.length > 0);
  });
});
