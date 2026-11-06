import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';

import { getChangedFiles } from '../../.agents/scripts/lib/changed-files.js';
import {
  captureStampPath,
  computeContentDigest,
  filterFilesUnderTargets,
  isCoverageFresh,
  writeCaptureStamp,
} from '../../.agents/scripts/lib/coverage-capture.js';
import { tryScopedCapture } from '../../.agents/scripts/lib/coverage-capture-affected.js';
import { judgeOwnFix } from '../../.agents/scripts/lib/coverage-capture-own-fix.js';
import {
  copyGitRepo,
  makeGitTemplate,
  runGit,
  writeFiles,
} from '../fixtures/git-fixture.js';

// Story #5958 — a Story's own small post-credit fix is re-measured as a
// delta when `coverage.ownFixDeltaMaxFiles` opts in. Real git fixtures; the
// suite runner is a stub that records its env and writes an artifact.

// A hook-launched run inherits GIT_DIR & co., which would point every git
// call below (fixture and production alike) at the enclosing repository.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_')) delete process.env[key];
}

const BASE_REF_ENV = 'MANDREL_COVERAGE_BASE_REF';
const CRAP = {
  enabled: true,
  targetDirs: ['src', 'tests'],
  coveragePath: 'coverage/coverage-final.json',
};
const TEST_LINES = Array.from({ length: 6 }, (_, i) => `test('t${i}');`);
const SHARED_LINES = Array.from(
  { length: 12 },
  (_, i) => `export const v${i} = ${i};`,
);
const SHARED_ON_MAIN = [...SHARED_LINES];
SHARED_ON_MAIN[11] = 'export const v11 = "main";';
const ROW_FILES = ['src/a.js', 'src/b.js', 'src/c.js', 'src/shared.js'];

/** Each base-sync's main-side commit, prebuilt once on a `sync/<name>` branch. */
const SYNCS = {
  unrelated: { 'src/b.js': 'export const b = 2;\n' },
  shared: { 'src/shared.js': `${SHARED_ON_MAIN.join('\n')}\n` },
  config: { 'src/b.js': 'export const b = 3;\n', 'package.json': '{}\n' },
  baseline: { 'baselines/coverage.json': '{"main":1}\n' },
};

let template;
let stamped;

before(async () => {
  template = makeGitTemplate({
    prefix: 'own-fix-delta-',
    files: {
      '.gitignore': 'coverage/\n',
      'src/a.js': 'export const a = 1;\n',
      'src/b.js': 'export const b = 1;\n',
      'src/c.js': 'export const c = 1;\n',
      'src/shared.js': `${SHARED_LINES.join('\n')}\n`,
      'tests/a.test.js': `${TEST_LINES.join('\n')}\n`,
    },
  });
  const t = repoAt(template);
  for (const [name, files] of Object.entries(SYNCS)) {
    t.git('checkout', '-q', '-b', `sync/${name}`, 'main');
    writeFiles(template, files);
    t.commit('main moves');
  }
  t.git('checkout', '-q', '-b', 'story', 'main');
  const lines = [...SHARED_LINES];
  lines[0] = 'export const v0 = "story";';
  writeFiles(template, {
    'src/a.js': 'export const a = 2;\n',
    'src/shared.js': `${lines.join('\n')}\n`,
    'tests/a.test.js': `${[...TEST_LINES, "test('t6');"].join('\n')}\n`,
  });
  t.commit('story work');
  stamped = copyGitRepo(template);
  await capture(stamped);
});

