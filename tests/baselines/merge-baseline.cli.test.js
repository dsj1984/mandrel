/**
 * merge-baseline.cli.test.js — the git merge-driver contract (Story #5215).
 *
 * Exercises `.agents/scripts/merge-baseline.js` as git invokes it
 * (`%O %A %B %P`, result written into `%A`), including a real `git rebase`
 * with the driver registered — the only leg that proves the registration
 * plumbing, not just the merge maths.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertEnvelope } from '../../.agents/scripts/lib/baselines/envelope.js';
import { getKindModule } from '../../.agents/scripts/lib/baselines/kernel.js';
import { refreshBaseline } from '../../.agents/scripts/lib/baselines/refresh-service.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { seedGitIdentity } from '../fixtures/git-fixture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const DRIVER = path.join(REPO_ROOT, '.agents/scripts/merge-baseline.js');
const FIXTURES = path.join(HERE, 'fixtures/merge');

const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

/** Run the driver the way git does. */
function runDriver(
  basePath,
  oursPath,
  theirsPath,
  mergedPath = 'baselines/x.json',
) {
  return spawnSync(
    process.execPath,
    [DRIVER, basePath, oursPath, theirsPath, mergedPath],
    { encoding: 'utf8', cwd: REPO_ROOT, env: CLEAN_ENV },
  );
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const byPath = (env) => Object.fromEntries(env.rows.map((r) => [r.path, r.mi]));

/** Materialise the three sides of a merge into a scratch dir. */
function stage(dir, { base, ours, theirs }) {
  const paths = {
    base: path.join(dir, 'base.json'),
    ours: path.join(dir, 'ours.json'),
    theirs: path.join(dir, 'theirs.json'),
  };
  const write = (p, v) =>
    fs.writeFileSync(
      p,
      typeof v === 'string' ? v : `${JSON.stringify(v, null, 2)}\n`,
    );
  write(paths.base, base);
  write(paths.ours, ours);
  write(paths.theirs, theirs);
  return paths;
}

function miEnvelope(rowsMap, generatedAt) {
  const mod = getKindModule('maintainability');
  const rows = mod.sortRows(
    Object.entries(rowsMap).map(([p, mi]) => ({ path: p, mi })),
  );
  return {
    $schema: '.agents/schemas/baselines/maintainability.schema.json',
    kernelVersion: '0.1.0',
    generatedAt,
    rollup: mod.rollup(rows, []),
    rows,
  };
}

describe('merge-baseline --help (AC-12)', () => {
  it('exits 0, prints the driver contract, and touches no file', () => {
    const dir = makeTempDir('mandrel-merge-help-');
    const sentinel = path.join(dir, 'baselines.json');
    fs.writeFileSync(sentinel, 'untouched');

    const res = spawnSync(process.execPath, [DRIVER, '--help'], {
      encoding: 'utf8',
      cwd: dir,
      env: CLEAN_ENV,
    });

    assert.equal(res.status, 0);
    assert.match(res.stdout, /%O %A %B %P/);
    assert.match(res.stdout, /merge-baseline/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('merge-baseline — disjoint refreshes merge clean (AC-1)', () => {
  it('exits 0 and writes both sides moved rows, a recomputed rollup and the later stamp', () => {
    const dir = makeTempDir('mandrel-merge-clean-');
    const paths = stage(dir, {
      base: miEnvelope(
        { 'a.js': 60, 'b.js': 70, 'c.js': 80 },
        '2026-09-01T00:00:00.000Z',
      ),
      ours: miEnvelope(
        { 'a.js': 61, 'b.js': 70, 'c.js': 80 },
        '2026-09-02T00:00:00.000Z',
      ),
      theirs: miEnvelope(
        { 'a.js': 60, 'b.js': 70, 'c.js': 83 },
        '2026-09-03T00:00:00.000Z',
      ),
    });

    const res = runDriver(
      paths.base,
      paths.ours,
      paths.theirs,
      'baselines/maintainability.json',
    );
    assert.equal(res.status, 0, res.stderr);

    const merged = readJson(paths.ours);
    assert.deepEqual(byPath(merged), { 'a.js': 61, 'b.js': 70, 'c.js': 83 });
    assert.equal(merged.generatedAt, '2026-09-03T00:00:00.000Z');
    assert.deepEqual(
      merged.rollup,
      getKindModule('maintainability').rollup(merged.rows, []),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('merge-baseline — a genuine double move conflicts, alone (AC-2)', () => {
  it('exits 1, names kind and identity on stderr, and wraps only that row', () => {
    const dir = makeTempDir('mandrel-merge-conflict-');
    const paths = stage(dir, {
      base: miEnvelope(
        { 'a.js': 60, 'b.js': 70, 'c.js': 80 },
        '2026-09-01T00:00:00.000Z',
      ),
      // ours moves a.js AND c.js; theirs moves a.js differently. Only a.js
      // is a real double move — c.js must survive merged, outside markers.
      ours: miEnvelope(
        { 'a.js': 61, 'b.js': 70, 'c.js': 88 },
        '2026-09-02T00:00:00.000Z',
      ),
      theirs: miEnvelope(
        { 'a.js': 62, 'b.js': 70, 'c.js': 80 },
        '2026-09-03T00:00:00.000Z',
      ),
    });

    const res = runDriver(
      paths.base,
      paths.ours,
      paths.theirs,
      'baselines/maintainability.json',
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /maintainability/);
    assert.match(res.stderr, /a\.js/);

    const text = fs.readFileSync(paths.ours, 'utf8');
    assert.equal((text.match(/^<<<<<<< /gm) ?? []).length, 1);
    assert.equal((text.match(/^>>>>>>> /gm) ?? []).length, 1);

    const marked = text.slice(text.indexOf('<<<<<<<'), text.indexOf('>>>>>>>'));
    assert.match(marked, /"mi": 61/);
    assert.match(marked, /"mi": 62/);
    assert.ok(!marked.includes('c.js'), 'only the double-moved row is wrapped');

    // The disjoint move survives, merged, outside the conflict region.
    const outside = text.replace(/<<<<<<<[\s\S]*?>>>>>>> theirs\n?/, '');
    assert.match(outside, /"mi": 88/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('merge-baseline — CRAP sibling rows (AC-3)', () => {
  it('moves the identified method and leaves its file-sibling byte-identical', () => {
    const dir = makeTempDir('mandrel-merge-crap-');
    const mod = getKindModule('crap');
    const sibling = {
      path: 'a/b.js',
      method: 'sibling',
      startLine: 40,
      crap: 12,
    };
    const target = { path: 'a/b.js', method: 'target', startLine: 7, crap: 3 };
    const env = (rows, generatedAt) => ({
      $schema: '.agents/schemas/baselines/crap.schema.json',
      kernelVersion: '0.1.0',
      generatedAt,
      rollup: mod.rollup(mod.sortRows(rows), []),
      rows: mod.sortRows(rows),
    });

    const paths = stage(dir, {
      base: env([target, sibling], '2026-09-01T00:00:00.000Z'),
      ours: env([{ ...target, crap: 9 }, sibling], '2026-09-02T00:00:00.000Z'),
      theirs: env([target, sibling], '2026-09-03T00:00:00.000Z'),
    });

    const res = runDriver(
      paths.base,
      paths.ours,
      paths.theirs,
      'baselines/crap.json',
    );
    assert.equal(res.status, 0, res.stderr);

    const merged = readJson(paths.ours);
    const byIdentity = Object.fromEntries(
      merged.rows.map((r) => [mod.rowIdentity(r), r]),
    );
    assert.equal(byIdentity['a/b.js::target@7'].crap, 9);
    assert.deepEqual(byIdentity['a/b.js::sibling@40'], sibling);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('merge-baseline — the swarm-os reproduction (AC-4)', () => {
  it('git merge-file conflicts on these blobs; the driver merges them', () => {
    const dir = makeTempDir('mandrel-merge-swarmos-');
    const base = path.join(FIXTURES, 'maintainability.base.json');
    const main = path.join(FIXTURES, 'maintainability.main.json');
    const branchCopy = path.join(dir, 'ours.json');

    // 1. The text merge these fixtures mirror: a conflict, on the stamp.
    fs.copyFileSync(
      path.join(FIXTURES, 'maintainability.branch.json'),
      branchCopy,
    );
    const textMerge = spawnSync('git', ['merge-file', branchCopy, base, main], {
      encoding: 'utf8',
      env: CLEAN_ENV,
    });
    assert.notEqual(textMerge.status, 0, 'fixture must reproduce the bug');
    assert.match(fs.readFileSync(branchCopy, 'utf8'), /generatedAt/);

    // 2. The driver, on the same three blobs.
    fs.copyFileSync(
      path.join(FIXTURES, 'maintainability.branch.json'),
      branchCopy,
    );
    const res = runDriver(
      base,
      branchCopy,
      main,
      'baselines/maintainability.json',
    );
    assert.equal(res.status, 0, res.stderr);

    const merged = readJson(branchCopy);
    const expected = { ...byPath(readJson(main)) };
    const branchRows = byPath(
      readJson(path.join(FIXTURES, 'maintainability.branch.json')),
    );
    expected['news/blocks/canvas-model.ts'] =
      branchRows['news/blocks/canvas-model.ts'];
    expected['news/news-view.ts'] = branchRows['news/news-view.ts'];

    // Compared by row key, not row count.
    assert.deepEqual(byPath(merged), expected);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('merge-baseline — unrecognised baselines keep git text merge (AC-10)', () => {
  // `baselines/*.json` also matches arch-cycles, audit-ledger,
  // context-budget and workflow-citations — files with their own shapes and
  // no row identity. Registering the driver must not change their behaviour
  // at all. (`cyclomatic` and `dead-exports*` LEFT this set in Story #5277;
  // they are row sets with a real identity and now merge as such.)
  const archCycles = (rows, generatedAt) => ({
    $schema: 'https://mandrel.dev/baselines/arch-cycles.schema.json',
    generatedAt,
    ceiling: 20,
    rows,
  });

  for (const [label, ours, theirs] of [
    ['a clean text merge', { a: 1, b: 2 }, { a: 1, c: 3 }],
    ['a conflicting text merge', { a: 9 }, { a: 7 }],
  ]) {
    it(`matches git merge-file exit code and bytes for ${label}`, () => {
      const dir = makeTempDir('mandrel-merge-nonenv-');
      const base = archCycles(
        [{ path: 'x.js', cc: 1 }],
        '2026-09-01T00:00:00.000Z',
      );
      const sides = {
        base,
        ours: archCycles(
          Object.entries(ours).map(([p, cc]) => ({ path: `${p}.js`, cc })),
          '2026-09-02T00:00:00.000Z',
        ),
        theirs: archCycles(
          Object.entries(theirs).map(([p, cc]) => ({ path: `${p}.js`, cc })),
          '2026-09-03T00:00:00.000Z',
        ),
      };
      const viaDriver = stage(dir, sides);
      const viaGit = stage(fs.mkdtempSync(path.join(dir, 'git-')), sides);

      const driverRes = runDriver(
        viaDriver.base,
        viaDriver.ours,
        viaDriver.theirs,
        'baselines/arch-cycles.json',
      );
      const gitRes = spawnSync(
        'git',
        ['merge-file', viaGit.ours, viaGit.base, viaGit.theirs],
        { encoding: 'utf8', env: CLEAN_ENV },
      );

      assert.equal(driverRes.status, gitRes.status);
      // git labels conflict markers with the paths it was handed, and the
      // two runs are staged in different scratch dirs — normalise those
      // labels so the comparison is about content, not tempdir names.
      const normalise = (file, staged) =>
        fs
          .readFileSync(file, 'utf8')
          .replaceAll(staged.ours, '<ours>')
          .replaceAll(staged.theirs, '<theirs>')
          .replaceAll(staged.base, '<base>');
      assert.equal(
        normalise(viaDriver.ours, viaDriver),
        normalise(viaGit.ours, viaGit),
      );
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
});

describe('merge-baseline — registered in a real repository (AC-5)', () => {
  it('a rebase of two disjoint diff-scoped refreshes completes with no conflict', async () => {
    const dir = makeTempDir('mandrel-merge-rebase-');
    const git = (...args) =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: CLEAN_ENV,
      });

    git('init', '-q', '-b', 'main');
    seedGitIdentity(dir);
    // Register through `git config` rather than by appending INI: a
    // backslash is an ESCAPE character in a git config value, so writing a
    // native Windows path by hand yields `fatal: bad config line`. Both
    // paths are also forward-slashed and quoted — git runs a merge driver
    // through a shell, where backslashes are escapes too and a path may
    // contain spaces.
    const posix = (p) => p.replaceAll('\\', '/');
    git(
      'config',
      'merge.mandrel-baseline.driver',
      `"${posix(process.execPath)}" "${posix(DRIVER)}" %O %A %B %P`,
    );
    fs.writeFileSync(
      path.join(dir, '.gitattributes'),
      'baselines/*.json merge=mandrel-baseline\n',
    );

    const writePath = path.join(dir, 'baselines', 'maintainability.json');
    const ROWS = {
      'news/news-view.ts': 58.4,
      'site-analytics/report.ts': 71.2,
      'shared/util.ts': 80.3,
    };
    const scorerFor = (overrides) => () =>
      Object.entries({ ...ROWS, ...overrides }).map(([p, mi]) => ({
        path: p,
        mi,
      }));

    // Seed main with the ancestor baseline.
    await refreshBaseline({
      kind: 'maintainability',
      writePath,
      fullScope: true,
      generatedAt: '2026-09-01T00:00:00.000Z',
      scorer: scorerFor({}),
      cwd: dir,
    });
    git('add', '-A');
    git('commit', '-q', '-m', 'seed baselines');

    // Branch one: a diff-scoped refresh of site-analytics/report.ts.
    git('checkout', '-q', '-b', 'story-one');
    await refreshBaseline({
      kind: 'maintainability',
      writePath,
      scopeFiles: ['site-analytics/report.ts'],
      generatedAt: '2026-09-02T00:00:00.000Z',
      scorer: scorerFor({ 'site-analytics/report.ts': 72.8 }),
      cwd: dir,
    });
    git('commit', '-q', '-am', 'refresh site-analytics row');

    // Branch two, from the same ancestor: a DISJOINT row.
    git('checkout', '-q', 'main');
    git('checkout', '-q', '-b', 'story-two');
    await refreshBaseline({
      kind: 'maintainability',
      writePath,
      scopeFiles: ['news/news-view.ts'],
      generatedAt: '2026-09-03T00:00:00.000Z',
      scorer: scorerFor({ 'news/news-view.ts': 59.7 }),
      cwd: dir,
    });
    git('commit', '-q', '-am', 'refresh news row');

    // The rebase that used to conflict on line 4.
    const rebase = spawnSync('git', ['rebase', 'story-one'], {
      cwd: dir,
      encoding: 'utf8',
      env: CLEAN_ENV,
    });
    assert.equal(
      rebase.status,
      0,
      `rebase must complete with no conflict:\n${rebase.stdout}\n${rebase.stderr}`,
    );

    // Both sides moved values survive, and the rollup describes the result.
    const merged = readJson(writePath);
    const rows = byPath(merged);
    assert.equal(rows['site-analytics/report.ts'], 72.8);
    assert.equal(rows['news/news-view.ts'], 59.7);
    assert.equal(rows['shared/util.ts'], 80.3);

    // The two properties `check-baselines` reports on the merged result:
    // zero schema errors and zero regressions. They are asserted through the
    // gate's own primitives rather than by spawning the CLI, because the CLI
    // resolves its base from `origin/main` and its gate list from a project
    // config — neither of which a synthetic repo has, so spawning it here
    // would exercise remote plumbing rather than the driver. The CLI itself
    // runs against the real repository as a `verify[]` line.
    assertEnvelope(merged); // schema errors: 0
    const mod = getKindModule('maintainability');
    assert.deepEqual(merged.rollup, mod.rollup(merged.rows, []));
    const base = JSON.parse(
      execFileSync('git', ['show', 'main:baselines/maintainability.json'], {
        cwd: dir,
        encoding: 'utf8',
        env: CLEAN_ENV,
      }),
    );
    const verdict = mod.compare(merged, base);
    assert.deepEqual(
      verdict.regressions.map((r) => r.key),
      [],
      'a merged baseline must carry no regression against its ancestor',
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('merge-baseline — an envelope-level conflict is visible in the file (AC-8)', () => {
  it('wraps a kernelVersion double-bump in conflict markers and exits 1', () => {
    // A `kernelVersion` disagreement means the two sides were scored by
    // different scorers. Before Story #5277 the driver reported that on stderr
    // and left the ours-side value in the file with no marker in it — so git
    // marked the path unmerged and the operator opened a file that looked
    // cleanly merged, with nothing in it saying which stamp disagreed.
    const dir = makeTempDir('mandrel-merge-stamp-');
    const withKernel = (env, kernelVersion) => ({ ...env, kernelVersion });
    const paths = stage(dir, {
      base: withKernel(
        miEnvelope({ 'a.js': 60 }, '2026-09-01T00:00:00.000Z'),
        '1.0.0',
      ),
      ours: withKernel(
        miEnvelope({ 'a.js': 60 }, '2026-09-02T00:00:00.000Z'),
        '2.0.0',
      ),
      theirs: withKernel(
        miEnvelope({ 'a.js': 60 }, '2026-09-03T00:00:00.000Z'),
        '3.0.0',
      ),
    });

    const res = runDriver(
      paths.base,
      paths.ours,
      paths.theirs,
      'baselines/maintainability.json',
    );

    assert.equal(res.status, 1, 'a stamp conflict is a conflict');
    const text = fs.readFileSync(paths.ours, 'utf8');
    assert.match(text, /^<<<<<<< ours$/m);
    assert.match(text, /^ {2}"kernelVersion": "2\.0\.0",$/m);
    assert.match(text, /^=======$/m);
    assert.match(text, /^ {2}"kernelVersion": "3\.0\.0",$/m);
    assert.match(text, /^>>>>>>> theirs$/m);
    // The rest of the file is untouched: the markers wrap whole lines around
    // exactly the bytes a clean merge would have written.
    assert.match(text, /"rows": \[/);
    assert.match(res.stderr, /envelope key "kernelVersion"/);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names the regenerate command on a delete-vs-modify row conflict', () => {
    // Ours deletes the row, theirs moves it. Either resolution leaves the
    // rollup describing a row set nobody scored — resolving the markers by
    // hand does not recompute it, so the driver has to say so.
    const dir = makeTempDir('mandrel-merge-delmod-');
    const paths = stage(dir, {
      base: miEnvelope({ 'a.js': 60, 'b.js': 70 }, '2026-09-01T00:00:00.000Z'),
      ours: miEnvelope({ 'b.js': 70 }, '2026-09-02T00:00:00.000Z'),
      theirs: miEnvelope(
        { 'a.js': 64, 'b.js': 70 },
        '2026-09-03T00:00:00.000Z',
      ),
    });

    const res = runDriver(
      paths.base,
      paths.ours,
      paths.theirs,
      'baselines/maintainability.json',
    );

    assert.equal(res.status, 1);
    assert.match(res.stderr, /row "a\.js"/);
    assert.match(res.stderr, /must not be trusted/);
    assert.match(res.stderr, /npm run maintainability:update/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('merge-baseline — plain row baselines merge by identity (AC-9)', () => {
  const cyclomatic = (rowsMap, generatedAt) => ({
    $schema: 'https://mandrel.dev/baselines/cyclomatic.schema.json',
    generatedAt,
    ceiling: 12,
    rollup: {
      '*': {
        filesAboveCeiling: Object.keys(rowsMap).length,
        methodsAboveCeiling: Object.values(rowsMap).reduce((a, b) => a + b, 0),
        maxCyclomatic: Math.max(
          0,
          ...Object.values(rowsMap).map((n) => n + 12),
        ),
      },
    },
    rows: Object.entries(rowsMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, n]) => ({
        file,
        methodsAboveCeiling: n,
        maxCyclomatic: n + 12,
      })),
  });

  const deadExports = (rows, generatedAt, mode) => {
    const env = {
      $schema: 'https://mandrel.dev/baselines/dead-exports.schema.json',
      kernelVersion: '6.17.1',
      generatedAt,
    };
    if (mode) env.mode = mode;
    env.rows = [...rows].sort(
      (a, b) =>
        a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol),
    );
    return env;
  };

  it('merges cyclomatic by file, with no conflict and the later stamp', () => {
    const dir = makeTempDir('mandrel-merge-cyclo-');
    const paths = stage(dir, {
      base: cyclomatic(
        { 'a.js': 1, 'b.js': 2, 'c.js': 3 },
        '2026-09-01T00:00:00.000Z',
      ),
      ours: cyclomatic(
        { 'a.js': 4, 'b.js': 2, 'c.js': 3 },
        '2026-09-02T00:00:00.000Z',
      ),
      theirs: cyclomatic(
        { 'a.js': 1, 'b.js': 2, 'c.js': 6 },
        '2026-09-03T00:00:00.000Z',
      ),
    });

    const res = runDriver(
      paths.base,
      paths.ours,
      paths.theirs,
      'baselines/cyclomatic.json',
    );
    assert.equal(res.status, 0, res.stderr);

    const merged = readJson(paths.ours);
    const byFile = Object.fromEntries(
      merged.rows.map((r) => [r.file, r.methodsAboveCeiling]),
    );
    assert.deepEqual(byFile, { 'a.js': 4, 'b.js': 2, 'c.js': 6 });
    assert.equal(merged.generatedAt, '2026-09-03T00:00:00.000Z');
    // The rollup is DERIVED, not merged. Both sides wrote the same three
    // counts (each moved one row), so a 3-way merge of the rollup would have
    // resolved clean to numbers that describe neither side's row set.
    assert.deepEqual(merged.rollup['*'], {
      filesAboveCeiling: 3,
      methodsAboveCeiling: 12,
      maxCyclomatic: 18,
    });
    // Byte-identical to what the generator writes for these rows.
    assert.equal(
      fs.readFileSync(paths.ours, 'utf8'),
      `${JSON.stringify(
        {
          $schema: merged.$schema,
          generatedAt: merged.generatedAt,
          ceiling: 12,
          rollup: merged.rollup,
          rows: merged.rows,
        },
        null,
        2,
      )}\n`,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const [label, mode, merged] of [
    ['dead-exports', undefined, 'baselines/dead-exports.json'],
    [
      'dead-exports-production',
      'production',
      'baselines/dead-exports-production.json',
    ],
  ]) {
    it(`merges ${label} by file::symbol`, () => {
      // The shape git splices most happily and least visibly: a long, uniform
      // list of two-key objects where every line looks like every other.
      const dir = makeTempDir('mandrel-merge-dead-');
      const shared = { file: 'lib/keep.js', symbol: 'kept' };
      const paths = stage(dir, {
        base: deadExports([shared], '2026-09-01T00:00:00.000Z', mode),
        ours: deadExports(
          [shared, { file: 'lib/a.js', symbol: 'alpha' }],
          '2026-09-02T00:00:00.000Z',
          mode,
        ),
        theirs: deadExports(
          [shared, { file: 'lib/b.js', symbol: 'beta' }],
          '2026-09-03T00:00:00.000Z',
          mode,
        ),
      });

      const res = runDriver(paths.base, paths.ours, paths.theirs, merged);
      assert.equal(res.status, 0, res.stderr);

      const out = readJson(paths.ours);
      assert.deepEqual(
        out.rows.map((r) => `${r.file}::${r.symbol}`),
        ['lib/a.js::alpha', 'lib/b.js::beta', 'lib/keep.js::kept'],
      );
      assert.equal(out.generatedAt, '2026-09-03T00:00:00.000Z');
      assert.equal(out.mode, mode);
      // Rollup-less: the generator writes none, so the merge invents none.
      assert.equal(Object.hasOwn(out, 'rollup'), false);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  it('conflicts on a row both sides moved differently, naming the regenerate command', () => {
    const dir = makeTempDir('mandrel-merge-cyclo-conflict-');
    const paths = stage(dir, {
      base: cyclomatic({ 'a.js': 1 }, '2026-09-01T00:00:00.000Z'),
      ours: cyclomatic({ 'a.js': 4 }, '2026-09-02T00:00:00.000Z'),
      theirs: cyclomatic({ 'a.js': 7 }, '2026-09-03T00:00:00.000Z'),
    });
    const res = runDriver(
      paths.base,
      paths.ours,
      paths.theirs,
      'baselines/cyclomatic.json',
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /row "a\.js"/);
    assert.match(res.stderr, /npm run cyclomatic:update/);
    assert.match(fs.readFileSync(paths.ours, 'utf8'), /^<<<<<<< ours$/m);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
