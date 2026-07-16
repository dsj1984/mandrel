import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  clearRegistryCache,
  runChecks,
} from '../../.agents/scripts/lib/checks/index.js';
import check, {
  detectLoopHealth,
  findSignalStreams,
  readRejectTally,
  resolveEpicTempTree,
  sampleStreamInvalidCount,
  scanRetroMirror,
} from '../../.agents/scripts/lib/checks/loop-health.js';

/**
 * Unit tests for the loop-health retro check. Drives `detectLoopHealth`
 * against real on-disk fixture temp trees (mkdtemp) so the sampler,
 * reject-tally reader, and retro-mirror scanner exercise their real fs seams.
 */

const VALID = (ts) => JSON.stringify({ kind: 'friction', ts });
const INVALID_ENUM = (ts) => JSON.stringify({ kind: 'not-a-kind', ts });
const MISSING_KIND = (ts) => JSON.stringify({ ts });

let root;

function writeStream(epicDir, relParts, lines) {
  const target = path.join(epicDir, ...relParts);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'loop-health-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loop-health check — contract metadata', () => {
  it('declares a read-only retro-scoped check', () => {
    assert.equal(check.id, 'loop-health');
    assert.equal(check.severity, 'warning');
    assert.equal(check.autoCorrect, 'refuse-and-print');
    assert.deepEqual(check.scope, ['retro']);
    assert.equal(typeof check.detect, 'function');
  });
});

describe('resolveEpicTempTree', () => {
  it('returns null when no temp tree exists', () => {
    assert.equal(resolveEpicTempTree(root), null);
  });

  it('locates the most recently touched run-<id> tree', () => {
    const older = path.join(root, 'temp', 'run-100');
    const newer = path.join(root, 'temp', 'run-200');
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    // Stamp explicit mtimes so the "most recently touched" ordering is
    // deterministic. Relying on wall-clock mtime between two dirs created
    // microseconds apart is non-deterministic on CI filesystems with coarse
    // mtime granularity (both land in one tick, and resolveEpicTempTree's
    // strict `>` tie-break then picks the readdir-first entry, run-100).
    utimesSync(older, new Date(1_000_000), new Date(1_000_000));
    utimesSync(newer, new Date(2_000_000), new Date(2_000_000));
    const tree = resolveEpicTempTree(root);
    assert.ok(tree);
    assert.equal(tree.epicId, 200);
    assert.equal(tree.epicDir, newer);
  });
});

describe('sampleStreamInvalidCount', () => {
  it('counts schema-invalid and unparseable lines within the tail window', () => {
    const dir = path.join(root, 'temp', 'run-1', 'stories', 'story-2');
    mkdirSync(dir, { recursive: true });
    const stream = path.join(dir, 'signals.ndjson');
    writeFileSync(
      stream,
      `${[
        VALID('2026-07-10T00:00:00Z'),
        INVALID_ENUM('2026-07-10T00:00:01Z'),
        'this is not json',
        MISSING_KIND('2026-07-10T00:00:02Z'),
      ].join('\n')}\n`,
      'utf8',
    );
    const { sampled, invalid } = sampleStreamInvalidCount(stream);
    assert.equal(sampled, 4);
    assert.equal(invalid, 3);
  });

  it('only samples the most recent maxLines', () => {
    const dir = path.join(root, 'temp', 'run-1');
    mkdirSync(dir, { recursive: true });
    const stream = path.join(dir, 'signals.ndjson');
    const lines = [];
    // 3 invalid at the head (should be excluded by the tail window)…
    for (let i = 0; i < 3; i += 1) lines.push('garbage');
    // …then 2 valid within the window.
    lines.push(VALID('2026-07-10T00:00:00Z'));
    lines.push(VALID('2026-07-10T00:00:01Z'));
    writeFileSync(stream, `${lines.join('\n')}\n`, 'utf8');
    const { sampled, invalid } = sampleStreamInvalidCount(stream, {
      maxLines: 2,
    });
    assert.equal(sampled, 2);
    assert.equal(invalid, 0);
  });

  it('treats a missing stream as zero, not invalid', () => {
    const { sampled, invalid } = sampleStreamInvalidCount(
      path.join(root, 'nope.ndjson'),
    );
    assert.equal(sampled, 0);
    assert.equal(invalid, 0);
  });
});

describe('findSignalStreams', () => {
  it('collects the run-level and every per-story stream', () => {
    const epicDir = path.join(root, 'temp', 'run-9');
    writeStream(epicDir, ['signals.ndjson'], [VALID('2026-07-10T00:00:00Z')]);
    writeStream(
      epicDir,
      ['stories', 'story-1', 'signals.ndjson'],
      [VALID('2026-07-10T00:00:00Z')],
    );
    writeStream(
      epicDir,
      ['stories', 'story-2', 'signals.ndjson'],
      [VALID('2026-07-10T00:00:00Z')],
    );
    const streams = findSignalStreams(epicDir);
    assert.equal(streams.length, 3);
  });
});

describe('readRejectTally', () => {
  it('reads the persisted count', () => {
    const epicDir = path.join(root, 'temp', 'run-3');
    mkdirSync(epicDir, { recursive: true });
    writeFileSync(
      path.join(epicDir, 'signal-rejects.json'),
      JSON.stringify({ count: 7, lastField: 'kind' }),
      'utf8',
    );
    assert.equal(readRejectTally(epicDir), 7);
  });

  it('returns 0 when the tally is absent', () => {
    const epicDir = path.join(root, 'temp', 'run-4');
    mkdirSync(epicDir, { recursive: true });
    assert.equal(readRejectTally(epicDir), 0);
  });
});

