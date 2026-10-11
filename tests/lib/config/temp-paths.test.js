/**
 * Unit tests for `lib/config/temp-paths.js` (Epic #1030 Story #1039 / Task
 * #1051). Covers the five named helpers, the missing-tempRoot fallback,
 * argument validation, and Windows-friendly `path.join` normalization
 * (no double-slashes regardless of how the operator wrote `tempRoot`).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  _clearMainCheckoutRootCache,
  _clearTestContextScratchCache,
  anchorTempRoot,
  closeGateLogPath,
  mainCheckoutRoot,
  runArtifactPath,
  runTempDir,
  signalsFile,
  storyManifestPath,
  storyTempDir,
  storyTerminalEnvelopePath,
  TEST_ALLOW_REAL_TEMP_ENV,
  TEST_TEMP_ROOT_ENV,
  tempRootFrom,
} from '../../../.agents/scripts/lib/config/temp-paths.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

const SEP = path.sep;

// The shared test bootstrap sets MANDREL_TEST_TEMP_ROOT so stray writers land
// in scratch (Story #4696). This suite verifies the *production* main-checkout
// anchoring, so it must run with the override cleared — otherwise every
// relative-root assertion would resolve under scratch. Since Story #4711 the
// test-context fallback would then re-arm scratch lazily, so the suite also
// sets the explicit real-tree opt-out (it only computes paths, never writes).
// Node runs each test file in its own process, so mutating the env here does
// not leak to siblings.
let savedScratchEnv;
let savedAllowRealEnv;
before(() => {
  savedScratchEnv = process.env[TEST_TEMP_ROOT_ENV];
  delete process.env[TEST_TEMP_ROOT_ENV];
  savedAllowRealEnv = process.env[TEST_ALLOW_REAL_TEMP_ENV];
  process.env[TEST_ALLOW_REAL_TEMP_ENV] = '1';
});
after(() => {
  if (savedScratchEnv === undefined) delete process.env[TEST_TEMP_ROOT_ENV];
  else process.env[TEST_TEMP_ROOT_ENV] = savedScratchEnv;
  if (savedAllowRealEnv === undefined) {
    delete process.env[TEST_ALLOW_REAL_TEMP_ENV];
  } else {
    process.env[TEST_ALLOW_REAL_TEMP_ENV] = savedAllowRealEnv;
  }
});

/**
 * The directory helpers anchor a *relative* tempRoot to the main checkout
 * root (Story #3900). In the test process — which runs inside the repo
 * working tree — `mainCheckoutRoot()` resolves to a real path, so the
 * expected directory is `<root>/<relative-suffix>`. Helper to build the
 * expected anchored path for a relative-tempRoot suffix.
 */
function anchored(...segments) {
  const root = mainCheckoutRoot();
  const suffix = path.join(...segments);
  return root ? path.join(root, suffix) : suffix;
}

describe('lib/config/temp-paths.js — tempRoot resolution', () => {
  it('returns "temp" when no config is provided', () => {
    assert.equal(tempRootFrom(undefined), 'temp');
    assert.equal(tempRootFrom(null), 'temp');
    assert.equal(tempRootFrom({}), 'temp');
  });

  it('reads from a full resolved config (project.paths.tempRoot)', () => {
    const config = { project: { paths: { tempRoot: 'tmp/work' } } };
    assert.equal(tempRootFrom(config), 'tmp/work');
  });

  it('ignores legacy agentSettings.paths shape (hard cutover)', () => {
    const config = { agentSettings: { paths: { tempRoot: 'workspace' } } };
    assert.equal(tempRootFrom(config), 'temp');
  });

  it('ignores a bare `paths` bag (hard cutover)', () => {
    const config = { paths: { tempRoot: 'workspace' } };
    assert.equal(tempRootFrom(config), 'temp');
  });

  it('falls back to "temp" when tempRoot is empty / non-string', () => {
    assert.equal(
      tempRootFrom({ project: { paths: { tempRoot: '' } } }),
      'temp',
    );
    assert.equal(
      tempRootFrom({ project: { paths: { tempRoot: null } } }),
      'temp',
    );
    assert.equal(
      tempRootFrom({ project: { paths: { tempRoot: 123 } } }),
      'temp',
    );
  });
});

