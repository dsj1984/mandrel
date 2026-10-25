/**
 * Unit tests for `review-providers/claim-grounding.js` — Story #5904.
 * The git seam is faked except in the one real-repository case.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { groundFindings } from '../../../../.agents/scripts/lib/orchestration/review-providers/claim-grounding.js';

const HEAD = 'abc123';
const TRUNCATED_CONTEXT = 'reviewed-with-truncated-context';
const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../../..');

function fakeGit({ catFile = 128, grep = { status: 1, stdout: '' } } = {}) {
  const calls = [];
  const fn = (_cwd, ...args) => {
    calls.push(args);
    if (args[0] === 'cat-file') return { status: catFile, stdout: '' };
    if (typeof grep === 'function') return grep(args);
    return { stderr: '', ...grep };
  };
  return { fn, calls };
}

function critical(claim, extra = {}) {
  return { severity: 'critical', title: 'T', body: 'B', claim, ...extra };
}

test('AC-1: a path-absent claim whose path exists at the head is downgraded', () => {
  const git = fakeGit({ catFile: 0 });
  const [out] = groundFindings({
    findings: [critical({ kind: 'path-absent', path: 'db/0398.sql' })],
    headRef: HEAD,
    gitSpawnFn: git.fn,
  });
  assert.deepEqual(git.calls, [['cat-file', '-e', `${HEAD}:db/0398.sql`]]);
  assert.equal(out.severity, 'suggestion');
  assert.equal(out.title, 'T');
  assert.equal(out.body, 'B');
  assert.equal(out.ungrounded, 'git cat-file found db/0398.sql');
});

test('AC-2: a symbol-referenced claim with hits only in its definition file is downgraded', () => {
  const git = fakeGit({
    grep: {
      status: 0,
      stdout: `${HEAD}:src/flags.js:3:export function f() {}\n`,
    },
  });
  const [out] = groundFindings({
    findings: [
      critical({
        kind: 'symbol-referenced',
        symbol: 'f',
        path: 'src/flags.js',
      }),
    ],
    headRef: HEAD,
    gitSpawnFn: git.fn,
  });
  assert.deepEqual(git.calls, [
    ['grep', '-n', '-w', '-F', '-e', 'f', HEAD, '--'],
  ]);
  assert.equal(out.severity, 'suggestion');
  assert.equal(
    out.ungrounded,
    'git grep found no references outside src/flags.js',
  );
});

test('AC-2: a symbol with no hits at all is downgraded', () => {
  const [out] = groundFindings({
    findings: [critical({ kind: 'symbol-referenced', symbol: 'gone' })],
    headRef: HEAD,
    gitSpawnFn: fakeGit().fn,
  });
  assert.equal(out.severity, 'suggestion');
  assert.equal(out.ungrounded, 'git grep found no references');
});

test('AC-3: a confirmed claim, a git error, or no claim leaves the critical unchanged', () => {
  const cases = [
    [
      critical({ kind: 'path-absent', path: 'x.sql' }),
      fakeGit({ catFile: 128 }),
    ],
    [
      critical({ kind: 'symbol-referenced', symbol: 'f', path: 'a.js' }),
      fakeGit({ grep: { status: 0, stdout: `${HEAD}:b.js:9:f();\n` } }),
    ],
    [
      critical({ kind: 'symbol-referenced', symbol: 'f' }),
      fakeGit({ grep: { status: 128, stdout: '' } }),
    ],
    [
      critical({ kind: 'path-absent', path: 'x.sql' }),
      {
        fn: () => {
          throw new Error('spawn failed');
        },
      },
    ],
    [{ severity: 'critical', title: 'T', body: 'B' }, fakeGit({ catFile: 0 })],
  ];
  for (const [finding, git] of cases) {
    const [out] = groundFindings({
      findings: [finding],
      headRef: HEAD,
      gitSpawnFn: git.fn,
    });
    assert.deepEqual(out, finding);
  }
});

test('AC-3: a stale caller inside the claimed definition file still halts', () => {
  const finding = critical({
    kind: 'symbol-referenced',
    symbol: 'f',
    path: 'src/a.js',
  });
  const [out] = groundFindings({
    findings: [finding],
    headRef: HEAD,
    gitSpawnFn: fakeGit({
      grep: {
        status: 0,
        stdout: `${HEAD}:src/a.js:1:export function g() { return f(); }\n`,
      },
    }).fn,
  });
  assert.deepEqual(out, finding);
});

test('a non-critical finding is never grounded', () => {
  const git = fakeGit({ catFile: 0 });
  const finding = {
    severity: 'high',
    title: 'T',
    body: 'B',
    claim: { kind: 'path-absent', path: 'x' },
  };
  assert.deepEqual(
    groundFindings({ findings: [finding], headRef: HEAD, gitSpawnFn: git.fn }),
    [finding],
  );
  assert.deepEqual(git.calls, []);
});

test('AC-5: a degradation naming the file, claim path or claim symbol marks truncated context', () => {
  const degradations = [
    {
      reason:
        'src/big.js truncated at 200000 characters: 5 characters not reviewed',
    },
    {
      reason:
        'callers block incomplete; not checked: arePaymentPlansEnabled (4 lines over cap)',
    },
    {
      reason:
        'review bounded at 6 chunks: 2 file(s) not reviewed: db/a.sql, db/b.sql',
    },
  ];
  const findings = groundFindings({
    findings: [
      { severity: 'high', title: 'file', body: 'b', file: 'src/big.js' },
      critical(
        { kind: 'symbol-referenced', symbol: 'arePaymentPlansEnabled' },
        { title: 'sym' },
      ),
      critical({ kind: 'path-absent', path: 'db/b.sql' }, { title: 'path' }),
      { severity: 'high', title: 'other', body: 'b', file: 'src/big' },
    ],
    headRef: HEAD,
    degradations,
    gitSpawnFn: fakeGit({
      grep: { status: 0, stdout: `${HEAD}:c.js:1:arePaymentPlansEnabled\n` },
    }).fn,
  });
  assert.deepEqual(
    findings.map((f) => [f.title, f.context ?? null, f.severity]),
    [
      ['file', TRUNCATED_CONTEXT, 'high'],
      ['sym', TRUNCATED_CONTEXT, 'critical'],
      ['path', TRUNCATED_CONTEXT, 'critical'],
      ['other', null, 'high'],
    ],
  );
});

test('real repository: an existing path and an unreferenced symbol are both refuted at HEAD', () => {
  const symbol = ['zz', 'NoSuchSymbol', '5904'].join('');
  const findings = groundFindings({
    findings: [
      critical({ kind: 'path-absent', path: 'package.json' }),
      critical({ kind: 'symbol-referenced', symbol }),
      critical({ kind: 'path-absent', path: 'no/such/file.sql' }),
    ],
    headRef: 'HEAD',
    cwd: PROJECT_ROOT,
  });
  assert.deepEqual(
    findings.map((f) => f.severity),
    ['suggestion', 'suggestion', 'critical'],
  );
});
