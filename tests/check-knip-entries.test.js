import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';
import { runCli } from '../scripts/check-knip-entries.js';
import {
  __testing,
  countDivergences,
  renderEntrySyncReport,
  resolveEntrySync,
} from '../scripts/lib/knip-entry-sync.js';

/**
 * Unit + invariant coverage for the knip entry-sync gate.
 *
 * The defect this suite exists to prevent (observed live during Story #5012):
 * Story #5001 replaced knip's blanket `.agents/scripts/*.js!` entry glob with
 * an explicit hand-written list and promoted the `files` rule to `error`. A CLI
 * added afterwards is absent from that list, so knip reads it as unreachable,
 * emits a whole-file `{ file, symbol: '*' }` row for it, and marks every lib
 * module only that CLI imports dead too. Accepting the ratchet's diff — the
 * obvious remedy — permanently records live operator CLIs as expected-dead.
 *
 * Modeled on the sibling `check-action-pinning.test.js`: exercise the pure
 * helpers, drive `resolveEntrySync` over fixture trees, then assert the live
 * repository's own invariants.
 */

const {
  buildInvocationPatterns,
  collectEntryPatterns,
  collectInvocationSurfaces,
  readKnipEntries,
  stripJsComments,
} = __testing;

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Build a minimal fixture repository.
 *
 * @param {{
 *   clis: string[],
 *   entry?: string[],
 *   packageJson?: object,
 *   extraFiles?: Record<string, string>,
 * }} spec
 * @returns {string} absolute repo root
 */
