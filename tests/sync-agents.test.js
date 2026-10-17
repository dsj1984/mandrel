/**
 * The Claude agent projection module and its thin CLI (Story #5742).
 *
 *   - The module is injectable: `expectedClaudeAgents` / `syncClaudeAgents`
 *     take the project root, sources, destination, `agentModels` and log
 *     sinks as arguments.
 *   - AC-1 snapshot: over the repository's own role files, the CLI writes
 *     exactly the bytes the pre-module script did — each role
 *     `applyHeader`-ed with the payload header — and the Codex agents beside.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  expectedClaudeAgents,
  listGeneratedClaudeAgents,
  syncClaudeAgents,
} from '../.agents/scripts/lib/claude/agents-projection.js';
import {
  CODEX_AGENTS_DIR,
  expectedCodexAgents,
} from '../.agents/scripts/lib/codex/agents-projection.js';
import { applyHeader } from '../.agents/scripts/lib/command-header.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, '.agents', 'scripts', 'sync-claude-agents.js');
const AGENTS = path.join(REPO_ROOT, '.agents', 'agents');

// Pinned literally — the bytes every projected agent opens its body with.
const PAYLOAD_HEADER =
  '<!-- AUTO-GENERATED — do not edit. Source of truth: .agents/agents/ -->\n<!-- Re-run: npm run sync:agents -->\n\n';

const ROLE = (model) =>
  `---\nname: worker\nmodel: ${model}\n---\n\n# Worker body\n`;

/**
 * @param {string} src
 * @returns {Map<string, string>}
 */
function oracle(src) {
  const out = new Map();
  for (const f of fs.readdirSync(src).filter((n) => n.endsWith('.md'))) {
    out.set(
      f,
      applyHeader(fs.readFileSync(path.join(src, f), 'utf8'), PAYLOAD_HEADER),
    );
  }
  return out;
}

/**
 * A fixture project root carrying the shipped role files, the rule their `@`
 * import names (the Codex half inlines it) and a minimal config.
 *
 * @returns {string}
 */
function fixtureProject() {
  const root = makeTempDir('agents-proj-cli-');
  fs.cpSync(AGENTS, path.join(root, '.agents', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'rules'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, '.agents', 'rules', 'security-baseline.md'),
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
  return root;
}

describe('agents-projection — injectable module', () => {
  it('projects from argument sources, applies agentModels, reaps orphans', () => {
    const root = makeTempDir('agents-proj-');
    const payloadSrc = path.join(root, 'src');
    const localSrc = path.join(root, 'local');
    const destDir = path.join(root, 'out');
    fs.mkdirSync(payloadSrc, { recursive: true });
    fs.mkdirSync(localSrc, { recursive: true });
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(payloadSrc, 'story-worker.md'), ROLE('inherit'));
    fs.writeFileSync(path.join(localSrc, 'story-worker.md'), ROLE('opus'));
    fs.writeFileSync(path.join(localSrc, 'mine.md'), ROLE('inherit'));
    fs.writeFileSync(path.join(destDir, 'gone.md'), '# orphan\n');
    const warnings = [];

    const result = syncClaudeAgents({
      projectRoot: root,
      payloadSrc,
      localSrc,
      destDir,
      agentModels: { 'story-worker': 'sonnet' },
      warn: (l) => warnings.push(l),
    });

    assert.deepEqual(result.written.sort(), ['mine.md', 'story-worker.md']);
    assert.deepEqual(result.removed, ['gone.md']);
    assert.equal(result.total, 2);
    assert.deepEqual(listGeneratedClaudeAgents(destDir), [
      'mine.md',
      'story-worker.md',
    ]);
    const worker = fs.readFileSync(
      path.join(destDir, 'story-worker.md'),
      'utf8',
    );
    assert.match(worker, /^model: sonnet$/m);
    assert.doesNotMatch(worker, /opus/, 'payload wins the collision');
    assert.ok(warnings.some((w) => /shadowed\s+story-worker\.md/.test(w)));
    assert.match(
      fs.readFileSync(path.join(destDir, 'mine.md'), 'utf8'),
      /AUTO-GENERATED from \.agents\/local\//,
    );
  });

  it('defaults agentModels to the project config, local merged over base', () => {
    const root = makeTempDir('agents-proj-models-');
    const src = path.join(root, '.agents', 'agents');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'auditor.md'), ROLE('sonnet'));
    fs.writeFileSync(path.join(src, 'plan-critic.md'), ROLE('inherit'));
    const models = (m) =>
      JSON.stringify({ delivery: { routing: { agentModels: m } } });
    fs.writeFileSync(
      path.join(root, '.agentrc.json'),
      models({ auditor: 'haiku', 'plan-critic': 'opus' }),
    );
    fs.writeFileSync(
      path.join(root, '.agentrc.local.json'),
      models({ auditor: 'sonnet' }),
    );
    const expected = expectedClaudeAgents({ projectRoot: root });
    assert.match(expected.get('auditor.md'), /^model: sonnet$/m);
    assert.match(expected.get('plan-critic.md'), /^model: opus$/m);
  });
});

describe('agents-projection — AC-1 snapshot over the repository role files', () => {
  it('the expected set equals the pre-module projection rule', () => {
    const expected = expectedClaudeAgents({
      projectRoot: REPO_ROOT,
      localSrc: path.join(makeTempDir('no-local-'), 'absent'),
      agentModels: {},
    });
    assert.deepEqual(
      [...expected.entries()].sort(),
      [...oracle(AGENTS).entries()].sort(),
    );
  });

  it('the CLI writes those bytes, and the Codex agents beside them', () => {
    const root = fixtureProject();
    const result = spawnSync(process.execPath, [CLI], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);

    const dest = path.join(root, '.claude', 'agents');
    const written = new Map(
      listGeneratedClaudeAgents(dest).map((f) => [
        f,
        fs.readFileSync(path.join(dest, f), 'utf8'),
      ]),
    );
    assert.deepEqual(
      [...written.entries()].sort(),
      [...oracle(AGENTS).entries()].sort(),
    );

    const codexDir = path.join(root, ...CODEX_AGENTS_DIR.split('/'));
    for (const [name, body] of expectedCodexAgents({ projectRoot: root })) {
      assert.equal(
        fs.readFileSync(path.join(codexDir, name), 'utf8'),
        body,
        `Codex agent ${name}`,
      );
    }
  });
});