describe('lib/config/temp-paths.js — Run / Story directory helpers', () => {
  it('builds the canonical run dir (default tempRoot)', () => {
    assert.equal(runTempDir(1030), anchored('temp', 'run-1030'));
  });

  it('honours a custom tempRoot via config bag', () => {
    const cfg = { project: { paths: { tempRoot: 'workspace' } } };
    assert.equal(runTempDir(42, cfg), anchored('workspace', 'run-42'));
  });

  it('builds the canonical story dir', () => {
    assert.equal(
      storyTempDir(1030, 1042),
      anchored('temp', 'run-1030', 'stories', 'story-1042'),
    );
  });

  it('rejects non-positive epicId / storyId', () => {
    assert.throws(() => runTempDir(0), /positive integer/);
    assert.throws(() => runTempDir(-1), /positive integer/);
    assert.throws(() => runTempDir(1.5), /positive integer/);
    assert.throws(() => storyTempDir(1, 0), /positive integer/);
    assert.throws(() => storyTempDir(1, -2), /positive integer/);
  });
});

describe('lib/config/temp-paths.js — signals + canonical artifact paths', () => {
  it('signalsFile resolves to stories/story-<sid>/signals.ndjson', () => {
    assert.equal(
      signalsFile(1030, 1042),
      anchored('temp', 'run-1030', 'stories', 'story-1042', 'signals.ndjson'),
    );
  });

  it('Story-level canonical filenames live under the Story dir', () => {
    assert.equal(
      storyManifestPath(1030, 1042),
      anchored('temp', 'run-1030', 'stories', 'story-1042', 'manifest.md'),
    );
  });
});

describe('lib/config/temp-paths.js — artifact-name guards', () => {
  it('runArtifactPath accepts a leaf name', () => {
    assert.equal(
      runArtifactPath(1030, 'custom.md'),
      anchored('temp', 'run-1030', 'custom.md'),
    );
  });

  it('rejects an empty / non-string artifact name', () => {
    assert.throws(() => runArtifactPath(1030, ''), /non-empty string/);
    assert.throws(() => runArtifactPath(1030, undefined), /non-empty string/);
    assert.throws(() => runArtifactPath(1030, 42), /non-empty string/);
  });

  it('rejects a name containing path separators (traversal guard)', () => {
    assert.throws(
      () => runArtifactPath(1030, '../escape.md'),
      /must not contain path separators/,
    );
    assert.throws(
      () => runArtifactPath(1030, 'sub/dir.md'),
      /must not contain path separators/,
    );
    assert.throws(
      () => runArtifactPath(1030, 'a\\b.md'),
      /must not contain path separators/,
    );
  });
});

