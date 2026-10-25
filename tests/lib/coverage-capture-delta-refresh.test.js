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
import {
  closeDeltaIneligibility,
  formatFreshnessDetail,
  isCoverageConfigFile,
} from '../../.agents/scripts/lib/coverage-capture-delta.js';
import { runFullScopeCapture } from '../../.agents/scripts/lib/coverage-capture-fullscope.js';
import { tryIncrementalCapture } from '../../.agents/scripts/lib/coverage-capture-incremental.js';
import {
  copyGitRepo,
  makeGitTemplate,
  runGit,
  writeFiles,
} from '../fixtures/git-fixture.js';

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

const UNRELATED = { 'src/b.js': 'export const b = 2;\n' };
const BASELINE = { 'baselines/coverage.json': '{"main":1}\n' };
const SHARED_ON_MAIN = [...SHARED_LINES];
SHARED_ON_MAIN[11] = 'export const v11 = "main";';
const CONFIGS = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vitest.config.js',
];
/** Each base-sync's main-side commit, prebuilt once on a `sync/<name>` branch. */
const SYNCS = {
  unrelated: UNRELATED,
  shared: { ...BASELINE, 'src/shared.js': `${SHARED_ON_MAIN.join('\n')}\n` },
  // Story #5903: suite input outside targetDirs; baseline-only; mixed.
  script: { 'scripts/tool.js': 'export const t = 1;\n' },
  baseline: BASELINE,
  mixed: { ...UNRELATED, ...BASELINE },
  ...Object.fromEntries(
    CONFIGS.map((config) => [config, { ...UNRELATED, [config]: '{}\n' }]),
  ),
};

let template;
let stamped;