function makeFixtureRepo({ clis, entry, packageJson, extraFiles = {} }) {
  const root = makeTempDir('knip-entry-');
  const scriptsDir = path.join(root, '.agents', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  for (const cli of clis) {
    fs.writeFileSync(path.join(scriptsDir, cli), `// ${cli}\n`);
  }
  fs.writeFileSync(
    path.join(root, 'knip.json'),
    JSON.stringify({
      entry: (entry ?? clis).map((c) => `.agents/scripts/${c}!`),
    }),
  );
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(packageJson ?? { scripts: {} }),
  );
  for (const [rel, body] of Object.entries(extraFiles)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

// --- pure helpers -----------------------------------------------------------

test('stripJsComments: blanks line and block comments, preserving line count', () => {
  const src = [
    'const a = 1; // trailing',
    '/* block',
    ' * body',
    ' */',
    'b()',
  ].join('\n');
  const out = stripJsComments(src);
  assert.match(out, /const a = 1;/);
  assert.ok(!out.includes('trailing'));
  assert.ok(!out.includes('body'));
  assert.equal(out.split('\n').length, src.split('\n').length);
});

test('stripJsComments: does not mangle // inside string or template literals', () => {
  const src = `const u = 'https://example.com/x'; const t = \`a//b\`; // gone`;
  const out = stripJsComments(src);
  assert.match(out, /https:\/\/example\.com\/x/);
  assert.match(out, /a\/\/b/);
  assert.ok(!out.includes('gone'));
});

test('buildInvocationPatterns: pathLiteral matches both separator styles', () => {
  const { pathLiteral } = buildInvocationPatterns('foo.js');
  assert.ok(pathLiteral.test('node .agents/scripts/foo.js --flag'));
  assert.ok(pathLiteral.test('node .agents\\scripts\\foo.js'));
  assert.ok(!pathLiteral.test('node .agents/scripts/foo-bar.js'));
});

test('buildInvocationPatterns: joinedSpawn requires the "scripts" sibling argument', () => {
  const { joinedSpawn } = buildInvocationPatterns('foo.js');
  assert.ok(joinedSpawn.test(`path.join(root, 'scripts', 'foo.js')`));
  assert.ok(
    joinedSpawn.test(`path.join(\n  root,\n  'scripts',\n  'foo.js',\n)`),
  );
  // A bare catalogue entry — the shape of source-classifier's basename
  // inventory — is a list of names, not a call.
  assert.ok(!joinedSpawn.test(`const NAMES = ['bar.js', 'foo.js'];`));
});

test('readKnipEntries: reads explicit top-level entries and ignores globs', async () => {
  const root = makeFixtureRepo({ clis: ['a.js'] });
  fs.writeFileSync(
    path.join(root, 'knip.json'),
    JSON.stringify({
      entry: [
        'bin/*.js!',
        '.agents/scripts/a.js!',
        '.agents/scripts/*.js!',
        '.agents/scripts/**/__tests__/**/*.test.js',
        '.agents/scripts/lib/nested.js!',
      ],
    }),
  );
  const { entries, error } = await readKnipEntries({ repoRoot: root });
  assert.equal(error, null);
  assert.deepEqual(entries, ['a.js']);
});

test('readKnipEntries: reports an entry declared without the `!` production marker', async () => {
  const root = makeFixtureRepo({ clis: ['a.js', 'b.js'] });
  fs.writeFileSync(
    path.join(root, 'knip.json'),
    JSON.stringify({
      entry: ['.agents/scripts/a.js!', '.agents/scripts/b.js'],
    }),
  );
  const { entries, unsuffixed, error } = await readKnipEntries({
    repoRoot: root,
  });
  assert.equal(error, null);
  // Still declared — the CLI is named — but knip's production pass negates it.
  assert.deepEqual(entries, ['a.js', 'b.js']);
  assert.deepEqual(unsuffixed, ['b.js']);
});

test('resolveEntrySync: an unsuffixed entry is a divergence, not a satisfied one', async () => {
  const root = makeFixtureRepo({ clis: ['a.js'] });
  fs.writeFileSync(
    path.join(root, 'knip.json'),
    JSON.stringify({ entry: ['.agents/scripts/a.js'] }),
  );
  const report = await resolveEntrySync({ repoRoot: root });
  assert.deepEqual(report.unsuffixed, ['a.js']);
  // The gate must fail: reading it as declared points the operator away from
  // the cause, and accepting the dead-exports diff would then record a live
  // CLI as expected-dead (Story #5012).
  assert.ok(countDivergences(report) > 0);
  assert.match(renderEntrySyncReport(report), /without a "!" suffix/);
});

test('readKnipEntries: an unusable repository and an entry-less config are errors, not skips', async () => {
  // No package.json at all: knip's resolver cannot even start. A broken
  // repository is not an opt-out, so it must not take the skip path.
  const root = makeTempDir('knip-entry-bad-');
  const unusable = await readKnipEntries({ repoRoot: root });
  assert.equal(unusable.skipped, null);
  assert.match(unusable.error, /cannot resolve the knip configuration/);

  // A config that resolves but enumerates no entry points anywhere leaves the
  // gate nothing to compare against. Reporting every CLI as `missing` would be
  // a lie, so this is an error too.
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(root, 'knip.json'), JSON.stringify({}));
  const entryless = await readKnipEntries({ repoRoot: root });
  assert.equal(entryless.skipped, null);
  assert.match(entryless.error, /declares no "entry" array/);
});

// --- the regression the gate exists for -------------------------------------

test('REGRESSION: a newly-added, invoked CLI absent from knip entry is reported missing', async () => {
  // Exactly the Story #5012 shape: the CLI is real, wired into package.json and
  // CI, and simply not yet listed in knip.json. Without this gate knip calls it
  // unreachable and check-dead-exports offers a whole-file dead row for it.
  const root = makeFixtureRepo({
    clis: ['existing.js', 'brand-new.js'],
    entry: ['existing.js'],
    packageJson: {
      scripts: {
        existing: 'node .agents/scripts/existing.js',
        'check:new': 'node .agents/scripts/brand-new.js',
      },
    },
    extraFiles: {
      '.github/workflows/ci.yml':
        'jobs:\n  b:\n    steps:\n      - run: node .agents/scripts/brand-new.js\n',
    },
  });

  const report = await resolveEntrySync({ repoRoot: root });
  assert.equal(report.error, null);
  assert.deepEqual(
    report.missing.map((m) => m.cli),
    ['brand-new.js'],
    'a new CLI that something invokes must be flagged before knip can call it dead',
  );
  assert.deepEqual(report.missing[0].invokers.sort(), [
    '.github/workflows/ci.yml',
    'package.json',
  ]);
  assert.deepEqual(report.stale, []);

  // And the remedy the operator is told to apply must actually clear it —
  // adding the entry, NOT accepting a dead-exports diff.
  const rendered = renderEntrySyncReport(report);
  assert.match(
    rendered,
    /add "\.agents\/scripts\/brand-new\.js!" to knip\.json/,
  );
  assert.match(rendered, /\(gate fail\)/);

  fs.writeFileSync(
    path.join(root, 'knip.json'),
    JSON.stringify({
      entry: ['.agents/scripts/existing.js!', '.agents/scripts/brand-new.js!'],
    }),
  );
  const after = await resolveEntrySync({ repoRoot: root });
  assert.deepEqual(after.missing, []);
  assert.deepEqual(after.stale, []);
  assert.deepEqual(after.phantom, []);
  assert.match(renderEntrySyncReport(after), /\(ok\)/);
});

test('a CLI declared in entry that nothing invokes is reported stale', async () => {
  // The blind spot #5001 closed: a declared entry point is immortal, so its
  // death can never surface. An entry outliving its last caller restores it.
  const root = makeFixtureRepo({
    clis: ['live.js', 'orphaned.js'],
    packageJson: { scripts: { live: 'node .agents/scripts/live.js' } },
  });
  const report = await resolveEntrySync({ repoRoot: root });
  assert.deepEqual(report.stale, ['orphaned.js']);
  assert.deepEqual(report.missing, []);
  assert.match(renderEntrySyncReport(report), /nothing invokes it/);
});

test('an entry whose file is gone is reported phantom', async () => {
  const root = makeFixtureRepo({
    clis: ['live.js'],
    entry: ['live.js', 'renamed-away.js'],
    packageJson: { scripts: { live: 'node .agents/scripts/live.js' } },
  });
  const report = await resolveEntrySync({ repoRoot: root });
  assert.deepEqual(report.phantom, ['renamed-away.js']);
});

// --- what does and does not confer liveness ---------------------------------

test('documentation prose does not make an uninvoked CLI live', async () => {
  // Four CLIs are named only in docs today; #5001 recorded all four as
  // whole-file dead on purpose. Counting prose would silently resurrect them.
  const root = makeFixtureRepo({
    clis: ['operator-tool.js'],
    entry: [],
    extraFiles: {
      'docs/onboarding.md':
        'Run `node .agents/scripts/operator-tool.js` by hand.\n',
      '.agents/docs/quality-gates.md':
        'The operator-run replacement is `node .agents/scripts/operator-tool.js`.\n',
    },
  });
  const report = await resolveEntrySync({ repoRoot: root });
  assert.deepEqual(report.missing, [], 'prose is not a caller');
  assert.deepEqual(report.stale, []);
});

test('a comment naming a CLI does not make it live, but a real spawn does', async () => {
  const root = makeFixtureRepo({
    clis: ['mentioned.js', 'spawned.js'],
    entry: ['spawned.js'],
    extraFiles: {
      '.agents/scripts/lib/notes.js': [
        '/**',
        ' * Superseded by `node .agents/scripts/mentioned.js` (Story #1).',
        ' */',
        "const script = path.join(root, 'scripts', 'spawned.js');",
        'spawnSync(process.execPath, [script]);',
      ].join('\n'),
    },
  });
  const report = await resolveEntrySync({ repoRoot: root });
  assert.deepEqual(
    report.missing,
    [],
    'a JSDoc mention must not confer liveness',
  );
  assert.deepEqual(report.stale, [], 'a path.join spawn must confer liveness');
});

test('a CLI reachable only by import is neither missing nor stale', async () => {
  // `cleanup-repo-test-temp.js` is imported by run-tests.js, so knip already
  // reaches it through the module graph; declaring it an entry would be wrong.
  const root = makeFixtureRepo({
    clis: ['runner.js', 'helper.js'],
    entry: ['runner.js'],
    packageJson: { scripts: { t: 'node .agents/scripts/runner.js' } },
  });
  fs.writeFileSync(
    path.join(root, '.agents', 'scripts', 'runner.js'),
    "import { help } from './helper.js';\nhelp();\n",
  );
  const report = await resolveEntrySync({ repoRoot: root });
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.stale, []);
});