describe('lib/config/temp-paths.js — path.join semantics (Windows + POSIX)', () => {
  it('round-trips through path.join with no double-separators', () => {
    // path.join collapses repeated separators; round-tripping the result
    // through path.normalize should be a no-op.
    const cfg = { project: { paths: { tempRoot: 'temp' } } };
    const candidates = [
      runTempDir(1030, cfg),
      storyTempDir(1030, 1042, cfg),
      signalsFile(1030, 1042, cfg),
      storyManifestPath(1030, 1042, cfg),
    ];
    for (const p of candidates) {
      assert.equal(
        p,
        path.normalize(p),
        `expected ${p} to be already normalized`,
      );
      assert.ok(
        !p.includes(`${SEP}${SEP}`),
        `expected no double separators in ${p}`,
      );
    }
  });

  it('handles a tempRoot with a trailing separator', () => {
    const cfg = { project: { paths: { tempRoot: `tmp${SEP}` } } };
    const dir = runTempDir(1030, cfg);
    assert.ok(
      !dir.includes(`${SEP}${SEP}`),
      `expected trailing-slash tempRoot to collapse: ${dir}`,
    );
    assert.equal(path.normalize(dir), dir);
  });

  it('handles a nested tempRoot ("a/b/temp")', () => {
    const cfg = {
      project: { paths: { tempRoot: path.join('a', 'b', 'temp') } },
    };
    assert.equal(runTempDir(1030, cfg), anchored('a', 'b', 'temp', 'run-1030'));
    assert.equal(
      signalsFile(1030, 1042, cfg),
      anchored(
        'a',
        'b',
        'temp',
        'run-1030',
        'stories',
        'story-1042',
        'signals.ndjson',
      ),
    );
  });

  it('honours an absolute tempRoot verbatim (no main-checkout anchoring)', () => {
    const absRoot = path.resolve(SEP, 'var', 'mandrel-temp');
    const cfg = { project: { paths: { tempRoot: absRoot } } };
    assert.equal(runTempDir(1030, cfg), path.join(absRoot, 'run-1030'));
  });

  it('honours platform-native separators', () => {
    // On Windows path.join produces backslashes; on POSIX it produces
    // forward slashes. Either way the helper must use path.join — assert
    // the exact separator that ships on the host.
    const dir = storyTempDir(1030, 1042);
    assert.ok(
      dir.includes(`run-1030${SEP}stories${SEP}story-1042`),
      `expected platform separator '${SEP}' in ${dir}`,
    );
  });
});

describe('lib/config/temp-paths.js — standalone Story routing (Story #2874)', () => {
  it('storyTempDir(null, sid) routes to <tempRoot>/standalone/stories/story-<sid>', () => {
    const dir = storyTempDir(null, 1042);
    assert.equal(dir, anchored('temp', 'standalone', 'stories', 'story-1042'));
  });

  it('signalsFile(null, sid) routes through the standalone parent', () => {
    const file = signalsFile(null, 1042);
    assert.equal(
      file,
      anchored('temp', 'standalone', 'stories', 'story-1042', 'signals.ndjson'),
    );
  });

  it('storyManifestPath(null, sid) routes through the standalone parent', () => {
    const file = storyManifestPath(null, 7);
    assert.equal(
      file,
      anchored('temp', 'standalone', 'stories', 'story-7', 'manifest.md'),
    );
  });

  it('honours a custom tempRoot under standalone', () => {
    const cfg = { project: { paths: { tempRoot: path.join('a', 'b') } } };
    assert.equal(
      storyTempDir(null, 7, cfg),
      anchored('a', 'b', 'standalone', 'stories', 'story-7'),
    );
  });

  it('still rejects 0 / negative epicId (null is the only standalone signal)', () => {
    assert.throws(
      () => storyTempDir(0, 7),
      /epicId must be a positive integer or null/,
    );
    assert.throws(
      () => storyTempDir(-1, 7),
      /epicId must be a positive integer or null/,
    );
  });
});

