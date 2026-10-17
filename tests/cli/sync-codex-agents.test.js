/**
 * Codex custom-agent projection of the role set (Story #5655).
 *
 * The existing agent projection (`sync-claude-agents.js`, reached by
 * `mandrel sync-agents` and the bootstrap-seeded `npm run sync:agents`) also
 * writes `.codex/agents/mandrel-<role>.toml` for every `.agents/agents/*.md`.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse as parseToml } from 'smol-toml';

import {
  CODEX_AGENTS_DIR,
  expectedCodexAgents,
} from '../../.agents/scripts/lib/codex/agents-projection.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'mandrel.js');
const CLAUDE_SYNC = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'sync-claude-agents.js',
);
const CODEX_SYNC = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'sync-codex-agents.js',
);
const PAYLOAD_AGENTS = path.join(REPO_ROOT, '.agents', 'agents');
const SECURITY_BASELINE = path.join(
  REPO_ROOT,
  '.agents',
  'rules',
  'security-baseline.md',
);
const ROLES = fs
  .readdirSync(PAYLOAD_AGENTS)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.replace(/\.md$/, ''))
  .sort();

let root;

function agentsDir() {
  return path.join(root, ...CODEX_AGENTS_DIR.split('/'));
}

function readAgent(role) {
  return fs.readFileSync(
    path.join(agentsDir(), `mandrel-${role}.toml`),
    'utf8',
  );
}

function effortOf(role) {
  const source = fs.readFileSync(
    path.join(PAYLOAD_AGENTS, `${role}.md`),
    'utf8',
  );
  return /^---\n[\s\S]*?^effort:\s*(\S+)[\s\S]*?^---$/m.exec(source)?.[1];
}

function run(args = [CLAUDE_SYNC]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

beforeEach(() => {
  root = makeTempDir('sync-codex-agents-');
  fs.cpSync(PAYLOAD_AGENTS, path.join(root, '.agents', 'agents'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, '.agents', 'rules'), { recursive: true });
  fs.copyFileSync(
    SECURITY_BASELINE,
    path.join(root, '.agents', 'rules', 'security-baseline.md'),
  );
  fs.writeFileSync(
    path.join(root, '.agentrc.json'),
    JSON.stringify({
      project: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      },
    }),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('codex agent projection — the agent entry point writes both hosts', () => {
  it('writes one parseable mandrel-<role>.toml per role beside .claude/agents/', () => {
    run();
    assert.deepEqual(
      fs.readdirSync(agentsDir()).sort(),
      ROLES.map((r) => `mandrel-${r}.toml`),
    );
    for (const role of ROLES) {
      assert.ok(
        fs.existsSync(path.join(root, '.claude', 'agents', `${role}.md`)),
      );
      const parsed = parseToml(readAgent(role));
      assert.equal(parsed.name, role);
      assert.ok(parsed.description.length > 0);
      assert.ok(parsed.developer_instructions.length > 0);
      assert.equal('model' in parsed, false, `${role} must not carry model`);
    }
  });

  it('sets model_reasoning_effort only where the role declares effort', () => {
    run();
    for (const role of ROLES) {
      const parsed = parseToml(readAgent(role));
      const effort = effortOf(role);
      if (effort) assert.equal(parsed.model_reasoning_effort, effort);
      else assert.equal('model_reasoning_effort' in parsed, false, role);
    }
    assert.ok(
      ROLES.some((r) => !effortOf(r)),
      'fixture covers a role without effort',
    );
  });

  it('inlines the security baseline in place of its @ import', () => {
    run();
    const baseline = fs.readFileSync(SECURITY_BASELINE, 'utf8').trim();
    for (const role of ROLES) {
      const { developer_instructions: body } = parseToml(readAgent(role));
      assert.ok(body.includes(baseline), `${role} carries the baseline`);
      assert.equal(/^@\S+$/m.test(body), false, `${role} keeps no @ import`);
      assert.equal(body.startsWith('---'), false, 'front-matter is stripped');
    }
  });

  it('keeps consumer-authored Codex agents and reaps a removed role', () => {
    run();
    fs.writeFileSync(
      path.join(agentsDir(), 'reviewer.toml'),
      'name = "reviewer"\n',
    );
    fs.writeFileSync(
      path.join(agentsDir(), 'mandrel-mine.toml'),
      'name = "mine"\ndescription = "x"\ndeveloper_instructions = "y"\n',
    );
    fs.rmSync(path.join(root, '.agents', 'agents', 'auditor.md'));
    run();
    assert.equal(
      fs.existsSync(path.join(agentsDir(), 'mandrel-auditor.toml')),
      false,
    );
    assert.ok(fs.existsSync(path.join(agentsDir(), 'reviewer.toml')));
    assert.ok(fs.existsSync(path.join(agentsDir(), 'mandrel-mine.toml')));
  });

  it('a second run changes nothing', () => {
    run();
    const before = ROLES.map(readAgent);
    const second = run();
    assert.match(second.stdout, /0 file\(s\) synced, \d+ total Codex agents/);
    assert.deepEqual(ROLES.map(readAgent), before);
  });

  it('the standalone entry point writes the same projection', () => {
    const result = run([CODEX_SYNC]);
    assert.match(
      result.stdout,
      /\d+ file\(s\) synced, \d+ total agents in \.codex\/agents\//,
    );
    assert.deepEqual(
      fs.readdirSync(agentsDir()).sort(),
      ROLES.map((r) => `mandrel-${r}.toml`),
    );
    assert.equal(fs.existsSync(path.join(root, '.claude', 'agents')), false);
  });

  it('`mandrel sync-agents` produces the Codex agents too', () => {
    run([BIN, 'sync-agents']);
    assert.ok(
      fs.existsSync(path.join(agentsDir(), 'mandrel-story-worker.toml')),
    );
  });
});

describe('codex agent projection — TOML encoding', () => {
  const tricky = 'a "quote" \\ back\\slash """triple""" \u0001 ctl\ttab';

  it('description and body round-trip quotes, backslashes, triple quotes and control chars', () => {
    const local = path.join(root, '.agents', 'local', 'agents');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(
      path.join(local, 'tricky.md'),
      `---\ndescription: ${tricky}\n---\n\n${tricky}\n`,
    );
    const parsed = parseToml(
      expectedCodexAgents({ projectRoot: root }).get('mandrel-tricky.toml'),
    );
    assert.equal(parsed.name, 'tricky');
    assert.equal(parsed.developer_instructions, `${tricky}\n`);
    // extractDescription collapses whitespace runs, so the tab reads as a space.
    assert.equal(parsed.description, tricky.replace('\t', ' '));
  });
});