test('collectInvocationSurfaces: excludes test files from the invoked set', async () => {
  const root = makeFixtureRepo({
    clis: ['only-tested.js'],
    entry: [],
    extraFiles: {
      '.agents/scripts/__tests__/only-tested.test.js':
        "spawnSync('node', ['.agents/scripts/only-tested.js']);\n",
    },
  });
  const surfaces = collectInvocationSurfaces({ repoRoot: root });
  assert.ok(!surfaces.some((s) => s.path.includes('__tests__')));
  assert.deepEqual((await resolveEntrySync({ repoRoot: root })).missing, []);
});

// --- CLI exit codes ---------------------------------------------------------

test('runCli: exits 0 clean, 1 on divergence, 2 when it cannot run', async () => {
  const sink = () => ({
    out: '',
    write(s) {
      this.out += s;
    },
  });

  const clean = makeFixtureRepo({
    clis: ['a.js'],
    packageJson: { scripts: { a: 'node .agents/scripts/a.js' } },
  });
  assert.equal(
    await runCli({ argv: ['--cwd', clean], stdout: sink(), stderr: sink() }),
    0,
  );

  const diverged = makeFixtureRepo({
    clis: ['a.js'],
    entry: [],
    packageJson: { scripts: { a: 'node .agents/scripts/a.js' } },
  });
  assert.equal(
    await runCli({ argv: ['--cwd', diverged], stdout: sink(), stderr: sink() }),
    1,
  );

  const broken = makeTempDir('knip-entry-empty-');
  assert.equal(
    await runCli({ argv: ['--cwd', broken], stdout: sink(), stderr: sink() }),
    2,
  );

  const badFlag = sink();
  assert.equal(
    await runCli({ argv: ['--nope'], stdout: sink(), stderr: badFlag }),
    2,
  );
  assert.match(badFlag.out, /unknown flag/);
});

