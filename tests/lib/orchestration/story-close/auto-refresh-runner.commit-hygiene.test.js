/**
 * auto-refresh-runner.commit-hygiene.test.js — Story #2205 / Task #2217.
 *
 * Pins the commit-hygiene contract introduced by AC-8:
 *
 *   - After `refreshBaseline()` writes the merged baseline file, the
 *     runner stages it and runs `git diff --cached --exit-code`.
 *   - Empty diff → log "no baseline drift to fold in", emit NO commit.
 *   - Non-empty diff → emit one canonical
 *     `chore(baselines): refresh <kind> for story-<id>` commit.
 *   - NO `--amend`, NO `--allow-empty`, ever.
 *
 * Two layers of enforcement:
 *
 *   1. Source-text guard — the runner module must not contain `--amend`
 *      or `--allow-empty` literals.
 *   2. Behavioural fixture — drives the runner with an empty-diff
 *      scenario and asserts zero commit invocations land.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { runAutoRefresh } from '../../../../.agents/scripts/lib/orchestration/story-close/auto-refresh-runner.js';

const REPO = path.resolve('/tmp/repo-2217');
const MI_PATH = path.resolve(REPO, 'baselines/maintainability.json');
const CRAP_PATH = path.resolve(REPO, 'baselines/crap.json');

const AGENT_SETTINGS_FIXTURE = {
  paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
  quality: {
    autoRefresh: {
      enabled: true,
      miDropCap: 1.5,
      crapJumpCap: 5,
      scope: 'diff',
    },
    baselines: {
      maintainability: { path: 'baselines/maintainability.json' },
      crap: { path: 'baselines/crap.json' },
    },
  },
};

function stubAccessors() {
  return {
    getQuality: () => ({
      ...AGENT_SETTINGS_FIXTURE.quality,
      autoRefresh: { ...AGENT_SETTINGS_FIXTURE.quality.autoRefresh },
    }),
    getBaselines: () => ({
      maintainability: { path: 'baselines/maintainability.json' },
      crap: { path: 'baselines/crap.json' },
    }),
  };
}

function makeFsShim() {
  const store = new Map();
  return {
    store,
    readFileSync(p) {
      if (!store.has(p)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return store.get(p);
    },
    writeFileSync(p, bytes) {
      store.set(p, bytes);
    },
    existsSync(p) {
      return store.has(p);
    },
    mkdirSync() {},
    renameSync(from, to) {
      if (!store.has(from)) return;
      store.set(to, store.get(from));
      store.delete(from);
    },
  };
}

function makeRecordingGit(plan = {}) {
  const calls = [];
  const gitSpawn = (_cwd, ...args) => {
    calls.push({ args });
    const key = args.join(' ');
    if (Object.hasOwn(plan, key)) {
      const v = plan[key];
      return typeof v === 'function' ? v(calls) : v;
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { gitRunner: { gitSpawn }, calls };
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeReaderForFs(fsImpl) {
  return (absPath, _opts) => {
    const bytes = fsImpl.store.get(absPath);
    if (!bytes) throw new Error(`missing ${absPath}`);
    const parsed = JSON.parse(bytes);
    return {
      rollup: parsed.rollup ?? { '*': {} },
      rows: parsed.rows ?? [],
      kernelVersion: parsed.kernelVersion,
      generatedAt: parsed.generatedAt,
    };
  };
}

function miEnvelope(entries) {
  return {
    $schema: '.agents/schemas/baselines/maintainability.schema.json',
    kernelVersion: '0.1.0',
    generatedAt: '2026-04-01T00:00:00Z',
    rollup: { '*': {} },
    rows: entries.map(([p, mi]) => ({ path: p, mi })),
  };
}

function crapEnvelope(rows) {
  return {
    $schema: '.agents/schemas/baselines/crap.schema.json',
    kernelVersion: '1.1.0',
    generatedAt: '2026-04-01T00:00:00Z',
    rollup: { '*': {} },
    rows: rows.map((r) => ({ ...r })),
  };
}

describe('AC-8 source-text contract — no --amend / --allow-empty in story-close', () => {
  const dir = path.resolve(
    process.cwd(),
    '.agents/scripts/lib/orchestration/story-close',
  );

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    it(`${file}: must not reference \`--amend\``, () => {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      // Tokenise: a literal `--amend` flag on a git command line is the
      // forbidden pattern. Comments referencing the historical behaviour
      // are fine — match only on quoted-string occurrences (`'--amend'`
      // or `"--amend"`), which is how spawnSync / gitSpawn argv would
      // carry the flag.
      assert.equal(
        /['"]--amend['"]/.test(src),
        false,
        `${file} still contains a quoted --amend literal`,
      );
    });
    it(`${file}: must not reference \`--allow-empty\``, () => {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.equal(
        /['"]--allow-empty['"]/.test(src),
        false,
        `${file} still contains a quoted --allow-empty literal`,
      );
    });
  }
});

describe('AC-8 runner behaviour — empty staged diff produces zero commits', () => {
  it('refreshBaseline writes, but diff --cached is clean → no commit, status=skipped', async () => {
    const fsImpl = makeFsShim();
    fsImpl.writeFileSync(MI_PATH, JSON.stringify(miEnvelope([['a.js', 90]])));
    fsImpl.writeFileSync(CRAP_PATH, JSON.stringify(crapEnvelope([])));

    // Stub refreshBaseline so we can claim `wrote:true` while the staged
    // tree (per git plan below) matches HEAD — the empty-diff branch.
    const refreshCalls = [];
    const refreshBaseline = async (opts) => {
      refreshCalls.push(opts.kind);
      // Service "wrote" the same bytes as on disk.
      return { kind: opts.kind, writePath: opts.writePath, wrote: true };
    };

    const { gitRunner, calls } = makeRecordingGit({
      'diff --name-only origin/epic/2173...story-2205': {
        status: 0,
        stdout: 'a.js\n',
      },
      'add baselines/maintainability.json': { status: 0 },
      // diff --cached --exit-code exits 0 → no drift to commit.
      'diff --cached --exit-code -- baselines/maintainability.json': {
        status: 0,
      },
      'add baselines/crap.json': { status: 0 },
      'diff --cached --exit-code -- baselines/crap.json': { status: 0 },
    });

    const result = await runAutoRefresh({
      storyId: 2205,
      epicId: 2173,
      cwd: REPO,
      epicBranch: 'epic/2173',
      storyBranch: 'story-2205',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      deps: {
        ...stubAccessors(),
        refreshBaseline,
        scorerBuilder: () => () => async () => [],
        gitRunner,
        fsImpl,
        appendSignal: async () => true,
        forEachLine: async () => ({ linesRead: 0, missing: true }),
        logger: silentLogger(),
        readerLoadFile: makeReaderForFs(fsImpl),
      },
    });

    // status=skipped because every kind's staged diff was empty.
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'no-baseline-drift');

    // Critical: zero commits.
    const commitCalls = calls.filter((c) => c.args[0] === 'commit');
    assert.equal(commitCalls.length, 0);

    // Bonus: no --amend / --allow-empty ever shows up in the argv stream.
    for (const call of calls) {
      assert.equal(
        call.args.includes('--amend'),
        false,
        `git received --amend: ${JSON.stringify(call.args)}`,
      );
      assert.equal(
        call.args.includes('--allow-empty'),
        false,
        `git received --allow-empty: ${JSON.stringify(call.args)}`,
      );
    }
  });

  it('non-empty staged diff → exactly one chore(baselines): commit lands', async () => {
    const fsImpl = makeFsShim();
    fsImpl.writeFileSync(MI_PATH, JSON.stringify(miEnvelope([['a.js', 90]])));
    fsImpl.writeFileSync(CRAP_PATH, JSON.stringify(crapEnvelope([])));

    const refreshBaseline = async (opts) => {
      if (opts.kind === 'maintainability') {
        fsImpl.writeFileSync(
          opts.writePath,
          JSON.stringify(miEnvelope([['a.js', 89.5]])),
        );
        return { kind: opts.kind, writePath: opts.writePath, wrote: true };
      }
      return { kind: opts.kind, writePath: opts.writePath, wrote: false };
    };

    const { gitRunner, calls } = makeRecordingGit({
      'diff --name-only origin/epic/2173...story-2205': {
        status: 0,
        stdout: 'a.js\n',
      },
      'add baselines/maintainability.json': { status: 0 },
      'diff --cached --exit-code -- baselines/maintainability.json': {
        status: 1,
        stdout: 'drift\n',
      },
      'commit -m chore(baselines): refresh maintainability for story-2205': {
        status: 0,
      },
      'rev-parse --short HEAD': { status: 0, stdout: 'feed4242' },
    });

    const result = await runAutoRefresh({
      storyId: 2205,
      epicId: 2173,
      cwd: REPO,
      epicBranch: 'epic/2173',
      storyBranch: 'story-2205',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      deps: {
        ...stubAccessors(),
        refreshBaseline,
        scorerBuilder: () => () => async () => [],
        gitRunner,
        fsImpl,
        appendSignal: async () => true,
        forEachLine: async () => ({ linesRead: 0, missing: true }),
        logger: silentLogger(),
        readerLoadFile: makeReaderForFs(fsImpl),
      },
    });

    assert.equal(result.status, 'committed');
    assert.equal(result.sha, 'feed4242');

    const commitCalls = calls.filter((c) => c.args[0] === 'commit');
    assert.equal(commitCalls.length, 1);
    assert.deepEqual(commitCalls[0].args, [
      'commit',
      '-m',
      'chore(baselines): refresh maintainability for story-2205',
    ]);

    // Reinforce: argv stream is free of --amend / --allow-empty.
    for (const call of calls) {
      assert.equal(call.args.includes('--amend'), false);
      assert.equal(call.args.includes('--allow-empty'), false);
    }
  });
});
