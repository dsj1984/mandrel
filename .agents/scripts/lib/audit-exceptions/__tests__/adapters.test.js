/**
 * The non-dependency adapters through the engine — inline suppressions,
 * tool-config exemptions, CI gate exemptions, test skips, code allowlists —
 * and the justification facts (reason, tracking ticket, expiry) that drive
 * the expired / orphaned / unjustified verdicts.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { runEngine } from '../engine.js';
import { fakeGh, lines, makeRepo } from './fixtures/repo.js';

const TODAY = '2026-10-07';

let env;
const at = (file, line) =>
  env.records.find((r) => r.file === file && r.line === line);
const ofAdapter = (adapter) => env.records.filter((r) => r.adapter === adapter);

before(async () => {
  const root = makeRepo(
    {
      '.gitignore': lines('dist/', 'node_modules/'),
      '.agentrc.json': { project: {} },
      'src/a.js': lines(
        'const a = 1; // biome-ignore lint/style/noVar: legacy shim (TODO #41)',
        '// eslint-disable-next-line no-console -- debugging aid until 2026-01-01',
        '// @ts-expect-error',
        '/* c8 ignore next */',
        'const s = "// eslint-disable-line inside a string";',
        '// the upstream parser rejects this form',
        '// eslint-disable-next-line no-restricted-syntax',
        '// biome-ignore lint/x/y: tracked in #42',
        'export { a, s };',
        '/* node:coverage ignore next */',
      ),
      'src/gen/out.js': 'export const g = 1;\n',
      'docs/x.md': lines('<!-- markdownlint-disable MD013 -->', '# Title'),
      'biome.json': {
        files: { includes: ['**', '!gone-dir/**', '!src/gen/**', '!dist'] },
        overrides: [
          {
            includes: ['src/legacy/**'],
            linter: { rules: { recommended: 'off' } },
          },
          {
            includes: ['src/**'],
            linter: { rules: { style: { useConst: 'error' } } },
          },
        ],
      },
      'tsconfig.json': lines(
        '{',
        '  "compilerOptions": {',
        '    "strict": false, // the migration is incremental',
        '    "skipLibCheck": true,',
        '  },',
        '  "exclude": ["node_modules", "old/**"],',
        '}',
      ),
      '.prettierignore': lines('# generated', 'build', '/coverage-old'),
      '.github/workflows/ci.yml': lines(
        'jobs:',
        '  smoke:',
        '    if: false',
        '    steps:',
        '      - run: npm test',
        '        continue-on-error: true # flaky upstream mirror (TODO #43)',
      ),
      'tests/a.test.js': lines(
        "test.skip('x', () => {});",
        "it.todo('cover the retry path');",
        "test('posix', { skip: process.platform === 'win32' }, () => {});",
        "const fake = () => ({ skip: true, reason: 'fingerprint-match' });",
        'const NEEDS_GIT = { skip: !hasGit };',
      ),
      'src/allow.js': lines(
        '/** Known lint gaps; shrink this list, never grow it. */',
        'export const KNOWN_LINT_GAPS = [',
        "  'src/a.js', // fixed by the parser refactor",
        "  'src/removed.js',",
        "  'not-a-path',",
        '];',
        "export const KNOWN_KINDS = ['coverage', 'crap'];",
        "export const PAYLOAD_ALLOWLIST = new Set(['x']);",
      ),
    },
    { origin: 'https://github.com/acme/app.git' },
  );
  env = await runEngine({
    cwd: root,
    today: TODAY,
    gh: fakeGh({ 41: 'open', 42: 'closed', 43: 'open' }),
  });
});

