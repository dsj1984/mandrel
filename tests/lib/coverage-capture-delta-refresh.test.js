import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { getChangedFiles } from '../../.agents/scripts/lib/changed-files.js';
import {
  captureStampPath,
  computeContentDigest,
  filterFilesUnderTargets,
  isCoverageFresh,
  writeCaptureStamp,
} from '../../.agents/scripts/lib/coverage-capture.js';
import { tryScopedCapture } from '../../.agents/scripts/lib/coverage-capture-affected.js';
import {
  formatFreshnessDetail,
  isCoverageConfigFile,
} from '../../.agents/scripts/lib/coverage-capture-delta.js';
import { runFullScopeCapture } from '../../.agents/scripts/lib/coverage-capture-fullscope.js';
import { tryIncrementalCapture } from '../../.agents/scripts/lib/coverage-capture-incremental.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

// Story #5487 — a base-sync that merges main commits sharing no file with the
// Story re-measures only main's delta. Real git fixture repos; the suite
// runner is always a stub that records its env and writes an artifact.

// A hook-launched run inherits GIT_DIR & co., which would point every git
// call below (fixture and production alike) at the enclosing repository.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_')) delete process.env[key];
}

const BASE_REF_ENV = 'MANDREL_COVERAGE_BASE_REF';
const CRAP = {
  enabled: true,
  targetDirs: ['src'],
  coveragePath: 'coverage/coverage-final.json',
};
const SHARED_LINES = Array.from(
  { length: 12 },
  (_, i) => `export const v${i} = ${i};`,
);