test('runCli: --json emits the machine-readable report', async () => {
  const root = makeFixtureRepo({
    clis: ['a.js'],
    entry: [],
    packageJson: { scripts: { a: 'node .agents/scripts/a.js' } },
  });
  const stdout = {
    out: '',
    write(s) {
      this.out += s;
    },
  };
  const code = await runCli({
    argv: ['--cwd', root, '--json'],
    stdout,
    stderr: { write() {} },
  });
  assert.equal(code, 1);
  const parsed = JSON.parse(stdout.out);
  assert.equal(parsed.kind, 'knip-entry-sync');
  assert.deepEqual(
    parsed.missing.map((m) => m.cli),
    ['a.js'],
  );
});

// --- config resolution (Story #5039) ----------------------------------------

/**
 * Rewrite a fixture's configuration into one of knip's other supported
 * locations, removing the `knip.json` `makeFixtureRepo` seeds by default.
 *
 * @param {string} root fixture repo root
 * @param {string} name config filename, or `package.json` for the manifest key
 * @param {object|string} body parsed object, or verbatim source for a TS/JS module
 */
function relocateConfig(root, name, body) {
  const entry = JSON.parse(
    fs.readFileSync(path.join(root, 'knip.json'), 'utf8'),
  );
  fs.rmSync(path.join(root, 'knip.json'));
  if (name === 'package.json') {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
    );
    manifest.knip = body ?? entry;
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
    return;
  }
  fs.writeFileSync(
    path.join(root, name),
    typeof body === 'string' ? body : JSON.stringify(body ?? entry),
  );
}

for (const [name, body] of [
  ['knip.jsonc', null],
  ['.knip.json', null],
  ['package.json', null],
  [
    'knip.config.ts',
    // A type annotation and a computed array: proof the module is EVALUATED,
    // not parsed. A purpose-built parser would see neither the mapped suffix
    // nor the interpolated prefix.
    [
      "const clis: string[] = ['a.js'];",
      'export default {',
      '  entry: clis.map((cli: string) => `.agents/scripts/${cli}!`),',
      '};',
      '',
    ].join('\n'),
  ],
  [
    'knip.ts',
    // Function-form config — knip unwraps it via `loadResolvedConfigFile`.
    [
      'export default () => ({',
      "  entry: ['.agents/scripts/a.js!'],",
      '});',
      '',
    ].join('\n'),
  ],
]) {
  test(`resolves an entry list declared in ${name}`, async () => {
    const root = makeFixtureRepo({
      clis: ['a.js'],
      packageJson: { scripts: { a: 'node .agents/scripts/a.js' } },
    });
    relocateConfig(root, name, body);

    const report = await resolveEntrySync({ repoRoot: root });
    assert.equal(report.error, null, `${name} must resolve`);
    assert.equal(report.skipped, null, `${name} exists — this is not a skip`);
    assert.deepEqual(report.declared, ['a.js']);
    assert.deepEqual(report.missing, []);
    assert.deepEqual(report.stale, []);
    assert.deepEqual(report.unsuffixed, []);
  });
}

