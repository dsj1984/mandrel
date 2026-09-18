import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import picomatch from 'picomatch';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  FULL_TIER_GLOBS,
  INTEGRATION_INCLUDE,
  listTestFilesForTier,
  parseTierArgv,
} from '../../.agents/scripts/lib/test-tiers.js';

test('parseTierArgv defaults to full', () => {
  assert.deepEqual(parseTierArgv([]), { tier: 'full', rest: [] });
  assert.deepEqual(parseTierArgv(['tests/one.test.js']), {
    tier: 'full',
    rest: ['tests/one.test.js'],
  });
});

test('parseTierArgv extracts tier and remainder', () => {
  assert.deepEqual(
    parseTierArgv(['--tier', 'quick', '--test-name-pattern', 'x']),
    { tier: 'quick', rest: ['--test-name-pattern', 'x'] },
  );
});

test('parseTierArgv accepts the e2e tier', () => {
  assert.deepEqual(parseTierArgv(['--tier', 'e2e']), { tier: 'e2e', rest: [] });
});

test('parseTierArgv rejects unknown tier', () => {
  assert.throws(() => parseTierArgv(['--tier', 'nope']), /quick, integration/);
  assert.throws(() => parseTierArgv(['--tier', 'nope']), /e2e/);
});

// ---------------------------------------------------------------------------
// Story #5111 — unknown flags fail loudly.
//
// `node --test` reads an unrecognized `--flag` as another *file pattern*, so
// forwarding one produced a run that matched nothing, printed a plausible
// summary and exited 0. The rejection is what makes a typo visible.
// ---------------------------------------------------------------------------

test('parseTierArgv rejects an unrecognized flag, naming the accepted set', () => {
  assert.throws(
    () => parseTierArgv(['--tier', 'quick', '--bogus']),
    (err) => {
      assert.match(err.message, /--bogus/);
      assert.match(err.message, /--tier <full\|quick\|integration\|e2e>/);
      assert.match(err.message, /--test-name-pattern/);
      assert.match(err.message, /--test-only/);
      return true;
    },
  );
});

test('parseTierArgv rejects an unrecognized flag with no --tier present', () => {
  assert.throws(() => parseTierArgv(['--bogus']), /unrecognized argument/);
});

test('parseTierArgv forwards the documented node --test pass-throughs', () => {
  assert.deepEqual(parseTierArgv(['--test-only']), {
    tier: 'full',
    rest: ['--test-only'],
  });
  assert.deepEqual(parseTierArgv(['--test-name-pattern=foo']), {
    tier: 'full',
    rest: ['--test-name-pattern=foo'],
  });
});

test('parseTierArgv leaves positional file targets alone', () => {
  assert.deepEqual(parseTierArgv(['--tier', 'quick', 'tests/a.test.js']), {
    tier: 'quick',
    rest: ['tests/a.test.js'],
  });
});

test('listTestFilesForTier partitions quick vs integration', () => {
  const root = makeTempDir('tier-');
  const testsDir = path.join(root, 'tests', 'unit');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.writeFileSync(path.join(testsDir, 'fast.test.js'), '');
  fs.writeFileSync(path.join(testsDir, 'slow.integration.test.js'), '');
  fs.writeFileSync(
    path.join(root, 'tests', 'hook-chain-reflog-invariant.test.js'),
    '',
  );

  const quick = listTestFilesForTier('quick', root, fs);
  const integration = listTestFilesForTier('integration', root, fs);

  assert.ok(quick.includes('tests/unit/fast.test.js'));
  assert.ok(!quick.includes('tests/unit/slow.integration.test.js'));
  assert.ok(!quick.includes('tests/hook-chain-reflog-invariant.test.js'));

  assert.ok(integration.includes('tests/unit/slow.integration.test.js'));
  assert.ok(integration.includes('tests/hook-chain-reflog-invariant.test.js'));
  assert.ok(!integration.includes('tests/unit/fast.test.js'));

  fs.rmSync(root, { recursive: true, force: true });
});

