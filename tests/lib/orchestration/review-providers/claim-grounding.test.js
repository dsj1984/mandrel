/**
 * Unit tests for `review-providers/claim-grounding.js` — Story #5904.
 * The git seam is faked except in the one real-repository case.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  CLAIM_SCHEMA,
  groundFindings,
  STRICT_CLAIM_SCHEMA,
} from '../../../../.agents/scripts/lib/orchestration/review-providers/claim-grounding.js';

const HEAD = 'abc123';
const TRUNCATED_CONTEXT = 'reviewed-with-truncated-context';
const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../../..');

/** The head probe (`rev-parse`) is answered by `revParse` and kept apart from `calls`. */
function fakeGit({
  catFile = 128,
  diff = 0,
  grep = { status: 1, stdout: '' },
  revParse = 0,
} = {}) {
  const calls = [];
  const probes = [];
  const fn = (cwd, ...args) => {
    if (args[0] === 'rev-parse') {
      probes.push([cwd, ...args]);
      return { status: revParse };
    }
    calls.push(args);
    if (args[0] === 'cat-file') return { status: catFile, stdout: '' };
    if (args[0] === 'diff') return { status: diff, stdout: '' };
    if (typeof grep === 'function') return grep(args);
    return { stderr: '', ...grep };
  };
  return { fn, calls, probes };
}

function critical(claim, extra = {}) {
  return { severity: 'critical', title: 'T', body: 'B', claim, ...extra };
}

test('AC-1: a path-absent claim whose path exists at the head is downgraded', () => {
  const git = fakeGit({ catFile: 0 });
  const {
    findings: [out],
  } = groundFindings({
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
  const {
    findings: [out],
  } = groundFindings({
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
  const {
    findings: [out],
  } = groundFindings({
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
    const {
      findings: [out],
    } = groundFindings({
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
  const {
    findings: [out],
  } = groundFindings({
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
    groundFindings({ findings: [finding], headRef: HEAD, gitSpawnFn: git.fn })
      .findings,
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
  const { findings } = groundFindings({
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
  const { findings } = groundFindings({
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

test('head probe: no groundable critical spawns no probe and records nothing', () => {
  const git = fakeGit();
  const out = groundFindings({
    findings: [
      {
        severity: 'high',
        title: 'T',
        body: 'B',
        claim: { kind: 'path-absent', path: 'a' },
      },
      critical(null),
    ],
    headRef: HEAD,
    degradations: [{ reason: 'r' }],
    cwd: '/repo',
    gitSpawnFn: git.fn,
  });
  assert.deepEqual(git.probes, []);
  assert.deepEqual(out.degradations, [{ reason: 'r' }]);
});

test('head probe: a resolvable head is probed once in cwd and records nothing', () => {
  const git = fakeGit({ catFile: 0 });
  const out = groundFindings({
    findings: [critical({ kind: 'path-absent', path: 'a' })],
    headRef: HEAD,
    cwd: '/repo',
    gitSpawnFn: git.fn,
  });
  assert.deepEqual(git.probes, [
    ['/repo', 'rev-parse', '--verify', '--quiet', `${HEAD}^{commit}`],
  ]);
  assert.deepEqual(out.degradations, []);
});

test('head probe: an unresolvable head or a throwing spawn records a degradation and keeps the critical', () => {
  const expected = {
    tool: 'claim-grounding',
    gate: 'claim-grounding',
    surface: 'head-ref',
    reason: `head ${HEAD} not resolvable in /elsewhere`,
  };
  const throwing = () => {
    throw new Error('spawn failed');
  };
  for (const gitSpawnFn of [fakeGit({ revParse: 128 }).fn, throwing]) {
    const out = groundFindings({
      findings: [critical({ kind: 'path-absent', path: 'db/a.sql' })],
      headRef: HEAD,
      cwd: '/elsewhere',
      gitSpawnFn,
    });
    assert.deepEqual(out.degradations, [expected]);
    assert.equal(out.findings[0].severity, 'critical');
  }
});

test('#5912: a file-unchanged claim on a path changed in base...head is downgraded', () => {
  const git = fakeGit({ diff: 1 });
  const {
    findings: [out],
  } = groundFindings({
    findings: [critical({ kind: 'file-unchanged', path: 'src/callee.js' })],
    headRef: HEAD,
    baseRef: 'origin/main',
    gitSpawnFn: git.fn,
  });
  assert.deepEqual(git.calls, [
    ['diff', '--quiet', `origin/main...${HEAD}`, '--', 'src/callee.js'],
  ]);
  assert.equal(out.severity, 'suggestion');
  assert.equal(
    out.ungrounded,
    `git diff origin/main...${HEAD} changes src/callee.js`,
  );
});

test('#5912: an unchanged path, a git error or no base keeps a file-unchanged critical', () => {
  const finding = critical({ kind: 'file-unchanged', path: 'src/callee.js' });
  const cases = [
    [fakeGit({ diff: 0 }), 'origin/main'],
    [fakeGit({ diff: 128 }), 'origin/main'],
    [fakeGit({ diff: 1 }), undefined],
  ];
  for (const [git, baseRef] of cases) {
    const {
      findings: [out],
    } = groundFindings({
      findings: [finding],
      headRef: HEAD,
      baseRef,
      gitSpawnFn: git.fn,
    });
    assert.deepEqual(out, finding);
  }
});

test('#5912: the Claude and Codex claim schemas both accept file-unchanged', () => {
  assert.ok(CLAIM_SCHEMA.properties.kind.enum.includes('file-unchanged'));
  assert.ok(
    STRICT_CLAIM_SCHEMA.properties.kind.enum.includes('file-unchanged'),
  );
});