describe('inline suppressions', () => {
  it('reads the directive, its rule and its reason per tool', () => {
    const biome = at('src/a.js', 1);
    assert.equal(biome.surface, 'biome');
    assert.equal(biome.target, 'lint/style/noVar');
    assert.equal(biome.rule, 'biome:lint/style/noVar');
    assert.match(biome.justification, /legacy shim/);
    assert.equal(at('src/a.js', 2).rule, 'eslint:no-console');
    assert.equal(at('src/a.js', 3).target, '@ts-expect-error');
    assert.equal(at('src/a.js', 4).surface, 'coverage');
    assert.equal(at('docs/x.md', 1).rule, 'markdownlint:MD013');
    assert.equal(at('src/a.js', 10).rule, 'coverage:node:coverage-ignore-next');
  });

  it('never reads a directive inside a string literal', () => {
    assert.equal(at('src/a.js', 5), undefined);
  });

  it('falls back to the comment line above for the reason', () => {
    assert.equal(
      at('src/a.js', 7).justification,
      'the upstream parser rejects this form',
    );
  });

  it('drives verdicts from justification, expiry and tracking ticket', () => {
    assert.equal(at('src/a.js', 1).verdict, 'live', 'its TODO ticket is open');
    assert.deepEqual(at('src/a.js', 1).ticketRefs, ['#41']);
    assert.equal(at('src/a.js', 2).verdict, 'expired');
    assert.equal(at('src/a.js', 3).verdict, 'unjustified');
    assert.equal(at('src/a.js', 4).verdict, 'unjustified');
    assert.equal(at('src/a.js', 8).verdict, 'orphaned');
  });
});

describe('tool-config exemptions', () => {
  const biome = () => env.records.filter((r) => r.file === 'biome.json');

  it('a negated include matching nothing is dead; one matching tracked files is live', () => {
    const gone = biome().find((r) => r.target === '!gone-dir/**');
    assert.equal(gone.verdict, 'dead');
    assert.equal(gone.verdictBasis, 'matches-nothing');
    assert.equal(
      biome().find((r) => r.target === '!src/gen/**').probeBasis,
      'matches-tracked',
    );
  });

  it('a gitignored build path is live and needs no written reason', () => {
    const dist = biome().find((r) => r.target === '!dist');
    assert.equal(dist.probeBasis, 'gitignored-path');
    assert.equal(dist.permanentHint, 'untracked-path');
    assert.equal(dist.verdict, 'live');
  });

  it('only a rule-disabling override is an exemption', () => {
    const overrides = biome().filter((r) => r.rule === 'biome:overrides');
    assert.equal(overrides.length, 1);
    assert.equal(overrides[0].verdict, 'dead');
  });

  it('reads JSONC tsconfig: excludes and loosened strictness', () => {
    const ts = env.records.filter((r) => r.file === 'tsconfig.json');
    assert.equal(ts.find((r) => r.target === 'old/**').verdict, 'dead');
    assert.equal(ts.find((r) => r.target === 'node_modules').verdict, 'live');
    assert.equal(
      ts.find((r) => r.target === 'skipLibCheck').permanentHint,
      'conventional-setting',
    );
    assert.ok(ts.find((r) => r.target === 'strict'));
  });

  it('reads gitignore-style ignore files with the comment above as reason', () => {
    const [build, anchored] = env.records.filter(
      (r) => r.file === '.prettierignore',
    );
    assert.equal(build.target, 'build');
    assert.equal(build.justification, 'generated');
    assert.equal(
      build.verdict,
      'unknown',
      'an unanchored line may match a nested untracked dir',
    );
    assert.equal(anchored.target, '/coverage-old');
    assert.equal(anchored.verdict, 'dead');
  });
});

describe('CI gate exemptions', () => {
  it('records continue-on-error and if: false with their real lines', () => {
    const ci = ofAdapter('ci-gates');
    assert.deepEqual(
      ci.map((r) => [r.target, r.line]),
      [
        ['if-false', 3],
        ['continue-on-error', 6],
      ],
    );
    assert.equal(ci[0].verdict, 'unjustified');
    assert.equal(ci[1].verdict, 'live');
  });

  it('delegates .agentrc.json ignoreGlobs to /audit-baselines rather than reading them', () => {
    assert.deepEqual(
      env.delegated.map((d) => d.lens),
      ['audit-baselines'],
    );
    assert.ok(env.records.every((r) => r.file !== '.agentrc.json'));
  });
});

describe('test skips', () => {
  it('records skip / todo calls and node:test skip options, not look-alike objects', () => {
    const skips = ofAdapter('test-skips');
    assert.deepEqual(
      skips.map((r) => r.line),
      [1, 2, 3, 5],
    );
    assert.equal(at('tests/a.test.js', 1).verdict, 'unjustified');
    assert.equal(
      at('tests/a.test.js', 2).justification,
      'cover the retry path',
    );
  });

  it('marks a platform-conditional skip as permanent', () => {
    const posix = at('tests/a.test.js', 3);
    assert.equal(posix.permanentHint, 'platform-conditional');
    assert.equal(posix.verdict, 'live');
    assert.match(
      at('tests/a.test.js', 5).justification,
      /conditional: !hasGit/,
    );
  });
});

