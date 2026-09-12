/**
 * run-isolate.test.js — the `test-isolate` orchestration and its progress sink
 * (Story #5316).
 *
 * Both were unreachable inside the CLI shell: `runTestIsolate` scored CRAP 56,
 * and its inlined `onProgress` arrow scored 72 under the name
 * `<anon runTestIsolate/(stage,payload)#0>`. The named seams (`resolveFiles`,
 * `diagnose`) let these run without spawning a single child process.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createProgressLogger } from '../../../.agents/scripts/lib/test-isolate/progress-log.js';
import { runTestIsolate } from '../../../.agents/scripts/lib/test-isolate/run-isolate.js';

/** A report with nothing wrong in it. */
function okReport(over = {}) {
  return {
    files: ['tests/a.test.js'],
    durationMs: 1000,
    flippers: [],
    bisections: [],
    envMutators: [],
    ...over,
  };
}

/** Collect the lines a run logs, and the args it handed the diagnoser. */
function harness({ files = ['tests/a.test.js'], report = okReport() } = {}) {
  const lines = [];
  const seen = {};
  return {
    lines,
    seen,
    opts: {
      onLog: (s) => lines.push(s),
      resolveFiles: (args) => {
        seen.resolveFiles = args;
        return files;
      },
      diagnose: async (args) => {
        seen.diagnose = args;
        return report;
      },
    },
  };
}

describe('runTestIsolate — no files matched', () => {
  it('exits 0 and says which pattern found nothing', async () => {
    const h = harness({ files: [] });
    const { exitCode, report } = await runTestIsolate({
      argv: ['tests/nope/**'],
      ...h.opts,
    });
    assert.equal(exitCode, 0);
    assert.equal(report.files.length, 0);
    assert.match(
      h.lines.join('\n'),
      /no test files matched pattern: tests\/nope\/\*\*/,
    );
  });

  it('names the default pattern when none was given', async () => {
    const h = harness({ files: [] });
    await runTestIsolate({ argv: [], ...h.opts });
    assert.match(h.lines.join('\n'), /<default>/);
  });

  it('never calls the diagnoser when nothing matched', async () => {
    const h = harness({ files: [] });
    await runTestIsolate({ argv: [], ...h.opts });
    assert.equal(h.seen.diagnose, undefined);
  });
});

describe('runTestIsolate — exit code', () => {
  it('exits 0 on a clean report', async () => {
    const h = harness();
    const { exitCode } = await runTestIsolate({ argv: [], ...h.opts });
    assert.equal(exitCode, 0);
  });

  it('exits 1 on a flipper', async () => {
    const h = harness({ report: okReport({ flippers: ['tests/x.test.js'] }) });
    const { exitCode } = await runTestIsolate({ argv: [], ...h.opts });
    assert.equal(exitCode, 1);
  });

  it('exits 1 on an env mutator even with no flipper', async () => {
    // The env leak is the earlier signal — a cascade that has not manifested
    // yet must still fail the run.
    const h = harness({
      report: okReport({
        envMutators: [
          {
            file: 'tests/p.test.js',
            envDiff: { added: ['F'], removed: [], changed: [] },
          },
        ],
      }),
    });
    const { exitCode } = await runTestIsolate({ argv: [], ...h.opts });
    assert.equal(exitCode, 1);
  });
});

describe('runTestIsolate — wiring', () => {
  it('threads parsed options through to the diagnoser', async () => {
    const h = harness();
    await runTestIsolate({
      argv: [
        '--workers',
        '2',
        '--suite-concurrency',
        '6',
        '--max-bisect-depth',
        '3',
        '--max-bisect-targets',
        '1',
      ],
      repoRoot: '/repo',
      ...h.opts,
    });
    assert.equal(h.seen.diagnose.workers, 2);
    assert.equal(h.seen.diagnose.suiteConcurrency, 6);
    assert.equal(h.seen.diagnose.maxBisectDepth, 3);
    assert.equal(h.seen.diagnose.maxBisectTargets, 1);
    assert.equal(h.seen.diagnose.repoRoot, '/repo');
  });

  it('passes the pattern and repoRoot to the file resolver', async () => {
    const h = harness();
    await runTestIsolate({
      argv: ['tests/lib/**'],
      repoRoot: '/repo',
      ...h.opts,
    });
    assert.deepEqual(h.seen.resolveFiles, {
      pattern: 'tests/lib/**',
      repoRoot: '/repo',
    });
  });

  it('--json emits the raw envelope instead of the text report', async () => {
    const h = harness();
    await runTestIsolate({ argv: ['--json'], ...h.opts });
    const out = h.lines.join('\n');
    assert.doesNotMatch(out, /=== test-isolate diagnostic report ===/);
    assert.deepEqual(JSON.parse(h.lines.at(-1)).files, ['tests/a.test.js']);
  });

  it('renders the text report by default', async () => {
    const h = harness();
    await runTestIsolate({ argv: [], ...h.opts });
    assert.match(h.lines.join('\n'), /=== test-isolate diagnostic report ===/);
  });

  it('--quiet suppresses the scan line and the progress sink', async () => {
    const h = harness();
    await runTestIsolate({ argv: ['--quiet'], ...h.opts });
    assert.doesNotMatch(h.lines.join('\n'), /scanning 1 file/);
    assert.equal(h.seen.diagnose.onProgress, undefined);
  });

  it('supplies a progress sink when not quiet', async () => {
    const h = harness();
    await runTestIsolate({ argv: [], ...h.opts });
    assert.equal(typeof h.seen.diagnose.onProgress, 'function');
    assert.match(h.lines.join('\n'), /scanning 1 file\(s\)/);
  });
});

describe('createProgressLogger', () => {
  /** Drive one stage and return what it logged. */
  function logFor(stage, payload) {
    const lines = [];
    createProgressLogger((s) => lines.push(s))(stage, payload);
    return lines;
  }

  it('reports each phase boundary', () => {
    assert.match(
      logFor('isolated:start', { count: 7 })[0],
      /isolated phase: 7 file\(s\)/,
    );
    assert.match(logFor('isolated:done', {})[0], /isolated phase: done/);
    assert.match(
      logFor('suite:start', { count: 7 })[0],
      /suite phase: 7 file\(s\)/,
    );
    assert.match(logFor('suite:done', {})[0], /suite phase: done/);
    assert.match(
      logFor('bisect:start', { target: 'tests/x.test.js' })[0],
      /bisecting flipper: tests\/x\.test\.js/,
    );
  });

  it('names up to three suspects inline', () => {
    const [line] = logFor('bisect:done', { suspects: ['a', 'b', 'c'] });
    assert.match(line, /suspects: a, b, c$/);
  });

  it('elides the rest with a count once there are more than three', () => {
    const [line] = logFor('bisect:done', {
      suspects: ['a', 'b', 'c', 'd', 'e'],
    });
    assert.match(line, /suspects: a, b, c \(\+2 more\)/);
  });

  it('stays silent on an unknown stage rather than throwing', () => {
    assert.deepEqual(logFor('something:new', {}), []);
  });

  it('tolerates a missing payload', () => {
    assert.doesNotThrow(() => logFor('isolated:done', undefined));
  });
});
