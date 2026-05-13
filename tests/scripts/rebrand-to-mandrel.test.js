import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DENY_LIST, isDenied } from '../../.agents/scripts/lib/rebrand-deny.js';
import {
  classify,
  listTrackedFiles,
  parseArgs,
  rebrandString,
  run,
} from '../../.agents/scripts/rebrand-to-mandrel.js';

/**
 * Unit tests for the Story #1604 rebrand sweep CLI.
 *
 * Coverage:
 *   - Case-preserving replacement (3 variants).
 *   - Idempotence (second pass produces no diff).
 *   - Deny-list enforcement.
 *   - `git ls-files` is the enumeration source (untracked files ignored).
 *   - Binary files are skipped.
 */

describe('rebrand-deny — deny-list', () => {
  it('exposes a non-empty frozen list', () => {
    assert.ok(Array.isArray(DENY_LIST));
    assert.ok(DENY_LIST.length > 0);
    assert.ok(Object.isFrozen(DENY_LIST));
  });

  it('protects CHANGELOG history', () => {
    assert.equal(isDenied('docs/CHANGELOG.md'), true);
    assert.equal(isDenied('docs/archive/CHANGELOG-v4.md'), true);
    assert.equal(isDenied('docs/archive/'), true);
  });

  it('protects the v6 migration guide', () => {
    assert.equal(isDenied('docs/migration-v6.md'), true);
  });

  it('protects the script + deny-list + test self-references', () => {
    assert.equal(isDenied('.agents/scripts/rebrand-to-mandrel.js'), true);
    assert.equal(isDenied('.agents/scripts/lib/rebrand-deny.js'), true);
    assert.equal(isDenied('tests/scripts/rebrand-to-mandrel.test.js'), true);
  });

  it('protects package-lock.json (regenerated from package.json)', () => {
    assert.equal(isDenied('package-lock.json'), true);
  });

  it('does not deny ordinary source files', () => {
    assert.equal(isDenied('package.json'), false);
    assert.equal(isDenied('README.md'), false);
    assert.equal(isDenied('AGENTS.md'), false);
    assert.equal(isDenied('docs/architecture.md'), false);
  });

  it('normalises Windows-style backslashes', () => {
    assert.equal(isDenied('docs\\archive\\CHANGELOG-v4.md'), true);
  });
});

describe('rebrand-to-mandrel — rebrandString (case-preserving)', () => {
  it('rewrites Title Case "Agent Protocols" → "Mandrel"', () => {
    const { next, counts } = rebrandString('Welcome to Agent Protocols.');
    assert.equal(next, 'Welcome to Mandrel.');
    assert.equal(counts['Agent Protocols'], 1);
  });

  it('rewrites kebab-case "agent-protocols" → "mandrel"', () => {
    const { next, counts } = rebrandString(
      'git clone https://github.com/dsj1984/agent-protocols.git',
    );
    assert.equal(next, 'git clone https://github.com/dsj1984/mandrel.git');
    assert.equal(counts['agent-protocols'], 1);
  });

  it('rewrites SCREAMING_SNAKE "AGENT_PROTOCOLS" → "MANDREL"', () => {
    const { next, counts } = rebrandString('export AGENT_PROTOCOLS_HOME=/x');
    assert.equal(next, 'export MANDREL_HOME=/x');
    assert.equal(counts['AGENT_PROTOCOLS'], 1);
  });

  it('handles all three variants in a single string', () => {
    const src = [
      '# Agent Protocols',
      'name: agent-protocols',
      'env: AGENT_PROTOCOLS',
    ].join('\n');
    const { next, counts } = rebrandString(src);
    assert.equal(
      next,
      ['# Mandrel', 'name: mandrel', 'env: MANDREL'].join('\n'),
    );
    assert.equal(counts['Agent Protocols'], 1);
    assert.equal(counts['agent-protocols'], 1);
    assert.equal(counts['AGENT_PROTOCOLS'], 1);
  });

  it('is idempotent — a second pass on rebranded text is a no-op', () => {
    const src = 'Agent Protocols and agent-protocols and AGENT_PROTOCOLS';
    const first = rebrandString(src).next;
    const second = rebrandString(first);
    assert.equal(second.next, first);
    assert.equal(Object.keys(second.counts).length, 0);
  });

  it('does not touch the dot-prefixed forms .agents/ and .agentrc.json', () => {
    const src = 'See .agents/scripts/ and .agentrc.json for runtime config.';
    const { next, counts } = rebrandString(src);
    assert.equal(next, src);
    assert.equal(Object.keys(counts).length, 0);
  });

  it('preserves surrounding punctuation and casing of neighbours', () => {
    const src = '"agent-protocols/scripts" and (Agent Protocols)';
    const { next } = rebrandString(src);
    assert.equal(next, '"mandrel/scripts" and (Mandrel)');
  });
});

describe('rebrand-to-mandrel — parseArgs', () => {
  it('defaults to cwd + dryRun=false', () => {
    const out = parseArgs([]);
    assert.equal(out.dryRun, false);
    assert.equal(typeof out.root, 'string');
  });

  it('recognises --dry-run', () => {
    const out = parseArgs(['--dry-run']);
    assert.equal(out.dryRun, true);
  });

  it('recognises --root <path> and --root=<path>', () => {
    assert.equal(parseArgs(['--root', '/tmp/x']).root, '/tmp/x');
    assert.equal(parseArgs(['--root=/tmp/y']).root, '/tmp/y');
  });
});