/** Helpers bound to the repository at `dir`. */
function repoAt(dir) {
  const git = (...args) => runGit(dir, ...args);
  const write = (rel, body) => writeFiles(dir, { [rel]: body });
  const commit = (msg) => {
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  /** Move main to a prebuilt `sync/<name>` commit, then merge it into the Story branch. */
  const baseSync = (name) => {
    git('branch', '-f', 'main', `sync/${name}`);
    git('merge', '-q', '--no-edit', 'main');
  };
  /** The Story's own small fix: one non-merge commit. */
  const ownFix = (files = { 'src/a.js': 'export const a = 3;\n' }) => {
    writeFiles(dir, files);
    return commit('story fix');
  };
  const stampPath = captureStampPath(dir, CRAP.coveragePath);
  const readStamp = () => JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  const editStamp = (fn) =>
    fs.writeFileSync(stampPath, JSON.stringify(fn(readStamp())));
  return { dir, git, write, commit, baseSync, ownFix, readStamp, editStamp };
}

/** A private copy already holding the first affected capture's stamp. */
function fixtureRepo() {
  const dir = copyGitRepo(stamped);
  writeArtifact(dir, 1);
  return repoAt(dir);
}

/** A row per source file, every one marked with the run that wrote it. */
function writeArtifact(dir, run) {
  const artifact = path.join(dir, CRAP.coveragePath);
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  const rows = ROW_FILES.map((f) => [path.join(dir, f), { s: { 0: run } }]);
  fs.writeFileSync(artifact, JSON.stringify(Object.fromEntries(rows)));
}

/** The artifact's rows keyed by repo-relative path, as their run number. */
function runsByFile(dir) {
  const raw = JSON.parse(
    fs.readFileSync(path.join(dir, CRAP.coveragePath), 'utf8'),
  );
  return Object.fromEntries(
    Object.entries(raw).map(([abs, row]) => [
      path.relative(dir, abs).replace(/\\/g, '/'),
      row.s[0],
    ]),
  );
}

async function capture(dir, { coverage = {} } = {}) {
  const calls = [];
  const log = [];
  const logger = {
    info: (m) => log.push(m),
    warn: (m) => log.push(m),
    error: (m) => log.push(m),
  };
  const result = await tryScopedCapture({
    crap: CRAP,
    coverage: { captureScope: 'affected', timeoutMs: 1000, ...coverage },
    args: { ref: 'main', baseBranchRef: 'main', cwd: dir },
    readPackageScriptsImpl: () => ({}),
    hasNpmScriptImpl: (_s, name) => name === 'test:coverage:affected',
    getChangedFilesImpl: getChangedFiles,
    filterFilesUnderTargetsImpl: filterFilesUnderTargets,
    isCoverageFreshImpl: isCoverageFresh,
    runCaptureImpl: async (opts) => {
      calls.push(opts);
      writeArtifact(dir, calls.length + 1);
      return 0;
    },
    computeContentDigestImpl: computeContentDigest,
    writeCaptureStampImpl: writeCaptureStamp,
    logger,
  });
  return { result, calls, log: log.join('\n') };
}

const KEY = { ownFixDeltaMaxFiles: 10 };

const freshAffected = (dir) =>
  isCoverageFresh({
    coveragePath: CRAP.coveragePath,
    targetDirs: CRAP.targetDirs,
    cwd: dir,
    requireScope: 'affected',
  }).fresh;

describe('own-fix delta refresh off (AC-1)', () => {
  for (const coverage of [{}, { ownFixDeltaMaxFiles: 0 }]) {
    it(`${JSON.stringify(coverage)}: a Story-overlapping delta refuses with today's reason`, async () => {
      const repo = fixtureRepo();
      repo.ownFix();
      const second = await capture(repo.dir, { coverage });
      assert.equal(second.calls.length, 1);
      assert.equal(second.calls[0].env[BASE_REF_ENV], 'main');
      assert.match(
        second.log,
        /delta refresh not eligible \(delta shares src\/a\.js with the Story's change set and the Story's own commit/,
      );
      assert.doesNotMatch(second.log, /own-fix/);
    });
  }
});

describe('own-fix delta refresh, eligible (AC-2, AC-3)', () => {
  it('one own commit re-measures only its files, keyed on the stamped commit', async () => {
    const repo = fixtureRepo();
    const stampCommit = repo.readStamp().commit;
    repo.ownFix();
    const second = await capture(repo.dir, { coverage: KEY });
    assert.equal(second.result, 0);
    assert.equal(second.calls.length, 1);
    assert.equal(second.calls[0].env[BASE_REF_ENV], stampCommit);
    assert.deepEqual(runsByFile(repo.dir), {
      'src/a.js': 2,
      'src/b.js': 1,
      'src/c.js': 1,
      'src/shared.js': 1,
    });
    assert.equal(freshAffected(repo.dir), true);
    assert.equal(repo.readStamp().scope, 'affected');
    assert.equal(repo.readStamp().commit, repo.git('rev-parse', 'HEAD'));
    assert.match(
      second.log,
      /needs an own-fix delta refresh — re-measuring 1 file\(s\) changed since \w{12} \(1 own file\(s\), 0 base file\(s\)\)\. \(stamp scope: affected, required scope: affected, verdict: own-fix-delta-refresh, delta: 1 file\(s\)\)/,
    );
  });

  it('an own commit plus a disjoint base-sync merge re-measures both parts', async () => {
    const repo = fixtureRepo();
    const stampCommit = repo.readStamp().commit;
    repo.ownFix();
    repo.baseSync('unrelated');
    const second = await capture(repo.dir, { coverage: KEY });
    assert.equal(second.calls.length, 1);
    assert.equal(second.calls[0].env[BASE_REF_ENV], stampCommit);
    assert.deepEqual(runsByFile(repo.dir), {
      'src/a.js': 2,
      'src/b.js': 2,
      'src/c.js': 1,
      'src/shared.js': 1,
    });
    assert.equal(freshAffected(repo.dir), true);
    assert.match(
      second.log,
      /re-measuring 2 file\(s\) .*\(1 own file\(s\), 1 base file\(s\)\)/,
    );
  });

  it('an own commit that only adds test lines stays eligible', async () => {
    const repo = fixtureRepo();
    repo.ownFix({
      'tests/a.test.js': `${[...TEST_LINES, "test('t6');", "test('t7');"].join('\n')}\n`,
    });
    const second = await capture(repo.dir, { coverage: KEY });
    assert.match(second.log, /own-fix delta refresh .*\(1 own file\(s\)/);
  });
});

describe('own-fix guards fall back to the Story scope (AC-4)', () => {
  async function assertRefused(repo, reason, coverage = KEY) {
    const second = await capture(repo.dir, { coverage });
    assert.equal(second.calls.length, 1);
    assert.equal(second.calls[0].env[BASE_REF_ENV], 'main');
    assert.match(second.log, /delta refresh not eligible \(own-fix: /);
    assert.match(second.log, reason);
  }

  it('a base part sharing a path with the Story change set', async () => {
    const repo = fixtureRepo();
    repo.ownFix();
    repo.baseSync('shared');
    await assertRefused(
      repo,
      /own-fix: base part shares src\/shared\.js with the Story's change set/,
    );
  });

  it('a coverage-config file in the own part', async () => {
    const repo = fixtureRepo();
    repo.ownFix({
      'src/a.js': 'export const a = 3;\n',
      'package.json': '{"x":1}\n',
    });
    await assertRefused(
      repo,
      /own-fix: own part touches coverage-determining config package\.json/,
    );
  });

  it('a coverage-config file in the base part', async () => {
    const repo = fixtureRepo();
    repo.ownFix();
    repo.baseSync('config');
    await assertRefused(
      repo,
      /own-fix: base part touches coverage-determining config package\.json/,
    );
  });

  it('more own suite-input files than the cap', async () => {
    const repo = fixtureRepo();
    repo.ownFix({
      'src/a.js': 'export const a = 3;\n',
      'src/d.js': 'export const d = 1;\n',
    });
    await assertRefused(
      repo,
      /own-fix: own part has 2 suite-input file\(s\), over ownFixDeltaMaxFiles 1/,
      { ownFixDeltaMaxFiles: 1 },
    );
  });

  it('an own commit that deletes a suite-input path', async () => {
    const repo = fixtureRepo();
    repo.write('src/a.js', 'export const a = 3;\n');
    repo.git('rm', '-q', 'src/c.js');
    const own = repo.commit('story fix');
    await assertRefused(
      repo,
      new RegExp(
        `own-fix: own commit ${own.slice(0, 12)} deletes or renames src/c\\.js`,
      ),
    );
  });

  it('an own commit that renames a suite-input path', async () => {
    const repo = fixtureRepo();
    repo.write('src/a.js', 'export const a = 3;\n');
    repo.git('mv', 'src/c.js', 'src/moved.js');
    repo.commit('story fix');
    await assertRefused(
      repo,
      /own-fix: own commit \w{12} deletes or renames src\/c\.js/,
    );
  });

  it('an own-part test file with net line removals', async () => {
    const repo = fixtureRepo();
    repo.ownFix({
      'tests/a.test.js': `${TEST_LINES.slice(0, 3).join('\n')}\n`,
    });
    await assertRefused(
      repo,
      /own-fix: own part removes lines from test file tests\/a\.test\.js/,
    );
  });

  it("a stamp not on HEAD's first-parent chain", async () => {
    const repo = fixtureRepo();
    // main merges the Story (main as first parent); the Story fast-forwards to it.
    repo.git('checkout', '-q', 'main');
    repo.git('reset', '-q', '--hard', 'sync/unrelated');
    repo.git('merge', '-q', '--no-edit', 'story');
    repo.git('checkout', '-q', 'story');
    repo.git('merge', '-q', '--ff-only', 'main');
    repo.ownFix();
    await assertRefused(
      repo,
      /own-fix: stamp is not on HEAD's first-parent chain/,
    );
  });

  it('an own non-merge commit reachable from the base ref', async () => {
    const repo = fixtureRepo();
    // main fast-forwards to the Story plus one commit; the Story fast-forwards to main.
    repo.git('checkout', '-q', 'main');
    repo.git('reset', '-q', '--hard', 'story');
    const onBase = repo.ownFix();
    repo.git('checkout', '-q', 'story');
    repo.git('merge', '-q', '--ff-only', 'main');
    repo.ownFix({ 'src/shared.js': `${SHARED_ON_MAIN.join('\n')}\n` });
    await assertRefused(
      repo,
      new RegExp(
        `own-fix: own commit ${onBase.slice(0, 12)} is reachable from main`,
      ),
    );
  });
});

describe("own-fix keeps today's preconditions and accepted paths (AC-5, AC-6)", () => {
  it('a dirty worktree refuses with today’s reason', async () => {
    const repo = fixtureRepo();
    repo.ownFix();
    repo.write('src/b.js', 'export const b = 9;\n');
    const second = await capture(repo.dir, { coverage: KEY });
    assert.match(second.log, /delta refresh not eligible \(worktree is dirty/);
  });

  it('a stamp that is not an ancestor of HEAD refuses with today’s reason', async () => {
    const repo = fixtureRepo();
    repo.git('checkout', '-q', '-b', 'elsewhere', 'main');
    const foreign = repo.ownFix({ 'src/e.js': 'export const e = 1;\n' });
    repo.git('checkout', '-q', 'story');
    repo.editStamp((stamp) => ({ ...stamp, commit: foreign }));
    repo.ownFix();
    const second = await capture(repo.dir, { coverage: KEY });
    assert.match(
      second.log,
      /delta refresh not eligible \(stamped commit is not an ancestor of HEAD/,
    );
  });

  it('a disjoint base-only delta still takes today’s delta refresh', async () => {
    const repo = fixtureRepo();
    repo.baseSync('unrelated');
    const second = await capture(repo.dir, { coverage: KEY });
    assert.equal(second.calls.length, 1);
    assert.match(second.log, /needs a delta refresh .*rule: disjoint/);
    assert.doesNotMatch(second.log, /own-fix/);
  });

  it('a non-suite-input-only delta still restamps without a run', async () => {
    const repo = fixtureRepo();
    repo.editStamp((stamp) => ({ ...stamp, treeDigest: 'f'.repeat(64) }));
    repo.baseSync('baseline');
    const second = await capture(repo.dir, { coverage: KEY });
    assert.equal(second.calls.length, 0);
    assert.match(second.log, /rule: restamp/);
    assert.equal(freshAffected(repo.dir), true);
  });
});

describe('judgeOwnFix', () => {
  const COMMIT = 'a'.repeat(40);
  const judge = (spawn, extra = {}) =>
    judgeOwnFix({
      cwd: '/nowhere',
      crap: CRAP,
      coverage: KEY,
      storyFiles: [],
      stamp: { commit: COMMIT },
      rule: { rule: 'own-commits', delta: ['src/a.js'] },
      baseRef: 'main',
      spawn,
      isConfig: () => false,
      no: (reason, rule) => ({ eligible: false, reason, rule }),
      ...extra,
    });

  it('runs no git command when the key is off or the refusal is not re-judged', () => {
    const spawn = () => assert.fail('no git call expected');
    const rule = { rule: 'empty', reason: 'no committed delta', delta: [] };
    assert.equal(judge(spawn, { coverage: {} }).eligible, false);
    assert.equal(judge(spawn, { rule }).reason, 'no committed delta');
  });

  it('fails closed with a reason when git errors while splitting', () => {
    const verdict = judge(() => ({ status: 128, stdout: '' }));
    assert.equal(verdict.eligible, false);
    assert.equal(verdict.reason, 'own-fix: git rev-list failed');
  });

  it('refuses an own commit when no base ref is known', () => {
    const spawn = () => ({
      status: 0,
      stdout: `${'b'.repeat(40)} ${COMMIT}\n`,
    });
    const verdict = judge(spawn, { baseRef: undefined });
    assert.equal(
      verdict.reason,
      'own-fix: no base ref to attribute own commits against',
    );
  });

  it('honours nonInputGlobs and a non-test own file', () => {
    const own = 'b'.repeat(40);
    const spawn = (_cwd, ...args) => {
      const out = {
        'rev-list': `${own} ${COMMIT}\n`,
        'diff-tree': 'M\tsrc/a.js\nM\tdocs/x.md\n',
      }[args[0]];
      return args[0] === 'merge-base'
        ? { status: 1 }
        : { status: 0, stdout: out };
    };
    const verdict = judge(spawn, {
      coverage: { ...KEY, nonInputGlobs: ['docs/**'] },
    });
    assert.equal(verdict.ownFix.own, 1);
    assert.equal(verdict.ownFix.base, 0);
  });
});
