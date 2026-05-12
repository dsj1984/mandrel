/**
 * Unit tests for `.agents/scripts/signals-view.js` (Epic #1181 / Story
 * #1440 / Task #1464).
 *
 * AC coverage (per Task ticket #1464):
 *   1. Happy path: a checked-in (synthesised in `beforeEach`) signals
 *      stream renders an Epic → Story → Task tree to stdout.
 *   2. Missing-file friendly message: when no signals.ndjson exists, the
 *      viewer prints a friendly "no signals found" line and exits 0
 *      (NOT a stack trace).
 *   3. `tempRoot` honour: the viewer reads from the configured
 *      `tempRoot`, NOT the project root. Negative control: hard-coding
 *      `'temp'` here would fail this case.
 *
 * The `tempRoot` test is here because of the
 * `phase_timings_uses_project_root` project memory — earlier post-merge
 * work leaked to the real repo root regardless of test sandbox
 * `tempRoot`. We exercise the `--temp-root` flag (test hook) and assert
 * the viewer reads from there.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { main, parseArgs } from '../.agents/scripts/signals-view.js';

let workRoot;

beforeEach(() => {
  workRoot = mkdtempSync(path.join(tmpdir(), 'signals-view-'));
});

afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

function captureStdout() {
  const buf = [];
  const orig = console.log;
  console.log = (...args) => {
    buf.push(
      args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '),
    );
  };
  return {
    output() {
      return buf.join('\n');
    },
    restore() {
      console.log = orig;
    },
  };
}

async function writeSignalsFile(rootDir, epic, story, events) {
  const dir = path.join(rootDir, `epic-${epic}`, `story-${story}`);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'signals.ndjson');
  await fs.writeFile(
    target,
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );
  return target;
}

describe('signals-view — argument parsing', () => {
  it('rejects missing epic-id', () => {
    const r = parseArgs([]);
    assert.equal(r.ok, false);
    assert.match(r.error, /missing <epic-id>/);
  });

  it('rejects non-integer epic-id', () => {
    const r = parseArgs(['abc']);
    assert.equal(r.ok, false);
    assert.match(r.error, /<epic-id>/);
  });

  it('rejects negative or zero epic-id', () => {
    const r1 = parseArgs(['0']);
    const r2 = parseArgs(['-7']);
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);
  });

  it('accepts positive epic-id alone', () => {
    const r = parseArgs(['1181']);
    assert.deepEqual(r, { ok: true, epic: 1181, story: null, tempRoot: null });
  });

  it('accepts --story flag with positive integer', () => {
    const r = parseArgs(['1181', '--story', '1438']);
    assert.deepEqual(r, { ok: true, epic: 1181, story: 1438, tempRoot: null });
  });

  it('rejects --story without a value', () => {
    const r = parseArgs(['1181', '--story']);
    assert.equal(r.ok, false);
  });

  it('rejects --story with a non-integer value', () => {
    const r = parseArgs(['1181', '--story', 'oops']);
    assert.equal(r.ok, false);
  });

  it('accepts --temp-root <path>', () => {
    const r = parseArgs(['1181', '--temp-root', '/tmp/x']);
    assert.deepEqual(r, {
      ok: true,
      epic: 1181,
      story: null,
      tempRoot: '/tmp/x',
    });
  });
});

describe('signals-view — happy path', () => {
  it('renders a Story → Task tree from a signals stream', async () => {
    await writeSignalsFile(workRoot, 1181, 1438, [
      {
        kind: 'wave-start',
        ts: '2026-05-11T00:00:00.000Z',
        epic: 1181,
        story: 1438,
      },
      {
        kind: 'state-transition',
        ts: '2026-05-11T00:00:10.000Z',
        epic: 1181,
        story: 1438,
        task: 1461,
      },
      {
        kind: 'state-transition',
        ts: '2026-05-11T00:00:20.000Z',
        epic: 1181,
        story: 1438,
        task: 1461,
      },
      {
        kind: 'wave-end',
        ts: '2026-05-11T00:01:00.000Z',
        epic: 1181,
        story: 1438,
      },
    ]);

    const cap = captureStdout();
    let exitCode;
    try {
      exitCode = await main(['1181', '--temp-root', workRoot]);
    } finally {
      cap.restore();
    }
    const out = cap.output();
    assert.equal(exitCode, 0);
    assert.match(out, /Epic #1181/);
    assert.match(out, /Story #1438/);
    assert.match(out, /Task #1461/);
    // Duration is computed from wave-start → wave-end (60s).
    assert.match(out, /1m0\.0s/);
  });

  it('--story filter narrows the printed tree to one Story subtree', async () => {
    await writeSignalsFile(workRoot, 1181, 1438, [
      {
        kind: 'friction',
        ts: '2026-05-11T00:00:00Z',
        epic: 1181,
        story: 1438,
        task: 1461,
      },
    ]);
    await writeSignalsFile(workRoot, 1181, 1440, [
      {
        kind: 'friction',
        ts: '2026-05-11T00:00:00Z',
        epic: 1181,
        story: 1440,
        task: 1465,
      },
    ]);

    const cap = captureStdout();
    try {
      await main(['1181', '--story', '1438', '--temp-root', workRoot]);
    } finally {
      cap.restore();
    }
    const out = cap.output();
    assert.match(out, /Story #1438/);
    assert.doesNotMatch(out, /Story #1440/);
  });
});

describe('signals-view — missing-file friendly message', () => {
  it('exits 0 with a friendly message when no signals.ndjson exists', async () => {
    const cap = captureStdout();
    let exitCode;
    try {
      exitCode = await main(['9999', '--temp-root', workRoot]);
    } finally {
      cap.restore();
    }
    const out = cap.output();
    assert.equal(
      exitCode,
      0,
      `expected exit 0, got ${exitCode}; output:\n${out}`,
    );
    assert.match(
      out,
      /No signals found for Epic #9999/,
      `expected friendly missing-file message; got:\n${out}`,
    );
    // Negative control: never a stack trace.
    assert.doesNotMatch(out, /at \w+/);
    assert.doesNotMatch(out, /TypeError|RangeError|Error:/);
  });

  it('exits 0 with story-scoped friendly message when --story has no signals', async () => {
    // Different Story has signals, but the requested one does not.
    await writeSignalsFile(workRoot, 9999, 1, [
      { kind: 'friction', ts: '2026-05-11T00:00:00Z', epic: 9999, story: 1 },
    ]);
    const cap = captureStdout();
    let exitCode;
    try {
      exitCode = await main(['9999', '--story', '2', '--temp-root', workRoot]);
    } finally {
      cap.restore();
    }
    assert.equal(exitCode, 0);
    assert.match(cap.output(), /No signals found for Epic #9999 \(Story #2\)/);
  });
});

describe('signals-view — tempRoot honour (memory: phase_timings_uses_project_root)', () => {
  it('reads from the configured tempRoot, not the project root', async () => {
    // Synthesise a signal under the sandbox `workRoot`. If the viewer
    // were hardcoded to read from project-root `./temp`, this test
    // would render the empty/wrong tree. The presence of "Story #1438"
    // in the output is the positive signal that the sandbox path won.
    await writeSignalsFile(workRoot, 1181, 1438, [
      {
        kind: 'wave-start',
        ts: '2026-05-11T00:00:00Z',
        epic: 1181,
        story: 1438,
      },
      { kind: 'wave-end', ts: '2026-05-11T00:00:05Z', epic: 1181, story: 1438 },
    ]);

    const cap = captureStdout();
    let exitCode;
    try {
      exitCode = await main(['1181', '--temp-root', workRoot]);
    } finally {
      cap.restore();
    }
    const out = cap.output();
    assert.equal(exitCode, 0);
    assert.match(
      out,
      /Story #1438/,
      `viewer must read from --temp-root, not the project root; output:\n${out}`,
    );
  });

  it('NEGATIVE CONTROL: a different tempRoot dir produces the missing-file message', async () => {
    // Write the fixture to workRoot, but point the viewer at a different
    // temp dir. The viewer MUST NOT see the workRoot fixture.
    await writeSignalsFile(workRoot, 1181, 1438, [
      { kind: 'friction', ts: '2026-05-11T00:00:00Z', epic: 1181, story: 1438 },
    ]);
    const otherRoot = mkdtempSync(path.join(tmpdir(), 'signals-other-'));
    try {
      const cap = captureStdout();
      let exitCode;
      try {
        exitCode = await main(['1181', '--temp-root', otherRoot]);
      } finally {
        cap.restore();
      }
      assert.equal(exitCode, 0);
      assert.match(cap.output(), /No signals found for Epic #1181/);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
