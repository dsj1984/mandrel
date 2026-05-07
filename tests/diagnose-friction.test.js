/**
 * diagnose-friction.test.js — v5 / Epic #1030 Story #1042 Tests
 *
 * Tests the diagnose-friction.js script, which wraps commands and on
 * failure appends a structured `friction` signal to the per-Story
 * `temp/epic-<eid>/story-<sid>/signals.ndjson` stream via
 * `signals-writer.appendSignal`.
 *
 * Story #1042 cut the GitHub-comment side: there is no longer a
 * `postStructuredComment` call on the failure path. These tests verify:
 *   - The CLI contract (usage, exit-code passthrough, diagnostic banner).
 *   - On failure with `--story` + `--epic`, a `friction` signal is
 *     appended to the NDJSON stream with the expected `kind`/`category`/
 *     `source`/`details` payload shape.
 *   - The script never creates a local friction log file (v5 SSOT).
 *   - When story/epic context is unresolved, the script logs and skips the
 *     write (best-effort observability — never halt the runner).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(
  ROOT,
  '.agents',
  'scripts',
  'diagnose-friction.js',
);

let tmpRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'diagnose-friction-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function runScript(extraArgs, extraEnv = {}) {
  return spawnSync('node', [SCRIPT_PATH, ...extraArgs], {
    cwd: tmpRoot,
    encoding: 'utf-8',
    timeout: 15000,
    env: {
      ...process.env,
      GITHUB_TOKEN: 'fake-token-for-test',
      NO_NETWORK: '1',
      ...extraEnv,
    },
  });
}

describe('diagnose-friction.js — v5 (CLI contract)', () => {
  it('exits non-zero when --cmd is missing', () => {
    const result = runScript([]);
    assert.notEqual(result.status, 0, 'Should fail when --cmd is missing');
    const combined = (result.stdout ?? '') + (result.stderr ?? '');
    assert.ok(
      combined.includes('Usage:'),
      'Should print usage instructions when --cmd is missing',
    );
  });

  it('passes through the exit code of the wrapped command on success', () => {
    const result = runScript(['--task', '0', '--cmd', 'node', '--version']);
    assert.equal(
      result.status,
      0,
      'Should exit 0 when the wrapped command succeeds',
    );
  });

  it('passes through non-zero exit code of a failing wrapped command', () => {
    const result = runScript([
      '--task',
      '0',
      '--cmd',
      'node',
      '__nonexistent_script_guaranteed_to_fail__.js',
    ]);
    assert.notEqual(
      result.status,
      0,
      'Should not exit 0 when the wrapped command fails',
    );
  });

  it('prints diagnostic suggestions on failure', () => {
    const result = runScript([
      '--cmd',
      'node',
      '__nonexistent_script_guaranteed_to_fail__.js',
    ]);
    const combined = (result.stdout ?? '') + (result.stderr ?? '');
    assert.ok(
      combined.includes('DIAGNOSTIC ANALYSIS'),
      'Should print the diagnostic analysis banner on failure',
    );
    assert.ok(
      combined.includes('Auto-Remediation Suggestions'),
      'Should print auto-remediation suggestions on failure',
    );
  });
});

describe('diagnose-friction.js — appends friction signal to NDJSON', () => {
  it('appends a kind:friction record to signals.ndjson when story+epic are provided', () => {
    const result = runScript([
      '--task',
      '1057',
      '--story',
      '1042',
      '--epic',
      '1030',
      '--cmd',
      'node',
      '__nonexistent_script_guaranteed_to_fail__.js',
    ]);

    assert.notEqual(result.status, 0, 'wrapped command should fail');

    const ndjsonPath = path.join(
      tmpRoot,
      'temp',
      'epic-1030',
      'story-1042',
      'signals.ndjson',
    );
    const raw = readFileSync(ndjsonPath, 'utf-8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1, 'one friction signal should be appended');

    const signal = JSON.parse(lines[0]);
    assert.equal(signal.kind, 'friction', 'signal.kind must be "friction"');
    assert.equal(signal.epicId, 1030, 'signal.epicId carries the epic id');
    assert.equal(signal.storyId, 1042, 'signal.storyId carries the story id');
    assert.equal(signal.taskId, 1057, 'signal.taskId carries the task id');
    assert.ok(
      typeof signal.category === 'string' && signal.category.length > 0,
      'signal.category is set by the classifier',
    );
    assert.ok(
      signal.source && signal.source.tool === 'diagnose-friction.js',
      'signal.source.tool identifies the detector',
    );
    assert.ok(
      typeof signal.source.command === 'string' &&
        signal.source.command.length > 0,
      'signal.source.command captures the wrapped command',
    );
    assert.ok(
      typeof signal.details === 'string' && signal.details.length > 0,
      'signal.details captures the error preview',
    );
    assert.ok(
      typeof signal.eventId === 'string' && signal.eventId.length > 0,
      'signal.eventId is a UUID',
    );
    assert.ok(
      typeof signal.timestamp === 'string',
      'signal.timestamp is an ISO string',
    );
  });

  it('classifies "Cannot find module" as Missing Skill', () => {
    runScript([
      '--task',
      '1057',
      '--story',
      '1042',
      '--epic',
      '1030',
      '--cmd',
      'node',
      '__nonexistent_script_guaranteed_to_fail__.js',
    ]);
    const ndjsonPath = path.join(
      tmpRoot,
      'temp',
      'epic-1030',
      'story-1042',
      'signals.ndjson',
    );
    const signal = JSON.parse(readFileSync(ndjsonPath, 'utf-8').trim());
    assert.equal(
      signal.category,
      'Missing Skill',
      'Cannot find module → Missing Skill category',
    );
  });

  it('skips the signal write when story/epic context is unresolved', () => {
    const result = runScript([
      '--cmd',
      'node',
      '__nonexistent_script_guaranteed_to_fail__.js',
    ]);
    assert.notEqual(result.status, 0, 'wrapped command should fail');

    const stderr = result.stderr ?? '';
    assert.ok(
      stderr.includes('Skipping friction signal write') ||
        stderr.includes('story/epic context unresolved'),
      'Should log a skip message when context is unresolved',
    );
    // No NDJSON file should be created at all
    assert.throws(
      () =>
        readFileSync(
          path.join(
            tmpRoot,
            'temp',
            'epic-1030',
            'story-1042',
            'signals.ndjson',
          ),
          'utf-8',
        ),
      /ENOENT/,
      'No signals.ndjson should be written without context',
    );
  });

  it('does not call postStructuredComment / write GitHub friction comments', () => {
    // Smoke check: with NO_NETWORK=1 and no --task lookup, the v5/Epic#1030
    // detector path must not attempt any GitHub round-trip. The presence of
    // the NDJSON write (asserted in the first test) is the positive signal;
    // here we just confirm the script does not regress to printing the old
    // "Friction posted to Task #" line.
    const result = runScript([
      '--task',
      '1057',
      '--story',
      '1042',
      '--epic',
      '1030',
      '--cmd',
      'node',
      '__nonexistent_script_guaranteed_to_fail__.js',
    ]);
    const stderr = result.stderr ?? '';
    assert.ok(
      !stderr.includes('Friction posted to Task'),
      'must not print the legacy GitHub-comment success line',
    );
    assert.ok(
      !stderr.includes('postStructuredComment'),
      'must not reference postStructuredComment in failure paths',
    );
  });
});
