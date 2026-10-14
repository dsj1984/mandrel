import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

/**
 * Story #5668 — admission across real processes. Each contender is a child
 * running tests/fixtures/suite-admission-worker.js against one shared lock
 * home; mocked lock calls could not establish real exclusion or recovery.
 * The "long suite" holds until the test drops a release file, so nothing
 * here waits on a wall-clock budget longer than a few seconds.
 */

const WORKER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'suite-admission-worker.js',
);

const LONG = 'npm run test:full';
const FOCUSED = 'python scripts/validation.py --workers 4';

function config(...workloads) {
  return { delivery: { execution: { capacity: 10, workloads } } };
}

describe('suite admission across processes (Story #5668)', () => {
  let dir;
  let lockPath;
  let log;
  const children = [];

  beforeEach(() => {
    dir = makeTempDir('mandrel-admit-mp-');
    lockPath = path.join(dir, 'full-suite.lock');
    log = path.join(dir, 'events.ndjson');
  });

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** @returns {{ child: object, exited: Promise<number> }} */
  function contend(name, spec) {
    const child = spawn(
      process.execPath,
      [
        WORKER,
        JSON.stringify({ name, lockPath, log, waitMs: 20_000, ...spec }),
      ],
      { stdio: 'ignore' },
    );
    children.push(child);
    const exited = new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve(signal ?? code));
    });
    return { child, exited };
  }

  function events() {
    if (!fs.existsSync(log)) return [];
    return fs
      .readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  function at(name, event) {
    return events().find((e) => e.name === name && e.event === event)?.at;
  }

  async function until(predicate, label, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  function releaseFile(name) {
    return path.join(dir, `${name}.release`);
  }

  it('a short focused run starts and finishes inside a long suite', async () => {
    const workloads = config(
      { command: LONG, weight: 6 },
      { command: FOCUSED, weight: 4 },
    );
    const long = contend('long', {
      config: workloads,
      command: LONG,
      holdUntil: releaseFile('long'),
    });
    await until(() => at('long', 'start'), 'the long suite to start');
    const focused = contend('focused', {
      config: workloads,
      command: FOCUSED,
      holdMs: 50,
    });
    assert.equal(await focused.exited, 0);
    assert.equal(at('long', 'end'), undefined, 'the long suite still runs');
    fs.writeFileSync(releaseFile('long'), '');
    assert.equal(await long.exited, 0);
    assert.ok(at('focused', 'start') >= at('long', 'start'));
    assert.ok(at('focused', 'end') <= at('long', 'end'));
  });

  it('never admits more weight than capacity across processes', async () => {
    const workloads = config({ command: FOCUSED, weight: 4 });
    const runs = ['a', 'b', 'c'].map((name) =>
      contend(name, {
        config: workloads,
        command: FOCUSED,
        holdUntil: releaseFile('all'),
      }),
    );
    const started = () => events().filter((e) => e.event === 'start');
    await until(() => started().length >= 2, 'two weight-4 runs to start');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(started().length, 2, 'a third would need 12 of capacity 10');
    fs.writeFileSync(releaseFile('all'), '');
    for (const run of runs) assert.equal(await run.exited, 0);
    assert.equal(started().length, 3, 'the third ran once capacity freed');
  });

  it('two runs sharing a resource never overlap', async () => {
    const workloads = config(
      { command: LONG, weight: 2, resources: ['db'] },
      { command: FOCUSED, weight: 2, resources: ['db'] },
    );
    const long = contend('long', {
      config: workloads,
      command: LONG,
      holdUntil: releaseFile('long'),
    });
    await until(() => at('long', 'start'), 'the long suite to start');
    const focused = contend('focused', {
      config: workloads,
      command: FOCUSED,
      holdMs: 0,
      waitMs: 600,
    });
    assert.equal(await focused.exited, 75, 'deferred, not overlapped');
    assert.equal(at('focused', 'start'), undefined, 'never spawned');
    fs.writeFileSync(releaseFile('long'), '');
    assert.equal(await long.exited, 0);
  });

  it("a crashed holder's reservation is reclaimed without a duplicate run", async () => {
    const workloads = config(
      { command: LONG, weight: 8 },
      { command: FOCUSED, weight: 4 },
    );
    const long = contend('long', {
      config: workloads,
      command: LONG,
      holdUntil: releaseFile('never'),
    });
    await until(() => at('long', 'start'), 'the long suite to start');
    long.child.kill('SIGKILL');
    await long.exited;
    const focused = contend('focused', {
      config: workloads,
      command: FOCUSED,
      holdMs: 0,
      waitMs: 5_000,
    });
    assert.equal(await focused.exited, 0);
    assert.equal(
      events().filter((e) => e.event === 'start').length,
      2,
      'each run spawned exactly once',
    );
  });

  it('a waiter with a shorter budget than the holder never steals its lock', async () => {
    const long = contend('long', {
      config: {},
      command: 'npm test',
      holdUntil: releaseFile('long'),
      waitMs: 60_000,
    });
    await until(() => at('long', 'start'), 'the long suite to start');
    const impatient = contend('impatient', {
      config: {},
      command: 'npm test',
      holdMs: 0,
      waitMs: 500,
    });
    assert.equal(await impatient.exited, 75);
    assert.equal(at('impatient', 'start'), undefined);
    assert.equal(fs.existsSync(lockPath), true, 'the holder still holds it');
    fs.writeFileSync(releaseFile('long'), '');
    assert.equal(await long.exited, 0);
    assert.equal(fs.existsSync(lockPath), false);
  });
});
