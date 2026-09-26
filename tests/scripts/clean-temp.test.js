/**
 * clean-temp.test.js — the `/clean-temp` operator command (Story #5459).
 *
 * Every case builds a fixture project under an absolute scratch dir with a
 * relative `temp` tempRoot, and drives `runCleanTemp` with an injected
 * config, provider and confirm — so nothing reaches GitHub or a real tree.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCleanTemp } from '../../.agents/scripts/lib/clean-temp.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const DAY = 24 * 60 * 60 * 1000;
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const CLI = path.join(REPO_ROOT, '.agents', 'scripts', 'clean-temp.js');
const dirs = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A fresh fixture project root. */
function makeProject() {
  const root = makeTempDir('clean-temp-');
  dirs.push(root);
  return root;
}

/** Write a file (creating parents), optionally aged by `ageMs`. */
function writeAged(target, body = 'x', ageMs = 0) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
  if (ageMs > 0) age(target, ageMs);
  return target;
}

/** Backdate `target`'s mtime by `ageMs`. */
function age(target, ageMs) {
  const when = new Date(Date.now() - ageMs);
  utimesSync(target, when, when);
  return target;
}

/** Issue states: `closed`, `open`, or `error` (the read throws). */
function fakeProvider(states) {
  return {
    reads: [],
    async getTicket(id) {
      this.reads.push(id);
      const state = states[id];
      if (state === 'error' || state === undefined) {
        throw new Error(`HTTP 502 for #${id}`);
      }
      return { id, state };
    },
  };
}

/**
 * The shared fixture tree: one entry per bucket shape. Returns the paths.
 *
 * @param {string} temp
 */
function seedTree(temp) {
  return {
    // framework: a closed Story's gate log + its scratch dir
    gateLog: writeAged(path.join(temp, 'orchestration', 'close-gates-100.log')),
    openGateLog: writeAged(
      path.join(temp, 'orchestration', 'close-gates-200.log'),
    ),
    scratch: writeAged(path.join(temp, 'scratch', 'story-100', 'probe.js')),
    // closed-issue / open / provider-error, all fresh
    closedEntry: writeAged(path.join(temp, 'pr-100-notes.md'), 'c'.repeat(12)),
    openEntry: writeAged(path.join(temp, 'fix-200-draft')),
    errorEntry: writeAged(path.join(temp, 'probe-300.txt')),
    // id-less / multi-id, old and recent
    agedEntry: writeAged(path.join(temp, 'no-escalate-fix'), 'a', 30 * DAY),
    agedMulti: writeAged(path.join(temp, 'pr-100-vs-200.diff'), 'm', 30 * DAY),
    recentEntry: writeAged(path.join(temp, 'hand-notes.md'), 'r', DAY),
    // reserved
    qa: writeAged(path.join(temp, 'qa', 'session.ndjson')),
    cache: writeAged(path.join(temp, 'cache', 'meta.json')),
    lock: writeAged(path.join(temp, 'boot-sweep.lock')),
    topSignals: writeAged(path.join(temp, 'signals.ndjson')),
    nestedSignals: writeAged(
      path.join(temp, 'scratch', 'story-100', 'deep', 'signals.ndjson'),
    ),
  };
}

const STATES = { 100: 'closed', 200: 'open', 300: 'error' };

/** Drive the CLI engine against `project`. */
async function run(project, argv, overrides = {}) {
  const out = [];
  const err = [];
  const provider = overrides.provider ?? fakeProvider(STATES);
  const prompts = [];
  const result = await runCleanTemp({
    argv,
    cwd: project,
    loadConfig: () =>
      overrides.config ?? { project: { paths: { tempRoot: 'temp' } } },
    resolveRoot: (dir) => dir,
    getProvider: () => provider,
    confirm: async (question) => {
      prompts.push(question);
      return overrides.answer ?? false;
    },
    write: (t) => out.push(t),
    writeErr: (t) => err.push(t),
  });
  return {
    ...result,
    stdout: out.join(''),
    stderr: err.join(''),
    provider,
    prompts,
  };
}

/** entry → bucket, from a JSON envelope. */
function bucketsOf(envelope) {
  return Object.fromEntries(envelope.entries.map((e) => [e.entry, e.bucket]));
}

