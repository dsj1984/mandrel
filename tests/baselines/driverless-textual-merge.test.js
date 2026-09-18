// tests/baselines/driverless-textual-merge.test.js
//
// Story #5400 — GitHub never runs the `mandrel-baseline` merge driver (not for
// PR mergeability, update-branch, or a merge queue), so two Stories that
// refresh disjoint baseline rows must merge as plain text. Each case writes a
// base baseline through the kind's real producer, forks two branches that edit
// disjoint, non-adjacent rows through the same producer, then runs `git merge`
// in a repo with NO gitattributes and NO driver configured.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertEnvelope } from '../../.agents/scripts/lib/baselines/envelope.js';
import { getKindModule } from '../../.agents/scripts/lib/baselines/kernel.js';
import { loadFile } from '../../.agents/scripts/lib/baselines/reader.js';
import {
  write,
  writeFile as writeEnvelopeFile,
} from '../../.agents/scripts/lib/baselines/writer.js';
import { buildCyclomaticEnvelope } from '../../.agents/scripts/lib/cyclomatic-ceiling.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { buildEnvelope as buildDeadExportsEnvelope } from '../../scripts/update-dead-exports-baseline.js';
import { seedGitIdentity } from '../fixtures/git-fixture.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const dispatcherBin = path.join(
  repoRoot,
  '.agents',
  'scripts',
  'check-baselines.js',
);

// A fixture `git init` under a husky hook's GIT_DIR would write into the
// shared main gitdir (#4580).
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

function git(args, cwd) {
  return spawnSync(
    'git',
    [
      '-c',
      'core.attributesFile=/dev/null',
      '-c',
      'merge.conflictStyle=merge',
      ...args,
    ],
    { cwd, encoding: 'utf8', env: CLEAN_ENV },
  );
}