before(async () => {
  template = makeGitTemplate({
    prefix: 'delta-refresh-',
    files: {
      '.gitignore': 'coverage/\n',
      'src/a.js': 'export const a = 1;\n',
      'src/b.js': 'export const b = 1;\n',
      'src/shared.js': `${SHARED_LINES.join('\n')}\n`,
    },
  });
  const t = repoAt(template);
  for (const [name, files] of Object.entries(SYNCS)) {
    t.git('checkout', '-q', '-b', `sync/${name}`, 'main');
    writeFiles(template, files);
    t.commit('main moves');
  }
  t.git('checkout', '-q', '-b', 'story', 'main');
  writeFiles(template, { 'src/a.js': 'export const a = 2;\n' });
  const lines = [...SHARED_LINES];
  lines[0] = 'export const v0 = "story";';
  writeFiles(template, { 'src/shared.js': `${lines.join('\n')}\n` });
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
  const stampPath = captureStampPath(dir, CRAP.coveragePath);
  const readStamp = () => JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  const editStamp = (fn) =>
    fs.writeFileSync(stampPath, JSON.stringify(fn(readStamp())));
  return { dir, git, write, commit, baseSync, readStamp, editStamp };
}

/**
 * A private copy of the fixture: on `story`, one commit ahead of `main`, and
 * — when `captured` — already holding the first affected capture's stamp.
 */
function fixtureRepo({ captured = false } = {}) {
  const dir = copyGitRepo(captured ? stamped : template);
  if (captured) writeArtifact(dir, 1);
  return repoAt(dir);
}

/** The stub suite's artifact, keyed by this repository's own paths. */
function writeArtifact(dir, run) {
  const artifact = path.join(dir, CRAP.coveragePath);
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(
    artifact,
    JSON.stringify({ [path.join(dir, 'src/b.js')]: { s: { 0: run } } }),
  );
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
      writeArtifact(dir, calls.length);
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
    const repo = fixtureRepo({ captured: true });
    const stamped = repo.readStamp().commit;
    repo.baseSync('unrelated');
    const merged = repo.git('rev-parse', 'HEAD');

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
    const repo = fixtureRepo({ captured: true });
    const stamped = repo.readStamp().commit;
    repo.baseSync('unrelated');
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

// Story #5903 — the planner shares the probe's staleness and suite-input overlap.
describe('delta refresh sees what the freshness probe sees (Story #5903)', () => {
  it('AC-1: tree-digest-only staleness plans a delta refresh on the stamped commit', async () => {
    const repo = fixtureRepo({ captured: true });
    const stamped = repo.readStamp().commit;
    repo.baseSync('script');
    const second = await capture(repo.dir);
    assert.equal(second.calls.length, 1);
    assert.equal(second.calls[0].env[BASE_REF_ENV], stamped);
    assert.doesNotMatch(second.log, /not stale by digest/);
    assert.equal(freshAffected(repo.dir), true);
  });

  it('AC-3: a stale stamp over a non-suite-input delta restamps without a run', async () => {
    const repo = fixtureRepo({ captured: true });
    repo.editStamp((stamp) => ({ ...stamp, treeDigest: 'f'.repeat(64) }));
    repo.baseSync('baseline');
    assert.equal(freshAffected(repo.dir), false);
    const second = await capture(repo.dir);
    assert.equal(second.result, 0);
    assert.equal(second.calls.length, 0);
    assert.match(second.log, /1 non-suite-input path\(s\) dropped/);
    assert.equal(freshAffected(repo.dir), true);
    assert.equal(repo.readStamp().commit, repo.git('rev-parse', 'HEAD'));
  });

  it('AC-5: the delta-refresh line reports the filtered count and the dropped paths', async () => {
    const repo = fixtureRepo({ captured: true });
    repo.baseSync('mixed');
    const second = await capture(repo.dir);
    assert.equal(second.calls.length, 1);
    assert.match(
      second.log,
      /re-measuring 1 file\(s\) changed since \w{12}, 1 non-suite-input path\(s\) dropped\..*delta: 1 file\(s\)\)/,
    );
  });
});

describe('delta refresh eligibility falls back to today’s capture (AC-3)', () => {
  async function assertFallback(repo, reason) {
    const second = await capture(repo.dir);
    assert.equal(second.result, 0);
    assert.equal(second.calls.length, 1);
    assert.equal(second.calls[0].env[BASE_REF_ENV], 'main');
    assert.match(second.log, /delta refresh not eligible/);
    assert.match(second.log, reason);
  }

  it('the delta shares a path with the Story change set', async () => {
    const repo = fixtureRepo({ captured: true });
    repo.baseSync('shared');
    await assertFallback(
      repo,
      /shares src\/shared\.js with the Story's change set; delta: 1 file\(s\), 1 non-suite-input path\(s\) dropped\)/,
    );
  });

  for (const config of CONFIGS) {
    it(`the delta touches ${config}`, async () => {
      const repo = fixtureRepo({ captured: true });
      repo.baseSync(config);
      await assertFallback(repo, /coverage-determining config/);
    });
  }

  it('the stamp records no commit', async () => {
    const repo = fixtureRepo({ captured: true });
    repo.editStamp(({ commit: _drop, ...rest }) => rest);
    repo.baseSync('unrelated');
    await assertFallback(repo, /no commit/);
  });

  it('the stamped commit is not an ancestor of HEAD', async () => {
    const repo = fixtureRepo({ captured: true });
    repo.git('checkout', '-q', '-b', 'elsewhere', 'main');
    repo.write('src/elsewhere.js', 'export const e = 1;\n');
    const foreign = repo.commit('elsewhere');
    repo.git('checkout', '-q', 'story');
    repo.editStamp((stamp) => ({ ...stamp, commit: foreign }));
    repo.baseSync('unrelated');
    await assertFallback(repo, /not an ancestor/);
  });

  it('the affected script is absent', async () => {
    const repo = fixtureRepo({ captured: true });
    repo.baseSync('unrelated');
    const second = await capture(repo.dir, { hasScript: false });
    assert.equal(second.result, null);
    assert.equal(second.calls.length, 0);
  });

  it('captureScope is full', async () => {
    const repo = fixtureRepo({ captured: true });
    repo.baseSync('unrelated');
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
      /is stale; running the test:coverage capture script… \(stamp scope: none, required scope: full, verdict: stale\)/,
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

// Story #5880 — close's `test` delta re-credit shares these rules.
describe('deltaIneligibility — the rules shared with close (Story #5880)', () => {
  const rule = (delta, storyFiles) =>
    closeDeltaIneligibility({ delta, storyFiles, config: {} });

  it('names a path shared with the Story change set', () => {
    assert.equal(
      rule(['src/a.js'], ['src/a.js']),
      "delta shares src/a.js with the Story's change set",
    );
  });

  it('names a coverage-determining config file', () => {
    assert.match(
      rule(['pnpm-lock.yaml'], []),
      /coverage-determining config pnpm-lock\.yaml/,
    );
  });

  it('passes a disjoint, config-free delta', () => {
    assert.equal(rule(['src/b.js'], ['src/a.js']), null);
  });

  it('AC-2: shared baseline and coverage-directory paths are not overlap', () => {
    const shared = ['baselines/coverage.json', 'coverage/lcov.info'];
    assert.equal(rule([...shared, 'src/b.js'], [...shared, 'src/a.js']), null);
  });

  it('names a delta with no suite-input path', () => {
    assert.equal(
      rule(['baselines/crap.json'], []),
      'delta has no suite-input path',
    );
  });

  it("AC-4: close's test delta and coverage-capture import the one rule, not a copy", () => {
    const read = (rel) =>
      fs.readFileSync(
        new URL(`../../.agents/scripts/lib/${rel}`, import.meta.url),
        'utf8',
      );
    assert.match(
      read('close-validation/test-delta.js'),
      /import \{ closeDeltaIneligibility \} from '\.\.\/coverage-capture-delta\.js';/,
    );
    const capture = read('coverage-capture-delta.js');
    // Close's entry point and the capture planner both call the shared rule.
    assert.match(
      capture,
      /export function closeDeltaIneligibility[\s\S]*?return deltaIneligibility\(\{ delta, storyFiles, coveragePath \}\)\.reason;/,
    );
    assert.match(capture, /const rule = deltaIneligibility\(\{/);
    assert.match(capture, /filterSuiteInputPaths\(delta, coveragePath\)/);
  });

  it('closeDeltaIneligibility keys the rule on the configured coverage path', () => {
    const config = {
      delivery: {
        quality: { gates: { crap: { coveragePath: 'cov/out.json' } } },
      },
    };
    assert.equal(
      closeDeltaIneligibility({
        delta: ['cov/lcov.info', 'baselines/crap.json'],
        storyFiles: [],
        config,
      }),
      'delta has no suite-input path',
    );
  });
});
