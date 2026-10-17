/**
 * The Claude command projection module and its thin CLI (Story #5742).
 *
 *   - The module is injectable: `expectedClaudeCommands` / `syncClaudeCommands`
 *     take the project root, sources, destination and log sinks as arguments.
 *   - AC-1 snapshot: over the repository's own payload, the CLI writes exactly
 *     the bytes the pre-module script did — every projectable workflow,
 *     `applyHeader`-ed with the payload header — and the Codex half beside it.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  expectedClaudeCommands,
  listGeneratedClaudeCommands,
  syncClaudeCommands,
} from '../.agents/scripts/lib/claude/commands-projection.js';
import {
  CODEX_SKILLS_DIR,
  expectedCodexSkills,
} from '../.agents/scripts/lib/codex/skills-projection.js';
import { applyHeader } from '../.agents/scripts/lib/command-header.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'sync-claude-commands.js',
);
const WORKFLOWS = path.join(REPO_ROOT, '.agents', 'workflows');

// Pinned literally — the bytes every projected command opens its body with.
const PAYLOAD_HEADER =
  '<!-- AUTO-GENERATED — do not edit. Source of truth: .agents/workflows/ -->\n<!-- Re-run: npm run sync:commands -->\n\n';

/**
 * The pre-module projection rule, restated independently: top-level `*.md`
 * plus `loops/*.md` (minus README), skipping `command: false`.
 *
 * @param {string} src
 * @returns {Map<string, string>}
 */
function oracle(src) {
  const out = new Map();
  const add = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      if (prefix && e.name.toLowerCase() === 'readme.md') continue;
      const content = fs.readFileSync(path.join(dir, e.name), 'utf8');
      if (/^---\n[\s\S]*?^command:\s*false\s*$[\s\S]*?\n---\n/m.test(content)) {
        continue;
      }
      out.set(`${prefix}${e.name}`, applyHeader(content, PAYLOAD_HEADER));
    }
  };
  add(src, '');
  add(path.join(src, 'loops'), 'loops/');
  return out;
}

/**
 * @param {string} dir
 * @returns {Map<string, string>}
 */
function readTree(dir) {
  const out = new Map();
  for (const rel of listGeneratedClaudeCommands(dir)) {
    out.set(rel, fs.readFileSync(path.join(dir, rel), 'utf8'));
  }
  return out;
}

describe('commands-projection — injectable module', () => {
  it('projects from argument sources into an argument destination', () => {
    const root = makeTempDir('cmd-proj-');
    const payloadSrc = path.join(root, 'src');
    const localSrc = path.join(root, 'local');
    fs.mkdirSync(path.join(payloadSrc, 'loops'), { recursive: true });
    fs.mkdirSync(localSrc, { recursive: true });
    fs.writeFileSync(path.join(payloadSrc, 'a.md'), '# a\n');
    fs.writeFileSync(path.join(payloadSrc, 'loops', 'tick.md'), '# tick\n');
    fs.writeFileSync(path.join(localSrc, 'a.md'), '# shadowed\n');
    fs.writeFileSync(path.join(localSrc, 'b.md'), '# b\n');
    const destDir = path.join(root, 'out');
    const lines = [];
    const warnings = [];

    const result = syncClaudeCommands({
      projectRoot: root,
      payloadSrc,
      localSrc,
      destDir,
      log: (l) => lines.push(l),
      warn: (l) => warnings.push(l),
    });

    assert.deepEqual(result.written.sort(), ['a.md', 'b.md', 'loops/tick.md']);
    assert.deepEqual(result.removed, []);
    assert.equal(result.total, 3);
    assert.match(fs.readFileSync(path.join(destDir, 'a.md'), 'utf8'), /# a/);
    assert.match(
      fs.readFileSync(path.join(destDir, 'b.md'), 'utf8'),
      /AUTO-GENERATED from \.agents\/local\//,
    );
    assert.ok(warnings.some((w) => /shadowed\s+a\.md/.test(w)));
    assert.equal(lines.filter((l) => /synced/.test(l)).length, 3);

    const again = syncClaudeCommands({
      projectRoot: root,
      payloadSrc,
      localSrc,
      destDir,
    });
    assert.deepEqual(again.written, [], 'a second run writes nothing');
  });

  it('reaps the on-disk plugin tree under the project root', () => {
    const root = makeTempDir('cmd-proj-reap-');
    const plugin = path.join(root, '.claude', 'plugins', 'mandrel', 'x.md');
    const market = path.join(
      root,
      '.claude',
      '.claude-plugin',
      'marketplace.json',
    );
    for (const f of [plugin, market]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, 'x');
    }
    syncClaudeCommands({ projectRoot: root });
    assert.equal(fs.existsSync(path.dirname(plugin)), false);
    assert.equal(fs.existsSync(path.dirname(market)), false);
  });
});

describe('commands-projection — AC-1 snapshot over the repository payload', () => {
  it('the expected set equals the pre-module projection rule', () => {
    const expected = expectedClaudeCommands({
      projectRoot: REPO_ROOT,
      localSrc: path.join(makeTempDir('no-local-'), 'absent'),
    });
    assert.deepEqual(
      [...expected.entries()].sort(),
      [...oracle(WORKFLOWS).entries()].sort(),
    );
  });

  it('the CLI writes those bytes, and the Codex skills beside them', () => {
    const root = makeTempDir('cmd-proj-cli-');
    fs.cpSync(WORKFLOWS, path.join(root, '.agents', 'workflows'), {
      recursive: true,
    });
    const result = spawnSync(process.execPath, [CLI], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);

    const claude = readTree(path.join(root, '.claude', 'commands'));
    assert.deepEqual(
      [...claude.entries()].sort(),
      [...oracle(path.join(root, '.agents', 'workflows')).entries()].sort(),
    );

    const skillsDir = path.join(root, ...CODEX_SKILLS_DIR.split('/'));
    for (const [name, body] of expectedCodexSkills({ projectRoot: root })) {
      assert.equal(
        fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8'),
        body,
        `Codex skill ${name}`,
      );
    }
  });
});
