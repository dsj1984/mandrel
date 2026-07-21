/**
 * tests/observability/terse-result.test.js — Story #4685.
 *
 * The hot-path orchestration CLIs route their verbose result dumps through
 * `emitTerseResult`: full pretty detail to a temp log, a single structured
 * summary line to the agent's stdout in its place. This locks that contract
 * (single-line default, detail-to-disk, inline escape hatch, byte reduction).
 */

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { emitTerseResult } from '../../.agents/scripts/lib/observability/terse-result.js';

/** The env var that restores the legacy inline pretty dump (module-private). */
const RESULT_DETAIL_ENV = 'MANDREL_RESULT_DETAIL';

/** Capture Logger-shaped output into an array. */
function captureLog() {
  const lines = [];
  return { lines, info: (m) => lines.push(m) };
}

const SAMPLE = {
  storyId: 4685,
  action: 'noop',
  reason: 'already-closed',
  nested: { a: 1, b: [2, 3], c: 'deep' },
  padding: 'x'.repeat(400),
};

describe('emitTerseResult', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = nodeFs.mkdtempSync(path.join(nodeOs.tmpdir(), 'terse-result-'));
  });

  afterEach(() => {
    nodeFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits exactly one summary line to stdout by default', () => {
    const log = captureLog();
    emitTerseResult({
      label: 'STORY CLOSE RESULT',
      result: SAMPLE,
      summary: { storyId: 4685, action: 'noop', status: 'landed' },
      logDir: tmpDir,
      log,
      env: {},
    });

    assert.equal(log.lines.length, 1, 'exactly one line emitted');
    const [line] = log.lines;
    assert.ok(!line.includes('\n'), 'the summary is a single line');
    // The fields the agent acts on are present, verbatim JSON.
    assert.ok(line.includes('"status":"landed"'));
    assert.ok(line.includes('STORY CLOSE RESULT'));
    assert.ok(line.includes('full detail'));
  });

  it('writes the full pretty detail to a temp log the agent can read', () => {
    const log = captureLog();
    const { logPath, inline } = emitTerseResult({
      label: 'STORY INIT RESULT',
      result: SAMPLE,
      scope: 4685,
      logDir: tmpDir,
      log,
      env: {},
    });

    assert.equal(inline, false);
    assert.ok(logPath, 'a log path is returned');
    assert.ok(logPath.includes('4685'), 'scope disambiguates the filename');
    const detail = nodeFs.readFileSync(logPath, 'utf8');
    assert.ok(detail.includes('--- STORY INIT RESULT ---'));
    assert.ok(detail.includes('--- END RESULT ---'));
    // Full fidelity: every field survives to disk, pretty-printed.
    assert.deepEqual(
      JSON.parse(
        detail
          .split('--- STORY INIT RESULT ---')[1]
          .split('--- END RESULT ---')[0],
      ),
      SAMPLE,
    );
    assert.ok(detail.includes('\n  '), 'detail log is 2-space pretty JSON');
  });

  it('materially reduces the bytes the agent sees vs the inline dump', () => {
    const inlineLog = captureLog();
    emitTerseResult({
      label: 'STORY CLOSE RESULT',
      result: SAMPLE,
      summary: { storyId: 4685, status: 'landed' },
      logDir: tmpDir,
      log: inlineLog,
      env: { [RESULT_DETAIL_ENV]: 'inline' },
    });
    const terseLog = captureLog();
    emitTerseResult({
      label: 'STORY CLOSE RESULT',
      result: SAMPLE,
      summary: { storyId: 4685, status: 'landed' },
      logDir: tmpDir,
      log: terseLog,
      env: {},
    });

    const inlineBytes = inlineLog.lines.join('\n').length;
    const terseBytes = terseLog.lines.join('\n').length;
    assert.ok(
      terseBytes < inlineBytes / 2,
      `terse (${terseBytes}B) should be well under half of inline (${inlineBytes}B)`,
    );
  });

  it('restores the inline pretty dump under MANDREL_RESULT_DETAIL=inline', () => {
    const log = captureLog();
    const { logPath, inline } = emitTerseResult({
      label: 'SYNC RESULT',
      result: SAMPLE,
      logDir: tmpDir,
      log,
      env: { [RESULT_DETAIL_ENV]: 'inline' },
    });

    assert.equal(inline, true);
    assert.equal(logPath, null, 'no temp log written in inline mode');
    assert.equal(log.lines.length, 1);
    assert.ok(log.lines[0].includes('--- SYNC RESULT ---'));
    assert.ok(log.lines[0].includes('--- END RESULT ---'));
  });

  it('falls back to the inline dump when the log write fails (detail never lost)', () => {
    const log = captureLog();
    const failingFs = {
      mkdirSync() {
        throw new Error('EACCES: read-only temp');
      },
      writeFileSync() {
        throw new Error('should not be reached');
      },
    };
    const { logPath, inline, error } = emitTerseResult({
      label: 'CONFIRM MERGE RESULT',
      result: SAMPLE,
      logDir: tmpDir,
      fs: failingFs,
      log,
      env: {},
    });

    assert.equal(inline, true);
    assert.equal(logPath, null);
    assert.ok(error && error.includes('EACCES'));
    assert.ok(log.lines[0].includes('--- CONFIRM MERGE RESULT ---'));
  });
});
