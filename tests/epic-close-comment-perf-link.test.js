/**
 * epic-close-comment-perf-link.test.js — Story #3029 / Task #3041.
 *
 * The `epic-handoff` structured close comment is extended with a
 * `## Performance Report` section linking the JSON artifact persisted by
 * the close-tail (`emitEpicPerfReport`) and a one-line-per-wave summary.
 * These tests drive the renderer + `postHandoffComment` directly:
 *
 *   1. `renderHandoffBody` includes the `## Performance Report` heading
 *      + a relative link to `temp/epic-<id>/epic-perf-report.json` +
 *      one bullet per `waveParallelism` row.
 *   2. The bullet format matches `Wave N: <wallClock> wall /
 *      <summedStory> story / util <pct>% [cap binding|cap not binding]`.
 *   3. Empty waveParallelism degrades to a graceful "no rows" line.
 *   4. Missing perfReport keeps the legacy body shape (no heading).
 *   5. `postHandoffComment` calls the injected loader and forwards its
 *      envelope into the body.
 *   6. A loader failure degrades to the legacy body shape and surfaces a
 *      warn log, never throwing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  postHandoffComment,
  renderHandoffBody,
} from '../.agents/scripts/lib/orchestration/finalize/post-handoff-comment.js';

function makeLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    error: (m) => lines.error.push(m),
    _lines: lines,
  };
}

const baseWaveRows = [
  {
    waveIndex: 0,
    wallClockMs: 90000, // 1m30s
    summedStoryMs: 150000, // 2m30s
    utilisation: 0.833,
    capBinding: true,
    verifyConcurrencyCap: 4,
  },
  {
    waveIndex: 1,
    wallClockMs: 4200, // 4.2s
    summedStoryMs: 4200,
    utilisation: 1.0,
    capBinding: false,
    verifyConcurrencyCap: 4,
  },
];

describe('renderHandoffBody — Performance Report section', () => {
  it('includes the ## Performance Report heading + relative link when perfReport is supplied', () => {
    const body = renderHandoffBody({
      epicId: 900,
      prNumber: 1234,
      prUrl: 'https://github.com/org/repo/pull/1234',
      perfReport: {
        relativePath: 'temp/epic-900/epic-perf-report.json',
        waveParallelism: baseWaveRows,
      },
    });
    assert.match(body, /^## Performance Report$/m);
    assert.match(
      body,
      /\[`temp\/epic-900\/epic-perf-report\.json`\]\(temp\/epic-900\/epic-perf-report\.json\)/,
    );
  });

  it('renders one bullet per wave with the canonical wall/story/util/cap format', () => {
    const body = renderHandoffBody({
      epicId: 900,
      prNumber: 1234,
      perfReport: {
        relativePath: 'temp/epic-900/epic-perf-report.json',
        waveParallelism: baseWaveRows,
      },
    });
    // Wave 0 — minute-scale durations + cap binding.
    assert.match(
      body,
      /Wave 0: 1m30s wall \/ 2m30s story \/ util 83% \[cap binding\]/,
    );
    // Wave 1 — second-scale durations + cap not binding.
    assert.match(
      body,
      /Wave 1: 4\.2s wall \/ 4\.2s story \/ util 100% \[cap not binding\]/,
    );
  });

  it('degrades to a "no rows" line when waveParallelism is empty', () => {
    const body = renderHandoffBody({
      epicId: 900,
      prNumber: 1234,
      perfReport: {
        relativePath: 'temp/epic-900/epic-perf-report.json',
        waveParallelism: [],
      },
    });
    assert.match(body, /## Performance Report/);
    assert.match(body, /No wave-parallelism rows recorded\./);
  });

  it('omits the Performance Report section entirely when perfReport is null', () => {
    const body = renderHandoffBody({
      epicId: 900,
      prNumber: 1234,
      prUrl: 'https://github.com/org/repo/pull/1234',
      perfReport: null,
    });
    assert.doesNotMatch(body, /Performance Report/);
    // Legacy body shape preserved.
    assert.match(body, /Epic handoff — PR opened/);
    assert.match(body, /Auto-merge will arm once/);
  });
});

describe('postHandoffComment — wires the perf-report loader into the body', () => {
  it('invokes the injected loader and forwards its envelope into the rendered body', async () => {
    const loaderCalls = [];
    const upsertCalls = [];
    const result = await postHandoffComment({
      epicId: 900,
      prNumber: 1234,
      prUrl: 'https://github.com/org/repo/pull/1234',
      provider: {},
      config: { project: { paths: { tempRoot: '/tmp/test' } } },
      cwd: '/repo',
      loadPerfReportFn: async (args) => {
        loaderCalls.push(args);
        return {
          relativePath: 'temp/epic-900/epic-perf-report.json',
          waveParallelism: baseWaveRows,
        };
      },
      upsertStructuredCommentFn: async (provider, ticketId, marker, body) => {
        upsertCalls.push({ provider, ticketId, marker, body });
        return { commentId: 9999 };
      },
      logger: makeLogger(),
    });
    assert.equal(loaderCalls.length, 1);
    assert.equal(loaderCalls[0].epicId, 900);
    assert.equal(loaderCalls[0].cwd, '/repo');
    assert.equal(upsertCalls.length, 1);
    assert.equal(upsertCalls[0].ticketId, 900);
    assert.match(upsertCalls[0].body, /## Performance Report/);
    assert.match(upsertCalls[0].body, /Wave 0:/);
    assert.equal(result.commentId, 9999);
  });

  it('degrades silently when the loader throws — body keeps the legacy shape', async () => {
    const logger = makeLogger();
    const upsertCalls = [];
    await postHandoffComment({
      epicId: 900,
      prNumber: 1234,
      prUrl: 'https://github.com/org/repo/pull/1234',
      provider: {},
      loadPerfReportFn: async () => {
        throw new Error('ENOENT: missing report');
      },
      upsertStructuredCommentFn: async (_p, _t, _m, body) => {
        upsertCalls.push(body);
        return { commentId: 1 };
      },
      logger,
    });
    assert.equal(upsertCalls.length, 1);
    assert.doesNotMatch(upsertCalls[0], /Performance Report/);
    assert.equal(logger._lines.warn.length, 1);
    assert.match(logger._lines.warn[0], /perf-report load failed/);
  });

  it('omits the Performance Report section when the loader resolves null (no JSON on disk)', async () => {
    const upsertCalls = [];
    await postHandoffComment({
      epicId: 900,
      prNumber: 1234,
      prUrl: 'https://github.com/org/repo/pull/1234',
      provider: {},
      loadPerfReportFn: async () => null,
      upsertStructuredCommentFn: async (_p, _t, _m, body) => {
        upsertCalls.push(body);
        return { commentId: 1 };
      },
      logger: makeLogger(),
    });
    assert.doesNotMatch(upsertCalls[0], /Performance Report/);
  });
});