describe('lib/config/temp-paths.js — main-checkout anchoring (Story #3900)', () => {
  // Build an ABSOLUTE fake git-common-dir via path.resolve so it carries a
  // drive letter on Windows. The implementation keeps an absolute
  // `--git-common-dir` verbatim, so the expected root is exactly its
  // path.dirname — computed the same way to avoid drive-letter divergence
  // between path.resolve(SEP, ...) (gets the cwd drive) and the bare `\repo`
  // path.join produces on Windows (no drive).
  const REPO_ROOT_ABS = path.resolve(SEP, 'repo');
  const COMMON_GIT_ABS = path.join(REPO_ROOT_ABS, '.git');
  const EXPECTED_ROOT = path.dirname(COMMON_GIT_ABS);

  it('mainCheckoutRoot returns the parent of `--git-common-dir`', () => {
    _clearMainCheckoutRootCache();
    const fakeExec = () => `${COMMON_GIT_ABS}\n`;
    const root = mainCheckoutRoot('/anywhere', { exec: fakeExec });
    assert.equal(root, EXPECTED_ROOT);
  });

  it('mainCheckoutRoot resolves a relative `--git-common-dir` against cwd', () => {
    const cwd = path.join(REPO_ROOT_ABS, 'checkout');
    // A relative `--git-common-dir` output (e.g. `.git`) is resolved against
    // the cwd, then its parent is taken. Compute the expectation the same way
    // the implementation does so the drive letter matches on Windows.
    const relOut = '.git';
    const fakeExec = () => `${relOut}\n`;
    const root = mainCheckoutRoot(cwd, { exec: fakeExec });
    assert.equal(root, path.dirname(path.resolve(cwd, relOut)));
  });

  it('a worktree cwd and the main-checkout cwd converge on the same ledger root', () => {
    // The bug: heartbeats written from a worktree cwd and reads from the
    // main checkout cwd must target the same `temp/run-N/lifecycle.ndjson`.
    const fakeExec = () => `${COMMON_GIT_ABS}\n`;
    const fromWorktree = mainCheckoutRoot(
      path.join(REPO_ROOT_ABS, '.worktrees', 'story-7'),
      { exec: fakeExec },
    );
    const fromMain = mainCheckoutRoot(REPO_ROOT_ABS, { exec: fakeExec });
    assert.equal(fromWorktree, fromMain);
  });

  it('mainCheckoutRoot returns null when git is unavailable / non-repo', () => {
    const throwingExec = () => {
      throw new Error('not a git repository');
    };
    const root = mainCheckoutRoot('/tmp/not-a-repo', { exec: throwingExec });
    assert.equal(root, null);
  });
});

describe('lib/config/temp-paths.js — scratch tempRoot seam (Story #4696)', () => {
  const SCRATCH = path.resolve(SEP, 'tmp', 'mandrel-scratch-abc');

  it('anchorTempRoot redirects a relative root under scratch when the override is set', () => {
    const env = { [TEST_TEMP_ROOT_ENV]: SCRATCH };
    assert.equal(anchorTempRoot('temp', env), path.join(SCRATCH, 'temp'));
    assert.equal(
      anchorTempRoot(path.join('a', 'b'), env),
      path.join(SCRATCH, 'a', 'b'),
    );
  });

  it('anchorTempRoot ignores an empty / relative override (would re-anchor to the repo)', () => {
    // An empty or relative override is treated as unset, so a relative root
    // falls through to main-checkout anchoring rather than the scratch join.
    // (Real-tree opt-out set: without it the Story #4711 test-context
    // fallback would divert to lazy scratch instead of the main checkout.)
    const root = mainCheckoutRoot();
    const expected = root ? path.join(root, 'temp') : 'temp';
    assert.equal(
      anchorTempRoot('temp', {
        [TEST_TEMP_ROOT_ENV]: '',
        [TEST_ALLOW_REAL_TEMP_ENV]: '1',
      }),
      expected,
    );
    assert.equal(
      anchorTempRoot('temp', {
        [TEST_TEMP_ROOT_ENV]: 'temp',
        [TEST_ALLOW_REAL_TEMP_ENV]: '1',
      }),
      expected,
    );
  });

  it('anchorTempRoot returns an absolute root verbatim even under scratch', () => {
    const env = { [TEST_TEMP_ROOT_ENV]: SCRATCH };
    const abs = path.resolve(SEP, 'var', 'injected');
    assert.equal(anchorTempRoot(abs, env), abs);
  });

  it('anchorTempRoot falls back to main-checkout anchoring when no override is set (opt-out)', () => {
    // With the override cleared and the real-tree opt-out set, a relative
    // root anchors to the real main checkout, not scratch. (Without the
    // opt-out a node:test context now lazily arms scratch — Story #4711.)
    const resolved = anchorTempRoot('temp', {
      [TEST_ALLOW_REAL_TEMP_ENV]: '1',
    });
    const root = mainCheckoutRoot();
    assert.equal(resolved, root ? path.join(root, 'temp') : 'temp');
  });
});

