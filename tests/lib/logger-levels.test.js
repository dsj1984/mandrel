/**
 * Logger.js — branch coverage for the level-resolution table.
 *
 * The `LEVEL` constant is evaluated at module load, so each level
 * needs its own child process. We spawn a tiny inline harness that
 * imports the module fresh under each `AGENT_LOG_LEVEL` and prints
 * which methods produced output.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const HARNESS = `
import { Logger } from './.agents/scripts/lib/Logger.js';
const sink = { log: [], warn: [], error: [] };
console.log = (m) => sink.log.push(m);
console.warn = (m) => sink.warn.push(m);
console.error = (m) => sink.error.push(m);
Logger.debug('D');
Logger.info('I');
Logger.warn('W');
Logger.error('E');
process.stdout.write(JSON.stringify({ level: Logger.level, sink }));
`;

function runHarness(env) {
  const out = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', HARNESS],
    {
      env: { ...process.env, ...env },
      cwd: process.cwd(),
      encoding: 'utf-8',
    },
  );
  if (out.status !== 0) {
    throw new Error(
      `Harness exited ${out.status}: ${out.stderr || out.stdout}`,
    );
  }
  return JSON.parse(out.stdout);
}

describe('Logger LEVEL resolution', () => {
  it('AGENT_LOG_LEVEL=silent suppresses every method except fatal', () => {
    const r = runHarness({ AGENT_LOG_LEVEL: 'silent' });
    assert.equal(r.level, 'silent');
    assert.equal(r.sink.log.length, 0);
    assert.equal(r.sink.warn.length, 0);
    // debug + error both emit on stderr; under silent, neither.
    assert.equal(r.sink.error.length, 0);
  });

  it('AGENT_LOG_LEVEL=verbose enables debug + every higher level', () => {
    const r = runHarness({ AGENT_LOG_LEVEL: 'verbose' });
    assert.equal(r.level, 'verbose');
    assert.equal(r.sink.log.length, 1);
    assert.equal(r.sink.warn.length, 1);
    // stderr = debug + error → 2 entries
    assert.equal(r.sink.error.length, 2);
  });

  it('AGENT_LOG_LEVEL=debug behaves identically to verbose', () => {
    const r = runHarness({ AGENT_LOG_LEVEL: 'debug' });
    assert.equal(r.level, 'debug');
    assert.equal(r.sink.error.length, 2);
  });

  it('AGENT_LOG_LEVEL=info suppresses debug, emits info/warn/error', () => {
    const r = runHarness({ AGENT_LOG_LEVEL: 'info' });
    assert.equal(r.level, 'info');
    assert.equal(r.sink.log.length, 1);
    assert.equal(r.sink.warn.length, 1);
    assert.equal(r.sink.error.length, 1);
  });

  it('an unrecognized AGENT_LOG_LEVEL falls back to info', () => {
    const r = runHarness({ AGENT_LOG_LEVEL: 'gibberish' });
    assert.equal(r.level, 'info');
    assert.equal(r.sink.log.length, 1);
  });

  it('absent AGENT_LOG_LEVEL falls back to info', () => {
    // Pass an empty string explicitly to override any inherited value.
    const r = runHarness({ AGENT_LOG_LEVEL: '' });
    assert.equal(r.level, 'info');
    assert.equal(r.sink.log.length, 1);
  });
});

describe('Logger.createProgress under silent level', () => {
  const SILENT_HARNESS = `
import { Logger } from './.agents/scripts/lib/Logger.js';
const sink = [];
console.log = (m) => sink.push(['log', m]);
console.error = (m) => sink.push(['err', m]);
const p = Logger.createProgress('S');
p('phase', 'msg');
const p2 = Logger.createProgress('S2', { stderr: false });
p2('phase', 'msg');
process.stdout.write(JSON.stringify({ sink }));
`;

  it('produces no output when level is silent', () => {
    const out = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', SILENT_HARNESS],
      {
        env: { ...process.env, AGENT_LOG_LEVEL: 'silent' },
        cwd: process.cwd(),
        encoding: 'utf-8',
      },
    );
    assert.equal(out.status, 0, out.stderr);
    const r = JSON.parse(out.stdout);
    assert.deepEqual(r.sink, []);
  });
});