function mustGit(args, cwd) {
  const res = git(args, cwd);
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function initRepo() {
  const root = makeTempDir('driverless-merge-');
  roots.push(root);
  mkdirSync(path.join(root, 'baselines'), { recursive: true });
  mustGit(['init', '--initial-branch=main'], root);
  seedGitIdentity(root);
  return root;
}

/**
 * Commit `base`, fork `ours`/`theirs` from it, and merge theirs into ours.
 *
 * @param {{ file: string, emit: (root: string, rows: object[]) => void, base: object[], ours: object[], theirs: object[] }} c
 * @returns {{ root: string, status: number, text: string }}
 */
function mergeCase({ file, emit, base, ours, theirs }) {
  const root = initRepo();
  emit(root, base);
  mustGit(['add', '-A'], root);
  mustGit(['commit', '-m', 'base'], root);
  mustGit(['checkout', '-b', 'theirs'], root);
  emit(root, theirs);
  mustGit(['commit', '-am', 'theirs'], root);
  mustGit(['checkout', 'main'], root);
  emit(root, ours);
  mustGit(['commit', '-am', 'ours'], root);
  const res = git(['merge', '--no-edit', 'theirs'], root);
  return {
    root,
    status: res.status,
    text: readFileSync(path.join(root, file), 'utf8'),
  };
}

function kernelEmitter(kind) {
  const file = `baselines/${kind}.json`;
  return {
    file,
    emit: (root, rows) =>
      writeEnvelopeFile(path.join(root, file), write({ kind, rows })),
  };
}

const PATHS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(
  (n) => `src/${n}.js`,
);

/**
 * Ours edits `src/b.js`; theirs edits `src/f.js` and inserts `src/d2.js`.
 * Rows `c`/`d` stay untouched between the two sides' hunks.
 */
function disjointEdits(rowFor, bump) {
  const base = PATHS.map((p) => rowFor(p));
  const ours = base.map((r) => (r.path === 'src/b.js' ? bump(r) : r));
  const theirs = [
    ...base.map((r) => (r.path === 'src/f.js' ? bump(r) : r)),
    rowFor('src/d2.js'),
  ];
  const merged = [
    ...base.map((r) =>
      r.path === 'src/b.js' || r.path === 'src/f.js' ? bump(r) : r,
    ),
    rowFor('src/d2.js'),
  ];
  return { base, ours, theirs, merged };
}

const KERNEL_CASES = [
  {
    kind: 'coverage',
    rowFor: (p) => ({ path: p, lines: 95, branches: 90, functions: 95 }),
    bump: (r) => ({ ...r, lines: 97.5 }),
  },
  {
    kind: 'maintainability',
    rowFor: (p) => ({ path: p, mi: 110 }),
    bump: (r) => ({ ...r, mi: 115.25 }),
  },
  {
    kind: 'duplication',
    rowFor: (p) => ({ path: p, duplicatedLines: 4, totalLines: 100 }),
    bump: (r) => ({ ...r, duplicatedLines: 2 }),
  },
  {
    kind: 'crap',
    rowFor: (p) => ({ path: p, method: 'run', startLine: 10, crap: 4 }),
    bump: (r) => ({ ...r, crap: 3 }),
  },
];

describe('driverless textual merge of row-set baselines (Story #5400)', () => {
  for (const { kind, rowFor, bump } of KERNEL_CASES) {
    it(`${kind}: disjoint non-adjacent refreshes merge clean and validate`, () => {
      const edits = disjointEdits(rowFor, bump);
      const { root, status, text } = mergeCase({
        ...kernelEmitter(kind),
        ...edits,
      });
      assert.equal(status, 0, `git merge conflicted:\n${text}`);
      const merged = JSON.parse(text);
      assert.equal(Object.hasOwn(merged, 'generatedAt'), false);
      assert.equal(Object.hasOwn(merged, 'rollup'), false);
      assertEnvelope(merged);
      const expected = write({ kind, rows: edits.merged });
      assert.deepEqual(merged.rows, expected.rows);
      const loaded = loadFile(path.join(root, `baselines/${kind}.json`), {
        kind,
      });
      assert.deepEqual(loaded.rows, expected.rows);
      assert.ok(getKindModule(kind).rollup(loaded.rows)['*']);
    });
  }

  it('cyclomatic: disjoint non-adjacent refreshes merge clean', () => {
    const file = 'baselines/cyclomatic.json';
    const rowFor = (p) => ({
      file: p,
      methodsAboveCeiling: 1,
      maxCyclomatic: 14,
    });
    const toRows = (paths, bumped) =>
      paths.map((p) => ({
        ...rowFor(p),
        ...(bumped.has(p) ? { maxCyclomatic: 16 } : {}),
      }));
    const emit = (root, rows) =>
      writeFileSync(
        path.join(root, file),
        `${JSON.stringify(buildCyclomaticEnvelope({ rows, ceiling: 12 }), null, 2)}\n`,
      );
    const withD2 = [...PATHS.slice(0, 4), 'src/d2.js', ...PATHS.slice(4)];
    const { status, text } = mergeCase({
      file,
      emit,
      base: toRows(PATHS, new Set()),
      ours: toRows(PATHS, new Set(['src/b.js'])),
      theirs: toRows(withD2, new Set(['src/f.js'])),
    });
    assert.equal(status, 0, `git merge conflicted:\n${text}`);
    const merged = JSON.parse(text);
    assert.deepEqual(Object.keys(merged), ['$schema', 'ceiling', 'rows']);
    assert.deepEqual(
      merged.rows,
      toRows(withD2, new Set(['src/b.js', 'src/f.js'])),
    );
  });

  it('dead-exports: disjoint non-adjacent refreshes merge clean', () => {
    const file = 'baselines/dead-exports.json';
    const emit = (root, rows) =>
      writeFileSync(
        path.join(root, file),
        `${JSON.stringify(buildDeadExportsEnvelope({ kernelVersion: '6.17.1', mode: 'default', rows }), null, 2)}\n`,
      );
    const rowsOf = (paths) =>
      paths.flatMap((p) => [
        { file: p, symbol: 'alpha' },
        { file: p, symbol: 'beta' },
      ]);
    const base = rowsOf(PATHS);
    const ours = base.filter(
      (r) => !(r.file === 'src/b.js' && r.symbol === 'beta'),
    );
    const theirs = rowsOf([
      ...PATHS.slice(0, 5),
      'src/e2.js',
      ...PATHS.slice(5),
    ]);
    const { status, text } = mergeCase({ file, emit, base, ours, theirs });
    assert.equal(status, 0, `git merge conflicted:\n${text}`);
    const merged = JSON.parse(text);
    assert.equal(Object.hasOwn(merged, 'generatedAt'), false);
    assert.deepEqual(
      merged.rows,
      theirs.filter((r) => !(r.file === 'src/b.js' && r.symbol === 'beta')),
    );
  });

  it('the merged coverage baseline passes check-baselines', () => {
    const edits = disjointEdits(
      (p) => ({ path: p, lines: 95, branches: 90, functions: 95 }),
      (r) => ({ ...r, lines: 97.5 }),
    );
    const root = initRepo();
    const agentrc = {
      project: {
        baseBranch: 'main',
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        docsContextFiles: [],
        commands: { test: 'echo', typecheck: 'echo' },
      },
      github: { owner: 'x', repo: 'y', operatorHandle: '@ci' },
      delivery: {
        quality: {
          gates: {
            coverage: {
              enabled: true,
              baselinePath: 'baselines/coverage.json',
              tolerance: { kind: 'absolute', value: 0 },
              floors: { '*': { lines: 90, branches: 85, functions: 90 } },
            },
          },
        },
      },
    };
    writeFileSync(
      path.join(root, '.agentrc.json'),
      JSON.stringify(agentrc, null, 2),
    );
    const { emit } = kernelEmitter('coverage');
    emit(root, edits.base);
    mustGit(['add', '-A'], root);
    mustGit(['commit', '-m', 'base'], root);
    mustGit(['checkout', '-b', 'theirs'], root);
    emit(root, edits.theirs);
    mustGit(['commit', '-am', 'theirs'], root);
    mustGit(['checkout', 'main'], root);
    emit(root, edits.ours);
    mustGit(['commit', '-am', 'ours'], root);
    const merge = git(['merge', '--no-edit', 'theirs'], root);
    assert.equal(merge.status, 0, merge.stdout + merge.stderr);

    const res = spawnSync(
      process.execPath,
      [dispatcherBin, '--gate', 'coverage'],
      { cwd: root, encoding: 'utf8', env: CLEAN_ENV },
    );
    assert.equal(
      res.status,
      0,
      `check-baselines failed:\n${res.stdout}\n${res.stderr}`,
    );
    const report = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    assert.equal(report.totalBreaches, 0);
    assert.deepEqual(report.schemaErrors, []);
  });
});