describe('lib/config/temp-paths.js — test-context arming fallback (Story #4711)', () => {
  const FAKE_SCRATCH = path.join(os.tmpdir(), 'mandrel-test-temp-FAKE');

  afterEach(() => {
    _clearTestContextScratchCache();
  });

  it('a NODE_TEST_CONTEXT process with no override lazily arms scratch', () => {
    _clearTestContextScratchCache();
    const prefixes = [];
    const mkdtemp = (prefix) => {
      prefixes.push(prefix);
      return FAKE_SCRATCH;
    };
    const resolved = anchorTempRoot(
      'temp',
      { NODE_TEST_CONTEXT: 'child' },
      { mkdtemp, execArgv: [] },
    );
    assert.equal(resolved, path.join(FAKE_SCRATCH, 'temp'));
    assert.deepEqual(prefixes, [path.join(os.tmpdir(), 'mandrel-test-temp-')]);
  });

  it('the lazily-armed scratch dir is created once per process (idempotent)', () => {
    _clearTestContextScratchCache();
    let calls = 0;
    const mkdtemp = () => {
      calls += 1;
      return FAKE_SCRATCH;
    };
    const first = anchorTempRoot(
      'temp',
      { NODE_TEST_CONTEXT: 'child' },
      { mkdtemp, execArgv: [] },
    );
    const second = anchorTempRoot(
      path.join('a', 'b'),
      { NODE_TEST_CONTEXT: 'child' },
      { mkdtemp, execArgv: [] },
    );
    assert.equal(calls, 1);
    assert.equal(first, path.join(FAKE_SCRATCH, 'temp'));
    assert.equal(second, path.join(FAKE_SCRATCH, 'a', 'b'));
  });

  it('detects a direct `node --test` runner process via execArgv', () => {
    _clearTestContextScratchCache();
    const resolved = anchorTempRoot(
      'temp',
      {},
      { mkdtemp: () => FAKE_SCRATCH, execArgv: ['--test'] },
    );
    assert.equal(resolved, path.join(FAKE_SCRATCH, 'temp'));
  });

  it('the explicit opt-out restores main-checkout anchoring (escape hatch)', () => {
    _clearTestContextScratchCache();
    const root = mainCheckoutRoot();
    const resolved = anchorTempRoot(
      'temp',
      { NODE_TEST_CONTEXT: 'child', [TEST_ALLOW_REAL_TEMP_ENV]: '1' },
      {
        mkdtemp: () => {
          throw new Error('must not create scratch under the opt-out');
        },
        execArgv: [],
      },
    );
    assert.equal(resolved, root ? path.join(root, 'temp') : 'temp');
  });

  it('an armed absolute override still wins over the fallback', () => {
    _clearTestContextScratchCache();
    const armed = path.resolve(SEP, 'tmp', 'already-armed');
    const resolved = anchorTempRoot(
      'temp',
      { NODE_TEST_CONTEXT: 'child', [TEST_TEMP_ROOT_ENV]: armed },
      {
        mkdtemp: () => {
          throw new Error('must reuse the armed override, not re-create');
        },
        execArgv: [],
      },
    );
    assert.equal(resolved, path.join(armed, 'temp'));
  });

  it('a non-test context is untouched (main-checkout anchoring)', () => {
    _clearTestContextScratchCache();
    const root = mainCheckoutRoot();
    const resolved = anchorTempRoot(
      'temp',
      {},
      {
        mkdtemp: () => {
          throw new Error('must not create scratch outside a test context');
        },
        execArgv: [],
      },
    );
    assert.equal(resolved, root ? path.join(root, 'temp') : 'temp');
  });
});

/**
 * Byte sizes of every `.ndjson` stream file under `dir`.
 *
 * @param {string} dir
 * @returns {Map<string, number>}
 */
function streamSizes(dir) {
  const sizes = new Map();
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile() && ent.name.endsWith('.ndjson')) {
        sizes.set(abs, statSync(abs).size);
      }
    }
  };
  walk(dir);
  return sizes;
}

/**
 * Stream files under `dir` whose bytes appended since `sizesBefore` carry
 * `nonce`. Attributes a write to the fixture that stamped the nonce: the
 * shared checkout's streams are appended to by every concurrent delivery on
 * the host, so growth alone is not evidence of a leak (#5613).
 *
 * @param {string} dir
 * @param {Map<string, number>} sizesBefore
 * @param {string} nonce
 * @returns {string[]}
 */