describe('clean-temp — dry run is the default', () => {
  it('puts every top-level entry in exactly one bucket and deletes nothing (AC-1)', async () => {
    const project = makeProject();
    const temp = path.join(project, 'temp');
    const paths = seedTree(temp);

    const { exitCode, envelope, stdout } = await run(project, ['--json']);

    assert.equal(exitCode, 0);
    assert.equal(envelope.dryRun, true);
    assert.deepEqual(bucketsOf(envelope), {
      'boot-sweep.lock': 'kept',
      cache: 'kept',
      'fix-200-draft': 'kept',
      'hand-notes.md': 'kept',
      'no-escalate-fix': 'aged',
      orchestration: 'framework',
      'pr-100-notes.md': 'closed-issue',
      'pr-100-vs-200.diff': 'aged',
      'probe-300.txt': 'kept',
      qa: 'kept',
      scratch: 'framework',
      'signals.ndjson': 'kept',
    });
    assert.equal(envelope.entries.length, 12, 'one row per top-level entry');
    for (const p of Object.values(paths)) {
      assert.equal(existsSync(p), true, `${p} untouched on a dry run`);
    }
    assert.equal(JSON.parse(stdout).kind, 'clean-temp');
  });

  it('renders a human table naming each bucket and a dry-run summary', async () => {
    const project = makeProject();
    seedTree(path.join(project, 'temp'));
    const { stdout } = await run(project, []);
    assert.match(stdout, /closed-issue\s+pr-100-notes\.md/);
    assert.match(stdout, /kept\s+fix-200-draft .*issue #200 open/);
    assert.match(stdout, /kept\s+probe-300\.txt .*issue #300 read failed/);
    assert.match(stdout, /dry run — nothing deleted/);
  });

  it('is prompted per bucket and deletes nothing it was refused', async () => {
    const project = makeProject();
    const paths = seedTree(path.join(project, 'temp'));
    const { prompts, envelope } = await run(project, ['--execute', '--json']);
    assert.equal(prompts.length, 3, 'one prompt per non-empty bucket');
    assert.equal(envelope.bytesReclaimed, 0);
    assert.equal(existsSync(paths.gateLog), true);
    assert.equal(existsSync(paths.agedEntry), true);
  });
});

describe('clean-temp --execute --yes (AC-2)', () => {
  it('deletes framework and closed-issue; keeps aged, open, errored and reserved', async () => {
    const project = makeProject();
    const paths = seedTree(path.join(project, 'temp'));

    const { exitCode, envelope, prompts } = await run(project, [
      '--execute',
      '--yes',
      '--json',
    ]);

    assert.equal(exitCode, 0);
    assert.deepEqual(prompts, [], 'unattended: no prompts');
    for (const gone of [paths.gateLog, paths.scratch, paths.closedEntry]) {
      assert.equal(existsSync(gone), false, `${gone} deleted`);
    }
    for (const kept of [
      paths.openGateLog,
      paths.openEntry,
      paths.errorEntry,
      paths.agedEntry,
      paths.agedMulti,
      paths.recentEntry,
      paths.qa,
      paths.cache,
      paths.lock,
      paths.topSignals,
      paths.nestedSignals,
    ]) {
      assert.equal(existsSync(kept), true, `${kept} survives`);
    }
    assert.equal(envelope.executed.aged.deleted, false);
    assert.match(envelope.executed.aged.note, /never deleted unattended/);
    assert.ok(envelope.bytesReclaimed >= 12);
  });

  it('an interactive yes deletes the aged bucket too', async () => {
    const project = makeProject();
    const paths = seedTree(path.join(project, 'temp'));
    await run(project, ['--execute', '--json'], { answer: true });
    assert.equal(existsSync(paths.agedEntry), false);
    assert.equal(existsSync(paths.agedMulti), false);
    assert.equal(existsSync(paths.recentEntry), true, 'too recent is kept');
    assert.equal(existsSync(paths.topSignals), true);
  });
});

describe('clean-temp id attribution (AC-3)', () => {
  it('never attributes a multi-id basename to either id', async () => {
    const project = makeProject();
    const temp = path.join(project, 'temp');
    // Both ids closed: a single-id reading would put it in closed-issue.
    const multi = writeAged(path.join(temp, 'story-100-vs-101'), 'm');
    const provider = fakeProvider({ 100: 'closed', 101: 'closed' });

    const { envelope } = await run(project, ['--execute', '--yes', '--json'], {
      provider,
    });

    const row = envelope.entries.find((e) => e.entry === 'story-100-vs-101');
    assert.equal(row.bucket, 'kept', 'id-less and recent → kept, not closed');
    assert.match(row.reason, /2 ids/);
    assert.deepEqual(provider.reads, [], 'no id was read for it');
    assert.equal(existsSync(multi), true);
  });

  it('ignores hash fragments, timestamps and leading-zero runs as ids', async () => {
    const project = makeProject();
    const temp = path.join(project, 'temp');
    writeAged(path.join(temp, 'run-55093c48'), 'h', 30 * DAY);
    writeAged(path.join(temp, 'dump-1695600000000.json'), 't', 30 * DAY);
    writeAged(path.join(temp, 'v007-notes'), 'z', 30 * DAY);
    const provider = fakeProvider({});

    const { envelope } = await run(project, ['--json'], { provider });

    assert.deepEqual(provider.reads, []);
    for (const row of envelope.entries) {
      assert.equal(row.bucket, 'aged', `${row.entry} is id-less`);
    }
  });
});

describe('clean-temp project scoping (AC-4)', () => {
  it('refuses, non-zero, when tempRoot resolves outside the project root', async () => {
    const project = makeProject();
    const elsewhere = makeProject();
    const victim = writeAged(path.join(elsewhere, 'pr-100-notes.md'));
    const provider = fakeProvider(STATES);

    const { exitCode, stderr } = await run(project, ['--execute', '--yes'], {
      config: { project: { paths: { tempRoot: elsewhere } } },
      provider,
    });

    assert.equal(exitCode, 1);
    assert.match(stderr, /not inside the project root/);
    assert.equal(existsSync(victim), true);
    assert.deepEqual(provider.reads, [], 'refused before any scan');
  });

  it('refuses a tempRoot equal to the project root', async () => {
    const project = makeProject();
    const { exitCode } = await run(project, [], {
      config: { project: { paths: { tempRoot: project } } },
    });
    assert.equal(exitCode, 1);
  });

  it('refuses a relative tempRoot that climbs out of the project', async () => {
    const project = makeProject();
    const { exitCode } = await run(project, [], {
      config: { project: { paths: { tempRoot: '../elsewhere' } } },
    });
    assert.equal(exitCode, 1);
  });

  it('the CLI itself exits non-zero from a project whose tempRoot is outside', () => {
    const project = makeProject();
    const elsewhere = makeProject();
    const victim = writeAged(path.join(elsewhere, 'no-escalate-fix'), 'x');
    writeFileSync(
      path.join(project, '.agentrc.json'),
      JSON.stringify({ project: { paths: { tempRoot: elsewhere } } }),
    );
    const result = spawnSync(
      process.execPath,
      [CLI, '--cwd', project, '--execute', '--yes'],
      { encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(existsSync(victim), true);
  });
});