describe('rebrand-to-mandrel — run() against a temp git repo', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rebrand-test-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmpRoot });
    execFileSync('git', ['config', 'user.email', 't@e'], { cwd: tmpRoot });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: tmpRoot });
  });

  afterEach(() => {
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  /**
   * Helper: write `rel` with `content`, then `git add` it (without
   * committing — `git ls-files` includes staged-but-uncommitted files).
   */
  function writeTracked(rel, content) {
    const abs = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    execFileSync('git', ['add', '--', rel], { cwd: tmpRoot });
  }

  it('rewrites tracked files and reports the envelope', () => {
    writeTracked('package.json', '{"name":"agent-protocols"}\n');
    writeTracked('README.md', '# Agent Protocols\n');
    writeTracked('lib/env.js', 'export const AGENT_PROTOCOLS = 1;\n');

    const result = run({ root: tmpRoot, dryRun: false });
    assert.equal(result.ok, true);
    assert.equal(result.changed, 3);
    assert.equal(result.replacements['Agent Protocols'], 1);
    assert.equal(result.replacements['agent-protocols'], 1);
    assert.equal(result.replacements['AGENT_PROTOCOLS'], 1);

    assert.equal(
      fs.readFileSync(path.join(tmpRoot, 'package.json'), 'utf8'),
      '{"name":"mandrel"}\n',
    );
    assert.equal(
      fs.readFileSync(path.join(tmpRoot, 'README.md'), 'utf8'),
      '# Mandrel\n',
    );
    assert.equal(
      fs.readFileSync(path.join(tmpRoot, 'lib/env.js'), 'utf8'),
      'export const MANDREL = 1;\n',
    );
  });

  it('is idempotent — second invocation produces empty diff', () => {
    writeTracked('README.md', '# Agent Protocols\n');
    const first = run({ root: tmpRoot, dryRun: false });
    assert.equal(first.changed, 1);
    const second = run({ root: tmpRoot, dryRun: false });
    assert.equal(second.changed, 0);
    assert.equal(Object.keys(second.replacements).length, 0);
  });

  it('skips untracked files (git ls-files boundary)', () => {
    writeTracked('tracked.md', '# Agent Protocols\n');
    // Write an untracked file with the same content; it must not be
    // touched by the script.
    fs.writeFileSync(
      path.join(tmpRoot, 'untracked.md'),
      '# Agent Protocols\n',
      'utf8',
    );
    const result = run({ root: tmpRoot, dryRun: false });
    assert.equal(result.changed, 1);
    assert.equal(
      fs.readFileSync(path.join(tmpRoot, 'untracked.md'), 'utf8'),
      '# Agent Protocols\n',
    );
  });

  it('respects the deny-list (CHANGELOG history untouched)', () => {
    writeTracked('docs/CHANGELOG.md', '# Agent Protocols v5\n');
    writeTracked('docs/archive/CHANGELOG-v4.md', '# Agent Protocols v4\n');
    writeTracked('docs/migration-v6.md', '# Agent Protocols migration\n');
    writeTracked('README.md', '# Agent Protocols\n');

    const result = run({ root: tmpRoot, dryRun: false });
    assert.equal(result.changed, 1);
    assert.equal(result.denied, 3);
    assert.equal(
      fs.readFileSync(path.join(tmpRoot, 'docs/CHANGELOG.md'), 'utf8'),
      '# Agent Protocols v5\n',
    );
    assert.equal(
      fs.readFileSync(
        path.join(tmpRoot, 'docs/archive/CHANGELOG-v4.md'),
        'utf8',
      ),
      '# Agent Protocols v4\n',
    );
    assert.equal(
      fs.readFileSync(path.join(tmpRoot, 'docs/migration-v6.md'), 'utf8'),
      '# Agent Protocols migration\n',
    );
  });

  it('--dry-run reports counts but writes nothing', () => {
    writeTracked('README.md', '# Agent Protocols\n');
    const result = run({ root: tmpRoot, dryRun: true });
    assert.equal(result.changed, 1);
    assert.equal(result.dryRun, true);
    assert.equal(
      fs.readFileSync(path.join(tmpRoot, 'README.md'), 'utf8'),
      '# Agent Protocols\n',
    );
  });

  it('skips binary files (NUL byte detection)', () => {
    writeTracked('README.md', '# Agent Protocols\n');
    const binPath = path.join(tmpRoot, 'asset.bin');
    fs.writeFileSync(
      binPath,
      Buffer.concat([
        Buffer.from('Agent Protocols'),
        Buffer.from([0x00, 0x01, 0x02]),
      ]),
    );
    execFileSync('git', ['add', '--', 'asset.bin'], { cwd: tmpRoot });
    const result = run({ root: tmpRoot, dryRun: false });
    assert.equal(result.changed, 1);
    assert.equal(result.skippedBinary, 1);
    const after = fs.readFileSync(binPath);
    assert.ok(after.includes(Buffer.from('Agent Protocols')));
  });

  it('listTrackedFiles returns POSIX-normalised paths', () => {
    writeTracked('docs/architecture.md', '# x\n');
    const files = listTrackedFiles(tmpRoot);
    assert.ok(files.includes('docs/architecture.md'));
    for (const f of files) {
      assert.ok(!f.includes('\\'), `unexpected backslash in ${f}`);
    }
  });

  it('classify() flags denied paths without opening the file', () => {
    const abs = path.join(tmpRoot, 'docs/CHANGELOG.md');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '# x', 'utf8');
    const result = classify('docs/CHANGELOG.md', abs);
    assert.equal(result.skip, true);
    assert.equal(result.reason, 'denied');
  });
});