function streamsCarryingNonce(dir, sizesBefore, nonce) {
  const hits = [];
  for (const [abs, size] of streamSizes(dir)) {
    const from = sizesBefore.get(abs) ?? 0;
    if (size <= from) continue;
    if (readFileSync(abs).subarray(from).includes(nonce)) hits.push(abs);
  }
  return hits;
}

describe('streamsCarryingNonce — leak attribution (#5613)', () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir('stream-nonce-');
    mkdirSync(path.join(dir, 'story-1'), { recursive: true });
    mkdirSync(path.join(dir, 'story-2'), { recursive: true });
    writeFileSync(path.join(dir, 'story-1', 'signals.ndjson'), '{"a":1}\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores a concurrent append that does not carry the nonce', () => {
    const before = streamSizes(dir);
    appendFileSync(path.join(dir, 'story-1', 'signals.ndjson'), '{"b":2}\n');
    writeFileSync(path.join(dir, 'story-2', 'signals.ndjson'), '{"c":3}\n');
    assert.deepEqual(streamsCarryingNonce(dir, before, 'nonce-x'), []);
  });

  it('names a grown or new stream that received the nonce', () => {
    const before = streamSizes(dir);
    const grown = path.join(dir, 'story-1', 'signals.ndjson');
    const created = path.join(dir, 'story-2', 'signals.ndjson');
    appendFileSync(grown, '{"nonce":"nonce-x"}\n');
    writeFileSync(created, '{"nonce":"nonce-x"}\n');
    assert.deepEqual(
      streamsCarryingNonce(dir, before, 'nonce-x').sort(),
      [grown, created].sort(),
    );
  });

  it('does not re-read bytes that were already there before the run', () => {
    writeFileSync(
      path.join(dir, 'story-1', 'signals.ndjson'),
      '{"nonce":"nonce-x"}\n',
    );
    const before = streamSizes(dir);
    appendFileSync(path.join(dir, 'story-1', 'signals.ndjson'), '{"b":2}\n');
    assert.deepEqual(streamsCarryingNonce(dir, before, 'nonce-x'), []);
  });
});

