/**
 * epic-close.phase-6 — pins the JS-side wiring of Phase 6.0
 * (Story #1123 Task #1140).
 *
 * The workflow doc's Phase 6 already names `analyze-execution.js --epic`
 * (covered by `epic-close.smoke.test.js`); this suite locks in the
 * matching code path: `phasePostEpicPerfReport(epicId, warnings, {
 * spawnFn })` invokes the analyzer with `--epic <eid>` and treats a
 * non-zero exit as a non-fatal warning.
 *
 * The function is exercised through dependency injection — `spawnFn`
 * stubs `execFileSync` so we never spawn a child process.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { phasePostEpicPerfReport } from '../../.agents/scripts/epic-close.js';

describe('phasePostEpicPerfReport', () => {
  it('invokes analyze-execution.js with --epic <eid>', () => {
    const calls = [];
    const fakeSpawn = (executable, args, opts) => {
      calls.push({ executable, args, opts });
      return { status: 0 };
    };
    const warnings = [];
    const logs = [];
    const result = phasePostEpicPerfReport(99, warnings, {
      spawnFn: fakeSpawn,
      projectRoot: '/repo',
      logger: (...rest) => logs.push(rest),
    });
    assert.equal(result.status, 'ok');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, process.execPath);
    assert.equal(calls[0].args.length, 3);
    assert.ok(
      calls[0].args[0].endsWith(
        path.join('.agents', 'scripts', 'analyze-execution.js'),
      ),
      `expected analyze-execution.js path, got ${calls[0].args[0]}`,
    );
    assert.equal(calls[0].args[1], '--epic');
    assert.equal(calls[0].args[2], '99');
    assert.equal(warnings.length, 0);
  });

  it('treats a non-zero exit as a non-fatal warning', () => {
    const fakeSpawn = () => {
      throw new Error('analyzer crashed');
    };
    const warnings = [];
    const logs = [];
    const result = phasePostEpicPerfReport(42, warnings, {
      spawnFn: fakeSpawn,
      projectRoot: '/repo',
      logger: (...rest) => logs.push(rest),
    });
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /analyzer crashed/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /analyze-execution failed/);
  });

  it('passes the cwd from projectRoot to the spawn call', () => {
    const calls = [];
    const fakeSpawn = (executable, args, opts) => {
      calls.push({ executable, args, opts });
      return { status: 0 };
    };
    phasePostEpicPerfReport(7, [], {
      spawnFn: fakeSpawn,
      projectRoot: '/some/root',
      logger: () => {},
    });
    assert.equal(calls[0].opts.cwd, '/some/root');
  });
});
