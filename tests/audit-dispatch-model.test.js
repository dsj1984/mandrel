/**
 * Unit tests for `audit-dispatch-model.js` (Story #2590, AC #4).
 *
 * Covers the trace-summarizer that backs the CLI: tally Agent calls by
 * emitted `model:` value, surface missing-traces as a non-error, and
 * count unexpected model strings separately.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { summarizeTraces } from '../.agents/scripts/audit-dispatch-model.js';

function writeTraces(tmpDir, lines) {
  const tracePath = path.join(tmpDir, 'traces.ndjson');
  fs.writeFileSync(tracePath, `${lines.join('\n')}\n`, 'utf8');
  return tracePath;
}

function agentTrace(model) {
  const trace = {
    ts: '2026-05-19T00:00:00.000Z',
    kind: 'trace',
    source: { tool: 'Agent' },
    epicId: 0,
    storyId: 2590,
    taskId: null,
    phase: null,
    details: { tool: 'Agent', durationMs: 100 },
  };
  if (model !== undefined) trace.details.model = model;
  return JSON.stringify(trace);
}

function bashTrace() {
  return JSON.stringify({
    ts: '2026-05-19T00:00:01.000Z',
    kind: 'trace',
    source: { tool: 'Bash' },
    epicId: 0,
    storyId: 2590,
    taskId: null,
    phase: null,
    details: { tool: 'Bash', durationMs: 50, targetHash: 'sha256:abc' },
  });
}

describe('summarizeTraces', () => {
  it('reports missing: true when the file does not exist', () => {
    const summary = summarizeTraces('/nonexistent/path/traces.ndjson');
    assert.equal(summary.missing, true);
    assert.equal(summary.agentCalls, 0);
  });

  it('returns zero counts on an empty file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-'));
    const tracePath = path.join(tmpDir, 'traces.ndjson');
    fs.writeFileSync(tracePath, '', 'utf8');
    const summary = summarizeTraces(tracePath);
    assert.equal(summary.missing, false);
    assert.equal(summary.agentCalls, 0);
    assert.equal(summary.withModel, 0);
    assert.equal(summary.withoutModel, 0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ignores non-Agent traces', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-'));
    const tracePath = writeTraces(tmpDir, [bashTrace(), bashTrace()]);
    const summary = summarizeTraces(tracePath);
    assert.equal(summary.agentCalls, 0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('tallies Agent calls with model by enum value', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-'));
    const tracePath = writeTraces(tmpDir, [
      agentTrace('haiku'),
      agentTrace('haiku'),
      agentTrace('sonnet'),
      bashTrace(),
    ]);
    const summary = summarizeTraces(tracePath);
    assert.equal(summary.agentCalls, 3);
    assert.equal(summary.withModel, 3);
    assert.equal(summary.withoutModel, 0);
    assert.equal(summary.byModel.haiku, 2);
    assert.equal(summary.byModel.sonnet, 1);
    assert.equal(summary.byModel.opus, 0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('counts Agent calls that lack a model:', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-'));
    // `undefined` → details.model omitted; `null` → details.model: null.
    const tracePath = writeTraces(tmpDir, [
      agentTrace(undefined),
      agentTrace(null),
      agentTrace('haiku'),
    ]);
    const summary = summarizeTraces(tracePath);
    assert.equal(summary.agentCalls, 3);
    assert.equal(summary.withModel, 1);
    assert.equal(summary.withoutModel, 2);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flags unexpected (non-enum) model strings without dropping the count', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-'));
    const tracePath = writeTraces(tmpDir, [agentTrace('gpt-4')]);
    const summary = summarizeTraces(tracePath);
    assert.equal(summary.agentCalls, 1);
    assert.equal(summary.withModel, 1);
    assert.equal(summary.byModel.haiku, 0);
    assert.deepEqual(summary.unexpectedValues, ['gpt-4']);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips malformed JSON lines without throwing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-'));
    const tracePath = writeTraces(tmpDir, [
      'not-json',
      agentTrace('opus'),
      '{ broken',
    ]);
    const summary = summarizeTraces(tracePath);
    assert.equal(summary.agentCalls, 1);
    assert.equal(summary.byModel.opus, 1);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
