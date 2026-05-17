/**
 * Unit tests for the story-init-not-backgrounded check.
 *
 * The check walks `.agents/` for orchestration files (workflow markdown
 * + scripts) that invoke `story-init.js` near a backgrounding token
 * (`run_in_background: true`, `Monitor`, or shell `&`). Each test writes
 * a fixture tree and points the check at it via `state.scanRoot`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import check from '../../../.agents/scripts/lib/checks/story-init-not-backgrounded.js';

function makeFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'story-init-bg-fixture-'));
  return {
    root,
    write(relPath, contents) {
      const full = path.join(root, relPath);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents, 'utf8');
    },
  };
}

let fixture;

describe('story-init-not-backgrounded.detect', () => {
  beforeEach(() => {
    fixture = makeFixtureRoot();
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('returns null for synchronous Bash(timeout) invocations of story-init.js', () => {
    fixture.write(
      'workflows/story-deliver.md',
      [
        '# /story-deliver',
        '',
        'Run story-init.js synchronously with the Bash tool:',
        '',
        '```bash',
        'node .agents/scripts/story-init.js --story <id>',
        '```',
        '',
        'Pass timeout: 600000 to the Bash call.',
      ].join('\n'),
    );
    fixture.write(
      'scripts/wave-runner.js',
      [
        '// Synchronous spawnSync — no Monitor, no backgrounding.',
        "spawnSync('node', ['.agents/scripts/story-init.js', '--story', id], {",
        '  timeout: 600_000,',
        '});',
      ].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.equal(finding, null);
  });

  it('returns a blocker finding when a workflow invokes story-init.js with run_in_background: true', () => {
    fixture.write(
      'workflows/bad-wave.md',
      [
        '# /bad-wave',
        '',
        'Fan out per-Story workers:',
        '',
        '```bash',
        'Bash(',
        '  run_in_background: true,',
        '  command: "node .agents/scripts/story-init.js --story 1234"',
        ')',
        '```',
        '',
        'Wait for completion via Monitor(...).',
      ].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.ok(finding, 'expected a finding');
    assert.equal(finding.id, 'story-init-not-backgrounded');
    assert.equal(finding.severity, 'blocker');
    assert.match(finding.detail, /bad-wave\.md/);
  });

  it('flags child_process.spawn with detached: true near a story-init reference', () => {
    fixture.write(
      'scripts/legacy-runner.js',
      [
        "import { spawn } from 'node:child_process';",
        '',
        "const child = spawn('node', ['.agents/scripts/story-init.js', '--story', id], {",
        '  detached: true,',
        '  stdio: "ignore",',
        '});',
        'child.unref();',
      ].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.ok(finding);
    assert.match(finding.detail, /legacy-runner\.js/);
  });

  it('flags shell-ampersand backgrounding (story-init.js &)', () => {
    fixture.write(
      'scripts/launcher.sh',
      [
        '#!/usr/bin/env bash',
        'node .agents/scripts/story-init.js --story 42 &',
        'wait $!',
      ].join('\n'),
    );
    // Note: .sh is not in our scan list, so we explicitly write a .md
    // documenting the same shell incantation — that's where it would
    // actually appear in the codebase (workflow docs).
    fixture.write(
      'workflows/shell-bg.md',
      [
        '# /shell-bg',
        '',
        '```bash',
        'node .agents/scripts/story-init.js --story 42 &',
        '```',
      ].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.ok(finding);
    assert.match(finding.detail, /shell-bg\.md/);
  });

  it('does NOT flag narrative prose warning against Monitor backgrounding', () => {
    // The story-deliver.md workflow doc legitimately mentions both
    // story-init.js AND Monitor — but only as a warning against the
    // antipattern. The check must not false-positive here.
    fixture.write(
      'workflows/story-deliver.md',
      [
        '# /story-deliver',
        '',
        'Run story-init.js synchronously with Bash(timeout: 600000).',
        'Do **not** use run_in_background + Monitor here: Monitor will',
        'kill the script mid-batch if the sub-agent exits during the wait.',
      ].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.equal(finding, null);
  });

  it('emits a fixCommand with the synchronous-call replacement pattern', () => {
    fixture.write(
      'workflows/bad.md',
      ['run_in_background: true', 'story-init.js'].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.ok(finding);
    assert.match(finding.fixCommand, /Bash\(timeout/);
    assert.match(finding.fixCommand, /Do NOT use/);
  });

  it('does NOT flag the story-init.js implementation file itself', () => {
    // story-init.js references itself in its own JSDoc / logs.
    fixture.write(
      'scripts/story-init.js',
      [
        '// story-init.js — the script. Reference Monitor and',
        '// run_in_background: true in docs is fine; this file IS the',
        '// implementation being protected.',
        "console.log('story-init.js');",
      ].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.equal(finding, null);
  });
});
