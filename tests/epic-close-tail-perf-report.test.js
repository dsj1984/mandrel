/**
 * epic-close-tail-perf-report.test.js — Story #3029 / Task #3040.
 *
 * The close tail (`epic-close.js`) auto-emits the `epic-perf-report`
 * artifact alongside the planning-close + epic-state recovery so the
 * report is reachable on disk under `temp/epic-<id>/` without operator
 * action. These tests drive `emitEpicPerfReport` directly with a stub
 * analyzer + stub fs writer:
 *
 *   1. Happy path — writes `epic-perf-report.json` whose JSON parses
 *      against `.agents/schemas/epic-perf-report.schema.json` and
 *      returns `{ status: 'ok' }`.
 *   2. Analyzer throw — surfaces a friction-not-fatal envelope so the
 *      close tail still completes; the exception is logged as `warn`,
 *      not rethrown.
 *   3. Filesystem write throw — same friction-not-fatal contract.
 *   4. `runEpicCloseTail` wires the helper through — a stub
 *      `emitEpicPerfReportFn` is invoked with the resolved `epicId`,
 *      `provider`, `config`, and `cwd`, and its envelope is forwarded
 *      under `result.perfReport`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { runEpicCloseTail } from '../.agents/scripts/epic-close.js';
import { emitEpicPerfReport } from '../.agents/scripts/lib/epic-close-tail-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '.agents',
  'schemas',
  'epic-perf-report.schema.json',
);

const epicPerfReportSchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

function compileSchema() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(epicPerfReportSchema);
}

function makeLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    error: (m) => lines.error.push(m),
    _lines: lines,
  };
}

function buildSchemaConformantPayload(epicId, overrides = {}) {
  return {
    kind: 'epic-perf-report',
    epicId,
    generatedAt: '2026-05-26T22:00:00.000Z',
    signalCounts: { friction: 0, hotspot: 0, rework: 0, retry: 0 },
    waveParallelism: [
      {
        waveIndex: 0,
        wallClockMs: 120000,
        summedStoryMs: 200000,
        utilisation: 0.833,
        capBinding: true,
        verifyConcurrencyCap: 4,
      },
    ],
    topHotspots: [],
    mostFrictionStories: [],
    ...overrides,
  };
}

describe('emitEpicPerfReport — friction-not-fatal close-tail helper', () => {
  it('writes epic-perf-report.json that conforms to the schema (happy path)', async () => {
    const payload = buildSchemaConformantPayload(900);
    const stubAnalyze = async () => ({
      commentId: 5050,
      payload,
      baselineRefreshRate: null,
      qualityGateFriction: null,
    });
    const writes = [];
    const mkdirCalls = [];
    const result = await emitEpicPerfReport({
      epicId: 900,
      provider: {},
      // Config drives `epicPerfReportJsonPath` through the configured
      // tempRoot. Use an inline fixture root so the test does not write
      // to the real `temp/`.
      config: { project: { paths: { tempRoot: '/tmp/test-epic-close-tail' } } },
      cwd: '/repo',
      logger: makeLogger(),
      analyzeFn: stubAnalyze,
      writeFileFn: async (target, data) => {
        writes.push({ target, data });
      },
      mkdirFn: async (dir, opts) => {
        mkdirCalls.push({ dir, opts });
      },
    });

    assert.equal(result.status, 'ok');
    assert.match(result.path, /epic-perf-report\.json$/);
    assert.equal(result.commentId, 5050);
    assert.equal(writes.length, 1);
    assert.equal(mkdirCalls.length, 1);
    assert.equal(mkdirCalls[0].opts.recursive, true);

    // Persisted JSON conforms to the schema.
    const persisted = JSON.parse(writes[0].data);
    const validate = compileSchema();
    const ok = validate(persisted);
    assert.equal(
      ok,
      true,
      `persisted epic-perf-report.json failed schema: ${JSON.stringify(validate.errors)}`,
    );
    assert.equal(persisted.epicId, 900);
    assert.equal(persisted.waveParallelism[0].verifyConcurrencyCap, 4);
  });

  it('treats analyzer throws as friction-not-fatal (status: failed, no rethrow)', async () => {
    const logger = makeLogger();
    const stubAnalyze = async () => {
      throw new Error('boom: analyze-execution exploded');
    };
    const result = await emitEpicPerfReport({
      epicId: 900,
      provider: {},
      config: {},
      cwd: '/repo',
      logger,
      analyzeFn: stubAnalyze,
      writeFileFn: async () => {
        throw new Error('writeFile should not be invoked when analyze throws');
      },
      mkdirFn: async () => {},
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.path, null);
    assert.equal(result.payload, null);
    assert.match(result.detail, /boom: analyze-execution exploded/);
    // The friction is logged on warn so the close-tail orchestrator can
    // record it via the lifecycle bus but never blocks on it.
    assert.equal(logger._lines.warn.length, 1);
    assert.match(logger._lines.warn[0], /analyze-execution threw/);
  });

  it('treats filesystem write throws as friction-not-fatal', async () => {
    const logger = makeLogger();
    const payload = buildSchemaConformantPayload(901);
    const stubAnalyze = async () => ({ commentId: 1, payload });
    const result = await emitEpicPerfReport({
      epicId: 901,
      provider: {},
      config: {},
      cwd: '/repo',
      logger,
      analyzeFn: stubAnalyze,
      writeFileFn: async () => {
        throw new Error('EACCES: read-only temp');
      },
      mkdirFn: async () => {},
    });

    assert.equal(result.status, 'failed');
    assert.match(result.detail, /EACCES/);
    assert.equal(result.payload, payload);
    assert.equal(logger._lines.warn.length, 1);
    assert.match(logger._lines.warn[0], /failed to persist/);
  });
});

describe('runEpicCloseTail — emitEpicPerfReport is wired into the tail', () => {
  it('invokes emitEpicPerfReportFn with epicId, provider, config, cwd and surfaces its envelope', async () => {
    const calls = [];
    const stubPlanningClose = async () => ({
      prd: { id: 1, status: 'closed' },
      techSpec: { id: 2, status: 'closed' },
      acceptanceSpec: { id: null, status: 'skipped' },
    });
    const stubVerifyEpic = async () => ({ status: 'already-closed' });
    const stubEmitPerf = async (args) => {
      calls.push(args);
      return {
        status: 'ok',
        path: '/tmp/test/epic-900/epic-perf-report.json',
        commentId: 7070,
        payload: buildSchemaConformantPayload(900),
      };
    };

    const result = await runEpicCloseTail({
      epicId: 900,
      provider: { getEpic: async () => ({ linkedIssues: {} }) },
      config: { project: { paths: { tempRoot: '/tmp/test' } } },
      cwd: '/repo',
      logger: makeLogger(),
      closePlanningArtifactsFn: stubPlanningClose,
      verifyAndRecoverEpicCloseFn: stubVerifyEpic,
      emitEpicPerfReportFn: stubEmitPerf,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].epicId, 900);
    assert.equal(calls[0].cwd, '/repo');
    assert.deepEqual(calls[0].config, {
      project: { paths: { tempRoot: '/tmp/test' } },
    });
    assert.equal(result.perfReport.status, 'ok');
    assert.equal(result.perfReport.commentId, 7070);
  });
});