describe('lib/config/temp-paths.js — direct `node --test` appends zero bytes to the real tree (Story #4711, AC-3)', () => {
  it('a signals-writing fixture run via direct `node --test` lands in scratch, not temp/standalone', () => {
    const repoRoot = mainCheckoutRoot();
    assert.ok(repoRoot, 'suite must run inside a git checkout');
    const protectedDir = path.join(repoRoot, 'temp', 'standalone', 'stories');

    const sizesBefore = streamSizes(protectedDir);
    const nonce = `leak-probe-${randomUUID()}`;

    // Fixture: resolves the standalone story-4428 signals path through the
    // production helper and appends one line to it — exactly the measured
    // #4711 bypass shape — printing the resolved path for the outer assert.
    const tempPathsUrl = new URL(
      '../../../.agents/scripts/lib/config/temp-paths.js',
      import.meta.url,
    ).href;
    const fixtureDir = makeTempDir('arming-fixture-');
    // `.mjs` so the fixture parses as ESM outside any package.json scope.
    const fixturePath = path.join(fixtureDir, 'arming-fixture.test.mjs');
    writeFileSync(
      fixturePath,
      [
        `import { test } from 'node:test';`,
        `import { appendFileSync, mkdirSync } from 'node:fs';`,
        `import path from 'node:path';`,
        `import { signalsFile } from ${JSON.stringify(tempPathsUrl)};`,
        `test('fixture appends a signal record', () => {`,
        `  const target = signalsFile(null, 4428);`,
        `  mkdirSync(path.dirname(target), { recursive: true });`,
        `  appendFileSync(target, JSON.stringify({ kind: 'friction', fixture: true, nonce: ${JSON.stringify(nonce)} }) + '\\n');`,
        `  console.log('RESOLVED:' + target);`,
        `});`,
        '',
      ].join('\n'),
    );

    try {
      // Strip every arming/opt-out variable: this is the raw direct-run shape
      // that measurably appended 12 fixture records pre-#4711.
      const env = { ...process.env };
      delete env[TEST_TEMP_ROOT_ENV];
      delete env[TEST_ALLOW_REAL_TEMP_ENV];
      delete env.NODE_TEST_CONTEXT;
      const res = spawnSync(process.execPath, ['--test', fixturePath], {
        cwd: repoRoot,
        env,
        encoding: 'utf8',
      });
      assert.equal(
        res.status,
        0,
        `fixture run failed:\n${res.stdout}\n${res.stderr}`,
      );
      const m = /RESOLVED:(.+)/.exec(res.stdout);
      assert.ok(m, `fixture did not print its resolved path:\n${res.stdout}`);
      const resolved = m[1].trim();
      assert.ok(path.isAbsolute(resolved));
      assert.ok(
        !resolved.startsWith(path.join(repoRoot, 'temp') + path.sep),
        `fixture write landed in the real tree: ${resolved}`,
      );

      assert.deepEqual(
        streamsCarryingNonce(protectedDir, sizesBefore, nonce),
        [],
        'fixture record landed in a real stream file',
      );
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

describe('storyTerminalEnvelopePath — the persisted terminal envelope (#4816)', () => {
  it('sits beside the gate log under the configured temp root', () => {
    const config = { project: { paths: { tempRoot: 'scratch' } } };
    assert.equal(
      storyTerminalEnvelopePath(4816, config),
      anchored('scratch', 'orchestration', 'story-deliver-terminal-4816.json'),
    );
  });

  it('falls back to the framework-default temp root with no config', () => {
    assert.equal(
      storyTerminalEnvelopePath(4816),
      anchored('temp', 'orchestration', 'story-deliver-terminal-4816.json'),
    );
  });

  it('honours an absolute temp root verbatim', () => {
    const abs = path.join(os.tmpdir(), 'mandrel-4816-abs');
    const config = { project: { paths: { tempRoot: abs } } };
    assert.equal(
      storyTerminalEnvelopePath(7, config),
      path.join(abs, 'orchestration', 'story-deliver-terminal-7.json'),
    );
  });

  it('anchors to the MAIN checkout, not the caller cwd', () => {
    // The load-bearing property: the close runs inside `.worktrees/story-<id>/`
    // while the /mandrel-deliver host reads from the main checkout. An un-anchored
    // relative root would file the envelope where the router never looks.
    const resolved = storyTerminalEnvelopePath(4816, {
      project: { paths: { tempRoot: 'temp' } },
    });
    assert.equal(path.isAbsolute(resolved), Boolean(mainCheckoutRoot()));
    assert.ok(!resolved.includes(`.worktrees${SEP}`));
  });

  it('names the basename the retention scanner parses', () => {
    assert.equal(
      path.basename(storyTerminalEnvelopePath(4816)),
      'story-deliver-terminal-4816.json',
    );
  });

  it('pairs the envelope with the gate log the recovery probe reads', () => {
    // Both artifacts of one close, same directory, same Story scope — the
    // retention purge takes them as a pair and the probe reads them together.
    const config = { project: { paths: { tempRoot: 'scratch' } } };
    assert.equal(
      path.dirname(closeGateLogPath(4816, config)),
      path.dirname(storyTerminalEnvelopePath(4816, config)),
    );
    assert.equal(
      path.basename(closeGateLogPath(4816, config)),
      'close-gates-4816.log',
    );
    assert.equal(
      path.basename(closeGateLogPath(null, config)),
      'close-gates-unknown.log',
      'the sink\u2019s no-Story sentinel keeps its spelling',
    );
  });

  it('rejects a non-positive-integer Story id rather than pathing to junk', () => {
    for (const bad of [0, -1, 1.5, null, undefined, '4816']) {
      assert.throws(() => storyTerminalEnvelopePath(bad), /positive integer/);
    }
  });
});