function fixtureRepo() {
  const dir = makeTempDir('delta-refresh-');
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  const commit = (msg) => {
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  git('config', 'commit.gpgsign', 'false');
  write('.gitignore', 'coverage/\n');
  write('src/a.js', 'export const a = 1;\n');
  write('src/b.js', 'export const b = 1;\n');
  write('src/shared.js', `${SHARED_LINES.join('\n')}\n`);
  commit('base');
  git('checkout', '-q', '-b', 'story');
  write('src/a.js', 'export const a = 2;\n');
  const lines = [...SHARED_LINES];
  lines[0] = 'export const v0 = "story";';
  write('src/shared.js', `${lines.join('\n')}\n`);
  commit('story work');

  /** Commit `files` on main, then merge main into the Story branch. */
  const baseSync = (files) => {
    git('checkout', '-q', 'main');
    for (const [rel, body] of Object.entries(files)) write(rel, body);
    commit('main moves');
    git('checkout', '-q', 'story');
    git('merge', '-q', '--no-edit', 'main');
    return git('rev-parse', 'HEAD');
  };
  const stampPath = captureStampPath(dir, CRAP.coveragePath);
  const readStamp = () => JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  const editStamp = (fn) =>
    fs.writeFileSync(stampPath, JSON.stringify(fn(readStamp())));
  return { dir, git, write, commit, baseSync, readStamp, editStamp };
}

async function capture(
  dir,
  { code = 0, captureScope = 'affected', hasScript = true } = {},
) {
  const calls = [];
  const log = [];
  const logger = {
    info: (m) => log.push(m),
    warn: (m) => log.push(m),
    error: (m) => log.push(m),
  };
  const result = await tryScopedCapture({
    crap: CRAP,
    coverage: { captureScope, timeoutMs: 1000 },
    args: { ref: 'main', cwd: dir },
    readPackageScriptsImpl: () => ({}),
    hasNpmScriptImpl: (_s, name) =>
      hasScript && name === 'test:coverage:affected',
    getChangedFilesImpl: getChangedFiles,
    filterFilesUnderTargetsImpl: filterFilesUnderTargets,
    isCoverageFreshImpl: isCoverageFresh,
    runCaptureImpl: async (opts) => {
      calls.push(opts);
      const artifact = path.join(dir, CRAP.coveragePath);
      fs.mkdirSync(path.dirname(artifact), { recursive: true });
      fs.writeFileSync(
        artifact,
        JSON.stringify({
          [path.join(dir, 'src/b.js')]: { s: { 0: calls.length } },
        }),
      );
      return code;
    },
    computeContentDigestImpl: computeContentDigest,
    writeCaptureStampImpl: writeCaptureStamp,
    logger,
  });
  return { result, calls, log: log.join('\n') };
}

const freshAffected = (dir) =>
  isCoverageFresh({
    coveragePath: CRAP.coveragePath,
    targetDirs: CRAP.targetDirs,
    cwd: dir,
    requireScope: 'affected',
  }).fresh;

describe('delta refresh after a base-sync (captureScope: affected)', () => {
  it('AC-1: the first capture stamps the measured commit', async () => {
    const repo = fixtureRepo();
    const first = await capture(repo.dir);
    assert.equal(first.result, 0);
    assert.equal(first.calls[0].env[BASE_REF_ENV], 'main');
    assert.equal(repo.readStamp().commit, repo.git('rev-parse', 'HEAD'));
    assert.equal(freshAffected(repo.dir), true);
  });

  it('AC-2: an unrelated base-sync runs the affected runner keyed on the stamped commit', async () => {
    const repo = fixtureRepo();
    await capture(repo.dir);
    const stamped = repo.readStamp().commit;
    const merged = repo.baseSync({ 'src/b.js': 'export const b = 2;\n' });

    assert.equal(freshAffected(repo.dir), false);
    const second = await capture(repo.dir);
    assert.equal(second.result, 0);
    assert.equal(second.calls.length, 1);
    assert.equal(second.calls[0].env[BASE_REF_ENV], stamped);
    assert.equal(freshAffected(repo.dir), true);
    assert.equal(repo.readStamp().commit, merged);
    assert.equal(repo.readStamp().scope, 'affected');
    // AC-5: the delta-refresh line names the verdict and the delta size.
    assert.match(
      second.log,
      /stamp scope: affected, required scope: affected, verdict: delta-refresh, delta: 1 file\(s\)/,
    );
  });

  it('AC-4: a failing delta refresh is a red capture, never a fallback', async () => {
    const repo = fixtureRepo();
    await capture(repo.dir);
    const stamped = repo.readStamp().commit;
    repo.baseSync({ 'src/b.js': 'export const b = 2;\n' });
    const second = await capture(repo.dir, { code: 1 });
    assert.equal(second.result, 1);
    assert.equal(second.calls.length, 1);
    assert.equal(second.calls[0].env[BASE_REF_ENV], stamped);
    assert.equal(freshAffected(repo.dir), false);
  });

  it('AC-5: freshness lines name the stamp scope, required scope and verdict', async () => {
    const repo = fixtureRepo();
    const first = await capture(repo.dir);
    assert.match(
      first.log,
      /stamp scope: none, required scope: affected, verdict: missing/,
    );
    const again = await capture(repo.dir);
    assert.equal(again.calls.length, 0);
    assert.match(
      again.log,
      /is fresh \(affected\) — skipping capture\. \(stamp scope: affected, required scope: affected, verdict: fresh\)/,
    );
  });
});

describe('delta refresh eligibility falls back to today’s capture (AC-3)', () => {
  const unrelated = { 'src/b.js': 'export const b = 2;\n' };

  async function assertFallback(repo, reason) {
    const second = await capture(repo.dir);
    assert.equal(second.result, 0);
    assert.equal(second.calls.length, 1);
    assert.equal(second.calls[0].env[BASE_REF_ENV], 'main');
    assert.match(second.log, /delta refresh not eligible/);
    assert.match(second.log, reason);
  }

  it('the delta shares a path with the Story change set', async () => {
    const repo = fixtureRepo();
    await capture(repo.dir);
    const lines = [...SHARED_LINES];
    lines[11] = 'export const v11 = "main";';
    repo.baseSync({ 'src/shared.js': `${lines.join('\n')}\n` });
    await assertFallback(repo, /shares src\/shared\.js/);
  });

  for (const config of [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'vitest.config.js',
  ]) {
    it(`the delta touches ${config}`, async () => {
      const repo = fixtureRepo();
      await capture(repo.dir);
      repo.baseSync({ ...unrelated, [config]: '{}\n' });
      await assertFallback(repo, /coverage-determining config/);
    });
  }

  it('the stamp records no commit', async () => {
    const repo = fixtureRepo();
    await capture(repo.dir);
    repo.editStamp(({ commit: _drop, ...rest }) => rest);
    repo.baseSync(unrelated);
    await assertFallback(repo, /no commit/);
  });

  it('the stamped commit is not an ancestor of HEAD', async () => {
    const repo = fixtureRepo();
    await capture(repo.dir);
    repo.git('checkout', '-q', '-b', 'elsewhere', 'main');
    repo.write('src/elsewhere.js', 'export const e = 1;\n');
    const foreign = repo.commit('elsewhere');
    repo.git('checkout', '-q', 'story');
    repo.editStamp((stamp) => ({ ...stamp, commit: foreign }));
    repo.baseSync(unrelated);
    await assertFallback(repo, /not an ancestor/);
  });

  it('the affected script is absent', async () => {
    const repo = fixtureRepo();
    await capture(repo.dir);
    repo.baseSync(unrelated);
    const second = await capture(repo.dir, { hasScript: false });
    assert.equal(second.result, null);
    assert.equal(second.calls.length, 0);
  });

  it('captureScope is full', async () => {
    const repo = fixtureRepo();
    await capture(repo.dir);
    repo.baseSync(unrelated);
    const second = await capture(repo.dir, { captureScope: 'full' });
    assert.equal(second.result, null);
    assert.equal(second.calls.length, 0);
  });
});

describe('freshness diagnostics on the other capture paths (AC-5)', () => {
  const stubs = (reason) => {
    const log = [];
    return {
      log,
      opts: {
        crap: { ...CRAP, incrementalCoverage: { skipWhenUnchanged: true } },
        coverage: {},
        args: { ref: 'main', cwd: path.resolve('/nonexistent-5487') },
        getChangedFilesImpl: () => ['src/a.js'],
        filterFilesUnderTargetsImpl: filterFilesUnderTargets,
        isCoverageFreshImpl: () => ({ fresh: reason === 'fresh', reason }),
        runCaptureImpl: async () => 0,
        computeContentDigestImpl: () => null,
        writeCaptureStampImpl: () => true,
        readHeadCommitImpl: () => null,
        logger: { info: (m) => log.push(m), warn: () => {}, error: () => {} },
      },
    };
  };

  it('full scope names required scope full', async () => {
    const h = stubs('stale');
    await runFullScopeCapture(h.opts);
    assert.match(
      h.log.join('\n'),
      /is stale; running npm run test:coverage… \(stamp scope: none, required scope: full, verdict: stale\)/,
    );
  });

  it('incremental scope names required scope incremental', async () => {
    const h = stubs('fresh');
    await tryIncrementalCapture(h.opts);
    assert.match(
      h.log.join('\n'),
      /required scope: incremental, verdict: fresh\)/,
    );
  });
});

describe('delta-refresh helpers', () => {
  it('recognises coverage-determining config by basename', () => {
    for (const f of [
      'package.json',
      'pkg/package.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'tsconfig.build.json',
      'jest.config.cjs',
      'vitest.workspace.ts',
      '.c8rc.json',
      '.nycrc',
    ]) {
      assert.equal(isCoverageConfigFile(f), true, f);
    }
    for (const f of ['src/b.js', 'baselines/crap.json', 'docs/package.md']) {
      assert.equal(isCoverageConfigFile(f), false, f);
    }
  });

  it('reads a scope-less stamp as full and no stamp as none', () => {
    const line = (stamp) =>
      formatFreshnessDetail({ stamp, requiredScope: 'full', verdict: 'stale' });
    assert.match(line({ digest: 'd' }), /stamp scope: full/);
    assert.match(line(null), /stamp scope: none/);
    assert.doesNotMatch(line(null), /delta/);
  });
});