describe('code allowlists', () => {
  it('reads exemption-named literals only, one record per entry', () => {
    const entries = ofAdapter('code-allowlists');
    assert.deepEqual(
      entries.map((r) => r.target),
      ['src/a.js', 'src/removed.js', 'not-a-path', 'x'],
    );
  });

  it('a path entry that no longer exists is dead; the doc comment justifies the rest', () => {
    const [kept, removed, plain] = ofAdapter('code-allowlists');
    assert.equal(kept.justification, 'fixed by the parser refactor');
    assert.equal(removed.verdict, 'dead');
    assert.match(plain.justification, /Known lint gaps/);
    assert.equal(plain.verdict, 'live');
  });
});

describe('envelope summary', () => {
  it('clusters by (adapter, rule) with per-verdict counts', () => {
    const cluster = env.clusters.find((c) => c.rule === 'KNOWN_LINT_GAPS');
    assert.equal(cluster.count, 3);
    assert.equal(cluster.byVerdict.dead, 1);
    assert.equal(env.totals.records, env.records.length);
  });
});

describe('other config shapes and unreadable configs', () => {
  let other;
  before(async () => {
    const root = makeRepo({
      'package.json': {
        name: 'c',
        c8: { exclude: ['gone-cov/**'] },
        knip: { ignoreFiles: ['src/**'], ignoreDependencies: ['ghost'] },
      },
      'package-lock.json': {
        lockfileVersion: 3,
        packages: { '': { name: 'c' } },
      },
      '.eslintrc.json': {
        ignorePatterns: ['vendor/**'],
        overrides: [{ files: 'src/**', rules: { 'no-x': 'off' } }],
      },
      '.c8rc.json': lines(
        '{',
        '  /* block comment */',
        '  "exclude": ["src/**", "a\\"b/**"],',
        '}',
      ),
      '.markdownlint-cli2.jsonc': { ignores: ['CHANGELOG.md'] },
      'eslint.config.js': 'export default [];\n',
      'renovate.json5': '{ ignoreDeps: ["x"] }\n',
      '.nsprc': '{ not json',
      'audit-ci.jsonc': '{ broken',
      'biome.json': '{ "files": ',
      'pkg/.npmrc': lines('strict-ssl=false ; corporate proxy'),
      'src/a.js': 'export const a = 1;\n',
      'CHANGELOG.md': '# Changes\n',
    });
    other = await runEngine({ cwd: root, today: TODAY, gh: fakeGh({}) });
  });

  const rule = (r) => other.records.filter((x) => x.rule === r);

  it('reads eslintrc, c8, markdownlint and package.json-embedded configs', () => {
    assert.equal(rule('eslint:ignorePatterns')[0].verdict, 'dead');
    assert.equal(rule('eslint:overrides')[0].probeBasis, 'matches-tracked');
    assert.equal(rule('coverage:exclude').length, 3);
    assert.equal(rule('markdownlint:ignores')[0].probeBasis, 'matches-tracked');
    assert.ok(
      other.records.some(
        (r) => r.file === 'package.json' && r.rule === 'knip:ignoreFiles',
      ),
    );
    assert.equal(
      other.records.find((r) => r.target === 'ghost').verdict,
      'dead',
    );
  });

  it('reads an .npmrc in any directory with its trailing comment', () => {
    const rc = other.records.find((r) => r.surface === 'npmrc');
    assert.equal(rc.file, 'pkg/.npmrc');
    assert.equal(rc.justification, 'corporate proxy');
  });

  it('records each unreadable config as a degradation instead of failing', () => {
    const details = other.degradations
      .filter((d) => d.input === 'config-not-statically-readable')
      .map((d) => d.detail);
    for (const file of [
      'eslint.config.js',
      '.nsprc',
      'audit-ci.jsonc',
      'biome.json',
    ]) {
      assert.ok(
        details.some((d) => d.includes(file)),
        `${file}: ${details}`,
      );
    }
    assert.ok(details.some((d) => d.includes('json5')));
  });
});