test('a knip.config.ts that spreads an imported base resolves to the COMPUTED entry array', async () => {
  // The `Beestera/swarm-os` shape verbatim: knip 6 has no root-level `extends`,
  // so a consumer inheriting the shared `knip.base.json` must spread it inside a
  // TS module. #5026 read the file as JSON and saw an ENOENT; a hand-written TS
  // parser would see a spread it cannot evaluate. Only knip's own loader gets
  // the final array — which is why this gate goes through `createOptions`.
  const root = makeFixtureRepo({
    clis: ['from-base.js', 'from-local.js'],
    packageJson: {
      scripts: {
        base: 'node .agents/scripts/from-base.js',
        local: 'node .agents/scripts/from-local.js',
      },
    },
  });
  fs.writeFileSync(
    path.join(root, 'knip.base.json'),
    JSON.stringify({ entry: ['.agents/scripts/from-base.js!'] }),
  );
  relocateConfig(
    root,
    'knip.config.ts',
    [
      "import base from './knip.base.json';",
      'const config = {',
      '  ...base,',
      "  entry: [...base.entry, '.agents/scripts/from-local.js!'],",
      '};',
      'export default config;',
      '',
    ].join('\n'),
  );

  const report = await resolveEntrySync({ repoRoot: root });
  assert.equal(report.error, null);
  assert.deepEqual(report.declared, ['from-base.js', 'from-local.js']);
  assert.deepEqual(report.missing, [], 'the inherited entry must count');
  assert.deepEqual(report.stale, []);
});

test('entries declared under a workspace count alongside the top-level entry array', async () => {
  // A pnpm-workspace config puts entries under `workspaces`, so #5026 read an
  // empty declared set even when the config was plain JSON — every CLI would
  // have been reported missing.
  const root = makeFixtureRepo({
    clis: ['top.js', 'root-ws.js'],
    packageJson: {
      scripts: {
        top: 'node .agents/scripts/top.js',
        ws: 'node .agents/scripts/root-ws.js',
      },
    },
  });
  relocateConfig(root, 'knip.jsonc', {
    entry: ['.agents/scripts/top.js!'],
    workspaces: {
      '.': { entry: ['.agents/scripts/root-ws.js!'] },
      'packages/app': { entry: ['src/index.ts!'] },
    },
  });

  const report = await resolveEntrySync({ repoRoot: root });
  assert.equal(report.error, null);
  assert.deepEqual(report.declared, ['root-ws.js', 'top.js']);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.stale, []);
});

test('collectEntryPatterns: joins named-workspace patterns, leaves the root workspace alone, keeps negation leading', () => {
  const { patterns, sawEntryArray } = collectEntryPatterns({
    entry: ['top.js!'],
    workspaces: {
      '.': { entry: ['.agents/scripts/root.js!'] },
      './also-root': { entry: ['rel.js!'] },
      'packages/app/': { entry: ['src/index.ts!', '!src/ignored.ts'] },
      'packages/no-entry': { ignore: ['**/*.d.ts'] },
    },
  });
  assert.equal(sawEntryArray, true);
  assert.deepEqual(patterns.sort(), [
    '!packages/app/src/ignored.ts',
    '.agents/scripts/root.js!',
    'also-root/rel.js!',
    'packages/app/src/index.ts!',
    'top.js!',
  ]);
  // A config with no entry array anywhere is distinguishable from one that
  // simply declares nothing under .agents/scripts/.
  assert.equal(collectEntryPatterns({ workspaces: {} }).sawEntryArray, false);
  assert.equal(collectEntryPatterns(undefined).sawEntryArray, false);
});