test('listTestFilesForTier full enumerates every walked test file', () => {
  const root = makeTempDir('tier-full-');
  fs.mkdirSync(path.join(root, 'tests', 'unit'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib', 'cli', '__tests__'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests', 'unit', 'fast.test.js'), '');
  fs.writeFileSync(
    path.join(root, 'tests', 'unit', 'slow.integration.test.js'),
    '',
  );
  fs.writeFileSync(path.join(root, 'lib', 'cli', '__tests__', 'x.test.js'), '');

  // Story #5111: the full tier used to return FULL_TIER_GLOBS verbatim. It
  // enumerates files now, because `node --test` has no negative pattern and
  // "everything except tests/e2e/**" is only sayable as a file set.
  assert.deepEqual(listTestFilesForTier('full', root, fs), [
    'lib/cli/__tests__/x.test.js',
    'tests/unit/fast.test.js',
    'tests/unit/slow.integration.test.js',
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Story #5111 — the e2e tier. `tests/e2e/**` packs the repo and drives real
// `npm install` spawns, so it leaves every tier `npm test`, `test:quick` and
// `test:integration` run and gets its own.
// ---------------------------------------------------------------------------

test('tests/e2e belongs to the e2e tier and to no other tier', () => {
  const root = makeTempDir('tier-e2e-');
  fs.mkdirSync(path.join(root, 'tests', 'e2e'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'tests', 'e2e', 'update-chain.integration.test.js'),
    '',
  );
  fs.writeFileSync(path.join(root, 'tests', 'plain.test.js'), '');

  const e2eFile = 'tests/e2e/update-chain.integration.test.js';
  assert.deepEqual(listTestFilesForTier('e2e', root, fs), [e2eFile]);
  for (const tier of ['full', 'quick', 'integration']) {
    assert.ok(
      !listTestFilesForTier(tier, root, fs).includes(e2eFile),
      `tier ${tier} must not carry ${e2eFile}`,
    );
  }
  // …and the tier does not swallow anything that is not under tests/e2e/.
  assert.ok(
    listTestFilesForTier('full', root, fs).includes('tests/plain.test.js'),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('the real repository e2e tier is exactly the tests/e2e suites', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const e2e = listTestFilesForTier('e2e', repoRoot);
  assert.ok(e2e.length > 0, 'the e2e tier must not be empty');
  assert.ok(e2e.every((f) => f.startsWith('tests/e2e/')));
  const full = listTestFilesForTier('full', repoRoot);
  assert.deepEqual(
    full.filter((f) => f.startsWith('tests/e2e/')),
    [],
    'npm test must not run tests/e2e — that is the whole point of the tier',
  );
});

test('quick / integration walk lib/**/__tests__ as a second root', () => {
  const root = makeTempDir('tier-lib-');
  const libTests = path.join(root, 'lib', 'cli', '__tests__');
  fs.mkdirSync(libTests, { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(libTests, 'update.test.js'), '');

  const quick = listTestFilesForTier('quick', root, fs);
  const integration = listTestFilesForTier('integration', root, fs);

  // The colocated CLI test is dark today; it must land in the runner's
  // walk-derived target list (quick tier — it is not in INTEGRATION_INCLUDE).
  assert.ok(quick.includes('lib/cli/__tests__/update.test.js'));
  assert.ok(!integration.includes('lib/cli/__tests__/update.test.js'));

  fs.rmSync(root, { recursive: true, force: true });
});

test('quick / integration walk .agents/scripts/**/__tests__ as a third root', () => {
  const root = makeTempDir('tier-agents-');
  const agentTests = path.join(
    root,
    '.agents',
    'scripts',
    'lib',
    'audit-to-stories',
    '__tests__',
  );
  fs.mkdirSync(agentTests, { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(agentTests, 'audit-lenses.test.js'), '');

  const quick = listTestFilesForTier('quick', root, fs);
  const integration = listTestFilesForTier('integration', root, fs);

  // Colocated orchestration-engine tests under .agents/scripts must be
  // discovered (Story #4195) — quick tier, since they are not in
  // INTEGRATION_INCLUDE.
  const rel =
    '.agents/scripts/lib/audit-to-stories/__tests__/audit-lenses.test.js';
  assert.ok(quick.includes(rel));
  assert.ok(!integration.includes(rel));

  fs.rmSync(root, { recursive: true, force: true });
});

test('INTEGRATION_INCLUDE matches documented slow suites', () => {
  assert.ok(
    INTEGRATION_INCLUDE.some((p) =>
      p.includes('check-baselines-regression.test.js'),
    ),
  );
});

// Story #4545 — every curated (non-glob) entry must resolve to a real file.
// Three entries named files deleted in the v2.0.0 cutover
// (epic-execute-record-wave, push-epic-retry, concurrency-wiring). They failed
// SILENTLY rather than loudly: `listTestFilesForTier` filters a real directory
// walk through `matchesIntegration`, so a curated path with no file on disk
// simply never matches and is dropped from the tier. The suite it was meant to
// pin then stops running with no signal. This guard is what the old
// membership assertion should have been — it pinned one of the dead paths by
// name, which is precisely why the drift survived.
test('every curated INTEGRATION_INCLUDE entry resolves to a file on disk', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const missing = INTEGRATION_INCLUDE.filter(
    (entry) =>
      !entry.includes('*') && !fs.existsSync(path.join(repoRoot, entry)),
  );
  assert.deepEqual(
    missing,
    [],
    `curated integration entries name files that do not exist: ${missing.join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// Story #4922 — FULL_TIER_GLOBS is the single source of truth for the full
// tier's file set, and it has two consumers: run-tests.js (via
// listTestFilesForTier) and run-coverage.js. The coverage runner used to
// restate `tests/**/*.test.js` on its own, so the colocated __tests__ suites
// ran under `npm test` but were invisible to every coverage / CRAP reading.
// ---------------------------------------------------------------------------

test('FULL_TIER_GLOBS names one glob per test walk root', () => {
  assert.ok(Array.isArray(FULL_TIER_GLOBS));
  assert.deepEqual(FULL_TIER_GLOBS, [
    'tests/**/*.test.js',
    'lib/**/__tests__/**/*.test.js',
    '.agents/scripts/**/__tests__/**/*.test.js',
  ]);
});

test('FULL_TIER_GLOBS is the measured surface: a superset of the full tier', () => {
  // Story #5111. The coverage runner keeps measuring tests/e2e/** even though
  // `npm test` no longer runs it: c8's NODE_V8_COVERAGE is inherited by the
  // real `mandrel` child processes those suites spawn, so dropping them from
  // the measured run would deflate bin/mandrel.js and lib/cli/update.js and
  // red the coverage ratchet on code nobody touched.
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const measured = picomatch(FULL_TIER_GLOBS, { dot: true });
  const e2e = listTestFilesForTier('e2e', repoRoot);
  assert.ok(e2e.length > 0);
  for (const file of e2e) {
    assert.ok(
      measured(file),
      `${file} left the full tier but must stay in the measured surface`,
    );
  }
  for (const file of listTestFilesForTier('full', repoRoot)) {
    assert.ok(
      measured(file),
      `${file} is in the full tier but is not measured`,
    );
  }
});

test('every FULL_TIER_GLOB matches at least one real test file', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const all = listTestFilesForTier('quick', repoRoot).concat(
    listTestFilesForTier('integration', repoRoot),
  );
  for (const glob of FULL_TIER_GLOBS) {
    const isMatch = picomatch(glob, { dot: true });
    assert.ok(
      all.some((f) => isMatch(f)),
      `full-tier glob ${glob} matches no file on disk — the tier walks a surface that does not exist`,
    );
  }
});

test('the coverage runner consumes FULL_TIER_GLOBS rather than a literal', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const src = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'run-coverage.js'),
    'utf8',
  );
  assert.ok(
    /FULL_TIER_GLOBS/.test(src),
    'run-coverage.js must import FULL_TIER_GLOBS',
  );
  // No glob literal of its own: a bare quoted `*.test.js` target in the
  // executable body is exactly the drift this SSOT exists to prevent.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(
    /['"`][^'"`]*\*[^'"`]*\.test\.js['"`]/.test(code),
    false,
    'run-coverage.js restates a test glob literal instead of consuming FULL_TIER_GLOBS',
  );
});
