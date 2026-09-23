/**
 * Story #5410 — `claude-code-version` doctor check: fails an AGENTS.md-only
 * project on a Claude Code host below the AGENTS.md floor; skips (ok) when
 * `claude` is absent, its output is unparseable, or CLAUDE.md is present.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  CLAUDE_CODE_AGENTS_MD_FLOOR,
  parseClaudeVersion,
  runClaudeCodeVersion,
} from '../../lib/cli/claude-code-version.js';
import { registry } from '../../lib/cli/registry.js';

const ROOT = '/proj';

function project(files) {
  const present = new Set(files.map((f) => path.join(ROOT, f)));
  return (p) => present.has(p);
}

const claudeSays =
  (stdout, status = 0) =>
  () => ({ status, stdout });

describe('claude-code-version', () => {
  it('pins the floor at 2.1.277', () => {
    assert.equal(CLAUDE_CODE_AGENTS_MD_FLOOR, '2.1.277');
  });

  it('fails with an upgrade remedy below the floor on an AGENTS.md-only project', () => {
    const r = runClaudeCodeVersion({
      projectRoot: ROOT,
      existsSync: project(['AGENTS.md']),
      runClaude: claudeSays('2.1.276 (Claude Code)\n'),
    });
    assert.equal(r.ok, false);
    assert.match(r.remedy, /Upgrade Claude Code/);
    assert.match(r.remedy, /2\.1\.277/);
  });

  it('passes at or above the floor', () => {
    const r = runClaudeCodeVersion({
      projectRoot: ROOT,
      existsSync: project(['AGENTS.md']),
      runClaude: claudeSays('2.1.277 (Claude Code)\n'),
    });
    assert.equal(r.ok, true);
    assert.equal(r.remedy, undefined);
  });

  it('skips when claude is not on PATH', () => {
    const r = runClaudeCodeVersion({
      projectRoot: ROOT,
      existsSync: project(['AGENTS.md']),
      runClaude: () => ({
        status: null,
        stdout: '',
        error: Object.assign(new Error('x'), { code: 'ENOENT' }),
      }),
    });
    assert.equal(r.ok, true);
    assert.match(r.detail, /skipped: claude not found/);
  });

  it('skips on unparseable output', () => {
    const r = runClaudeCodeVersion({
      projectRoot: ROOT,
      existsSync: project(['AGENTS.md']),
      runClaude: claudeSays('garbage\n'),
    });
    assert.equal(r.ok, true);
    assert.match(r.detail, /skipped: unparseable/);
  });

  it('skips when CLAUDE.md is present, without spawning claude', () => {
    let spawned = false;
    const r = runClaudeCodeVersion({
      projectRoot: ROOT,
      existsSync: project(['AGENTS.md', 'CLAUDE.md']),
      runClaude: () => {
        spawned = true;
        return { status: 0, stdout: '1.0.0' };
      },
    });
    assert.equal(r.ok, true);
    assert.match(r.detail, /skipped: CLAUDE\.md present/);
    assert.equal(spawned, false);
  });

  it('skips when the project has no AGENTS.md', () => {
    const r = runClaudeCodeVersion({
      projectRoot: ROOT,
      existsSync: project([]),
      runClaude: claudeSays('1.0.0'),
    });
    assert.equal(r.ok, true);
    assert.match(r.detail, /skipped: no AGENTS\.md/);
  });

  it('parses a leading semver, optionally v-prefixed', () => {
    assert.equal(parseClaudeVersion('v2.1.300 (Claude Code)'), '2.1.300');
    assert.equal(parseClaudeVersion('Claude 2.1.300'), null);
  });

  it('is registered as a fatal doctor check', () => {
    const entry = registry.find((c) => c.name === 'claude-code-version');
    assert.ok(entry);
    assert.ok(!entry.advisory);
  });
});