describe('scanRetroMirror', () => {
  const FILED = [
    '### Proposed issues — framework repo',
    '',
    '- **Fix the widget**',
    '',
    '  Filed: [#42](https://example.com/42)',
    '',
  ].join('\n');

  const UNFILED = [
    '### Proposed issues — consumer repo',
    '',
    '- **Add a guard**',
    '',
    '```sh',
    "gh issue create --title 'Add a guard' --label meta::consumer-improvement",
    '```',
    '',
  ].join('\n');

  const DISCARDED = [
    '### One-off / discarded',
    '- `flaky-thing` (1 occurrence, source: consumer)',
    '',
  ].join('\n');

  it('flags an actionable proposal with a gh stanza and no Filed reference', () => {
    assert.deepEqual(scanRetroMirror(UNFILED), ['Add a guard']);
  });

  it('does not flag a filed proposal', () => {
    assert.deepEqual(scanRetroMirror(FILED), []);
  });

  it('does not flag discarded one-off items', () => {
    assert.deepEqual(scanRetroMirror(DISCARDED), []);
  });

  it('scans consumer and framework sections together', () => {
    const body = `${UNFILED}\n${FILED}\n${DISCARDED}`;
    assert.deepEqual(scanRetroMirror(body), ['Add a guard']);
  });

  it('returns [] for an empty or non-string body', () => {
    assert.deepEqual(scanRetroMirror(''), []);
    assert.deepEqual(scanRetroMirror(null), []);
  });
});

describe('detectLoopHealth', () => {
  it('returns null for a clean substrate (valid lines, zero rejects, all filed)', () => {
    const epicDir = path.join(root, 'temp', 'run-500');
    writeStream(
      epicDir,
      ['signals.ndjson'],
      [VALID('2026-07-10T00:00:00Z'), VALID('2026-07-10T00:00:01Z')],
    );
    writeStream(
      epicDir,
      ['stories', 'story-1', 'signals.ndjson'],
      [VALID('2026-07-10T00:00:02Z')],
    );
    writeFileSync(
      path.join(epicDir, 'signal-rejects.json'),
      JSON.stringify({ count: 0 }),
      'utf8',
    );
    writeFileSync(
      path.join(epicDir, 'retro.md'),
      [
        '### Proposed issues — framework repo',
        '',
        '- **Already filed**',
        '',
        '  Filed: [#7](https://example.com/7)',
        '',
      ].join('\n'),
      'utf8',
    );
    assert.equal(detectLoopHealth(root), null);
  });

  it('reports schema-invalid samples and the persisted reject tally', () => {
    const epicDir = path.join(root, 'temp', 'run-501');
    writeStream(
      epicDir,
      ['stories', 'story-1', 'signals.ndjson'],
      [VALID('2026-07-10T00:00:00Z'), INVALID_ENUM('2026-07-10T00:00:01Z')],
    );
    writeFileSync(
      path.join(epicDir, 'signal-rejects.json'),
      JSON.stringify({ count: 4 }),
      'utf8',
    );
    const finding = detectLoopHealth(root);
    assert.ok(finding);
    assert.equal(finding.id, 'loop-health');
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.autoCorrectable, false);
    assert.match(finding.summary, /run-501/);
    assert.match(finding.summary, /1 schema-invalid/);
    assert.match(finding.summary, /4 persisted reject/);
    assert.match(finding.detail, /persisted reject tally/);
  });

  it('reports unfiled retro proposals even when signals are clean', () => {
    const epicDir = path.join(root, 'temp', 'run-502');
    writeStream(epicDir, ['signals.ndjson'], [VALID('2026-07-10T00:00:00Z')]);
    writeFileSync(
      path.join(epicDir, 'retro.md'),
      [
        '### Proposed issues — consumer repo',
        '',
        '- **Unrouted idea**',
        '',
        '```sh',
        "gh issue create --title 'Unrouted idea'",
        '```',
        '',
      ].join('\n'),
      'utf8',
    );
    const finding = detectLoopHealth(root);
    assert.ok(finding);
    assert.match(finding.summary, /1 unfiled actionable proposal/);
    assert.match(finding.detail, /Unrouted idea/);
  });
});

describe('loop-health via the checks registry', () => {
  beforeEach(() => clearRegistryCache());
  afterEach(() => clearRegistryCache());

  it('is discovered and run under scope:retro (autoFix:false)', async () => {
    const epicDir = path.join(root, 'temp', 'run-777');
    writeStream(
      epicDir,
      ['stories', 'story-1', 'signals.ndjson'],
      ['not json at all'],
    );
    // Feed cwd directly through state; a non-git fixture root falls back to
    // itself as the base dir (mainCheckoutRoot returns null).
    const state = { scope: 'retro', cwd: root, git: {}, fs: {}, env: {} };
    const { findings } = await runChecks({
      scope: 'retro',
      autoFix: false,
      state,
    });
    const loop = findings.find((f) => f.id === 'loop-health');
    assert.ok(loop, 'expected loop-health to run under scope:retro');
    assert.match(loop.summary, /schema-invalid/);
  });

  it('refuses autoFix under the retro scope', async () => {
    await assert.rejects(
      () => runChecks({ scope: 'retro', autoFix: true, state: { cwd: root } }),
      /retro scope is read-only/,
    );
  });
});