test('no knip configuration at all is a clean skip, not a failure', async () => {
  // The whole point of Story #5039's opt-in posture: until this, wiring the
  // gate into a consumer that does not run knip red the build, and leaving it
  // unwired left #5001's guard unbuilt. Neither was the intended outcome.
  const root = makeFixtureRepo({
    clis: ['a.js'],
    packageJson: { scripts: { a: 'node .agents/scripts/a.js' } },
  });
  fs.rmSync(path.join(root, 'knip.json'));

  const report = await resolveEntrySync({ repoRoot: root });
  assert.equal(report.error, null);
  assert.match(report.skipped, /no knip configuration found/);
  assert.equal(countDivergences(report), 0);

  const stdout = {
    out: '',
    write(s) {
      this.out += s;
    },
  };
  assert.equal(
    await runCli({ argv: ['--cwd', root], stdout, stderr: { write() {} } }),
    0,
  );
  assert.match(stdout.out, /not applicable/);
});

test('an unresolvable knip package is a clean skip; an incompatible one is not', async () => {
  const root = makeFixtureRepo({
    clis: ['a.js'],
    packageJson: { scripts: { a: 'node .agents/scripts/a.js' } },
  });

  const absent = await resolveEntrySync({
    repoRoot: root,
    loadKnipSession: () => {
      throw new Error("Cannot find package 'knip'");
    },
  });
  assert.equal(absent.error, null);
  assert.match(absent.skipped, /not resolvable/);

  // Present but too old to export the resolver: that is a real breakage and
  // must not be swallowed as "nothing to check".
  const incompatible = await resolveEntrySync({
    repoRoot: root,
    loadKnipSession: async () => ({}),
  });
  assert.equal(incompatible.skipped, null);
  assert.match(incompatible.error, /does not export createOptions/);
});

test('a configuration that exists but throws on load exits 2, never 0', async () => {
  const root = makeFixtureRepo({
    clis: ['a.js'],
    packageJson: { scripts: { a: 'node .agents/scripts/a.js' } },
  });
  relocateConfig(
    root,
    'knip.config.ts',
    "throw new Error('boom from the config');\n",
  );

  const report = await resolveEntrySync({ repoRoot: root });
  assert.equal(report.skipped, null, 'breakage is not absence');
  assert.match(report.error, /cannot resolve the knip configuration/);
  // The message must name the file it tried, or the operator is left guessing
  // which of knip's eight config locations was picked up.
  assert.match(report.error, /knip\.config\.ts/);

  const stderr = {
    out: '',
    write(s) {
      this.out += s;
    },
  };
  assert.equal(
    await runCli({ argv: ['--cwd', root], stdout: { write() {} }, stderr }),
    2,
  );
});

// --- live-repository invariants ---------------------------------------------

test('INVARIANT: this repository\u2019s knip entry list matches its invoked CLI set', async () => {
  const report = await resolveEntrySync({ repoRoot: REPO_ROOT });
  assert.equal(report.error, null);
  assert.deepEqual(
    report.missing.map((m) => m.cli),
    [],
    'a CLI under .agents/scripts/ is invoked but missing from knip.json "entry" — ' +
      'add it, or knip reads it as unreachable and check-dead-exports will offer ' +
      'a false whole-file dead row for it and its private lib modules (Story #5012)',
  );
  assert.deepEqual(
    report.stale,
    [],
    'a knip.json "entry" is invoked by nothing — remove it so its death can ' +
      'surface, or wire up the caller (Story #5001)',
  );
  assert.deepEqual(
    report.phantom,
    [],
    'a knip.json "entry" names a file that is gone',
  );
});

test('INVARIANT: no entry-declared CLI is also recorded as a whole-file dead row', async () => {
  // The two artifacts must stay disjoint by construction. A CLI appearing in
  // both is precisely the poisoning #5012 nearly committed: declared live to
  // knip, yet recorded as expected-dead in the ratchet's own baseline.
  const { entries } = await readKnipEntries({ repoRoot: REPO_ROOT });
  const declared = new Set(entries);
  for (const baseline of [
    'baselines/dead-exports.json',
    'baselines/dead-exports-production.json',
  ]) {
    const { rows } = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, baseline), 'utf8'),
    );
    const contradictions = rows
      .filter((r) => r.symbol === '*')
      .map((r) => r.file)
      .filter((f) => /^\.agents\/scripts\/[^/]+\.js$/.test(f))
      .filter((f) => declared.has(f.slice('.agents/scripts/'.length)));
    assert.deepEqual(
      contradictions,
      [],
      `${baseline} records a whole-file dead row for a CLI that knip.json ` +
        'declares as an entry point — one of the two is a lie',
    );
  }
});
