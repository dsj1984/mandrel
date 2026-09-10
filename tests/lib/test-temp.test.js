/**
 * Unit tests for `.agents/scripts/lib/test-temp.js` (Story #4808).
 *
 * The module's whole point is that a temp directory cannot exist without
 * its teardown armed, so the tests that matter here are the ones about
 * nesting (attribution), exit-time reaping (the leak fix), and the
 * failure modes that must NOT propagate.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  _currentSuiteTempRoot,
  _resetSuiteTempRootForTests,
  findRawTmpdirMkdtemp,
  listSuiteTempRoots,
  makeTempDir,
  reapSuiteTempRoot,
  SUITE_ROOT_PREFIX,
  suiteTempRoot,
  survivingSuiteTempRoots,
} from '../../.agents/scripts/lib/test-temp.js';

/**
 * A fake OS temp root. Every assertion below runs against this, so the
 * module's own spec never pollutes the real temp root it exists to protect.
 * This one directory is the bootstrap that cannot come from the helper.
 */
let fakeTmp;
/** Exit codes the reaper asked for, captured by {@link quietDeps}. */
let exitCodes = [];

beforeEach(() => {
  exitCodes = [];
  // test-temp-allow: bootstrapping the fake OS temp root this spec runs against.
  fakeTmp = mkdtempSync(path.join(os.tmpdir(), 'test-temp-spec-'));
  _resetSuiteTempRootForTests();
});

afterEach(() => {
  _resetSuiteTempRootForTests();
  rmSync(fakeTmp, { recursive: true, force: true });
});

/** Deps bag pointing the module at the fake temp root, never the real one. */
const deps = () => ({ tmpdir: () => fakeTmp, onExit: () => {} });

/**
 * Deps bag that also captures the re-creation warning, so the vanished-root
 * branch never writes to the suite's stderr.
 *
 * @param {string[]} warnings sink the branch appends to
 * @param {(fn: () => void) => void} [onExit]
 */
const quietDeps = (warnings, onExit = () => {}) => ({
  tmpdir: () => fakeTmp,
  onExit,
  warn: (msg) => warnings.push(msg),
  // Captured, never applied: an exit reaper invoked in-process would
  // otherwise set this spec's own exit code to 1 and fail a green run.
  setExitCode: (code) => exitCodes.push(code),
});

describe('test-temp — suite root', () => {
  it('mints one root per process and memoizes it', () => {
    const first = suiteTempRoot(deps());
    const second = suiteTempRoot(deps());

    assert.equal(first, second);
    assert.equal(readdirSync(fakeTmp).length, 1);
  });

  it('names the root with the suite prefix and the pid', () => {
    const root = path.basename(suiteTempRoot(deps()));

    assert.ok(root.startsWith(SUITE_ROOT_PREFIX));
    assert.ok(
      root.startsWith(`${SUITE_ROOT_PREFIX}${process.pid}-`),
      `expected pid ${process.pid} in ${root}`,
    );
  });

  it('registers the reaper exactly once across repeated calls', () => {
    const registered = [];
    const d = { tmpdir: () => fakeTmp, onExit: (fn) => registered.push(fn) };

    suiteTempRoot(d);
    suiteTempRoot(d);

    assert.equal(registered.length, 1);
  });
});

describe('test-temp — a suite root that vanishes mid-run', () => {
  it('re-creates the root and returns the new path', () => {
    const warnings = [];
    const original = suiteTempRoot(quietDeps(warnings));
    rmSync(original, { recursive: true, force: true });

    const replacement = suiteTempRoot(quietDeps(warnings));

    assert.notEqual(replacement, original);
    assert.ok(existsSync(replacement));
    assert.equal(_currentSuiteTempRoot(), replacement);
  });

  it('lets a later makeTempDir succeed instead of throwing ENOENT', () => {
    const warnings = [];
    const before = makeTempDir('before-', quietDeps(warnings));
    rmSync(suiteTempRoot(quietDeps(warnings)), {
      recursive: true,
      force: true,
    });

    // The pre-removal directory is gone with the root; the point is that the
    // NEXT call works rather than cascading through the rest of the file.
    assert.ok(!existsSync(before));
    const after = makeTempDir('after-', quietDeps(warnings));

    assert.ok(existsSync(after));
    assert.ok(after.startsWith(_currentSuiteTempRoot() + path.sep));
  });

  it('refuses to re-create the OS temp root, and names it', () => {
    // Re-creating `/tmp` itself would hand the suite a directory with this
    // process's umask instead of the system's sticky 1777, and report a
    // broken machine as a passing run. Name it instead.
    const warnings = [];
    suiteTempRoot(quietDeps(warnings));
    rmSync(fakeTmp, { recursive: true, force: true });

    let err = null;
    try {
      suiteTempRoot(quietDeps(warnings));
    } catch (caught) {
      err = caught;
    }

    assert.ok(err, 'a missing OS temp root must throw, not be papered over');
    assert.match(err.message, /OS temp root/);
    assert.ok(
      err.message.includes(fakeTmp),
      'the message must name the directory that is gone',
    );
    assert.ok(!existsSync(fakeTmp), 'the guard creates nothing on its way out');
  });

  it('records every vanished root and fails the run at exit', () => {
    const warnings = [];
    const hooks = [];
    const d = () => quietDeps(warnings, (fn) => hooks.push(fn));
    const original = suiteTempRoot(d());
    rmSync(original, { recursive: true, force: true });
    suiteTempRoot(d());

    for (const hook of hooks) hook();

    assert.deepEqual(exitCodes, [1], 'a lost root is a non-zero verdict');
    const report = warnings.join('\n');
    assert.match(report, /1 suite temp root\(s\) disappeared mid-run/);
    assert.ok(
      report.includes(original),
      'the reaper must name the path that vanished',
    );
  });

  it('asks for no exit code when no root vanished', () => {
    const warnings = [];
    const hooks = [];
    suiteTempRoot(quietDeps(warnings, (fn) => hooks.push(fn)));

    for (const hook of hooks) hook();

    assert.deepEqual(exitCodes, []);
  });

  it('warns once, naming both the vanished and the replacement path', () => {
    const warnings = [];
    const original = suiteTempRoot(quietDeps(warnings));
    rmSync(original, { recursive: true, force: true });
    const replacement = suiteTempRoot(quietDeps(warnings));
    suiteTempRoot(quietDeps(warnings));

    assert.equal(warnings.length, 1, 'a surviving root re-warns nothing');
    assert.match(warnings[0], /disappeared mid-run/);
    assert.ok(warnings[0].includes(original));
    assert.ok(warnings[0].includes(replacement));
  });

  it('arms the exit reaper for the re-created root', () => {
    const warnings = [];
    const hooks = [];
    const d = () => quietDeps(warnings, (fn) => hooks.push(fn));
    rmSync(suiteTempRoot(d()), { recursive: true, force: true });
    const replacement = suiteTempRoot(d());

    // Whatever was armed — the hook reads the owned root at exit, so the
    // replacement is covered without a second registration.
    assert.ok(hooks.length >= 1);
    for (const hook of hooks) hook();

    assert.ok(!existsSync(replacement));
    assert.deepEqual(readdirSync(fakeTmp), [], 'nothing survives the exit');
  });

  it('reaps the root it now owns, never the path it replaced', () => {
    const warnings = [];
    const original = suiteTempRoot(quietDeps(warnings));
    rmSync(original, { recursive: true, force: true });
    const replacement = suiteTempRoot(quietDeps(warnings));

    const reaped = reapSuiteTempRoot();

    assert.equal(reaped, replacement);
    assert.notEqual(reaped, original);
    assert.ok(!existsSync(replacement));
  });

  it('re-creation does not let this process reach a sibling s root', () => {
    const warnings = [];
    const sibling = mkdtempSync(
      path.join(fakeTmp, `${SUITE_ROOT_PREFIX}999999-`),
    );
    rmSync(suiteTempRoot(quietDeps(warnings)), {
      recursive: true,
      force: true,
    });
    suiteTempRoot(quietDeps(warnings));

    reapSuiteTempRoot();

    assert.ok(existsSync(sibling), 'a sibling process s root is untouched');
  });
});

describe('test-temp — the vanished-root verdict in a real process', () => {
  const MODULE_URL = pathToFileURL(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../.agents/scripts/lib/test-temp.js',
    ),
  ).href;

  /**
   * Run `body` in a child that imports the real module, and report what the
   * process did. The exit code is the claim under test, and only a real
   * process has one — the in-process specs above can prove the reaper *asks*
   * for a code, never that Node honours it from an `exit` listener.
   *
   * @param {string} body module source appended after the import
   * @returns {{ status: number, stderr: string }}
   */
  const runChild = (body) => {
    const script = [
      "import { rmSync } from 'node:fs';",
      `const mod = await import(${JSON.stringify(MODULE_URL)});`,
      body,
    ].join('\n');
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        encoding: 'utf8',
      },
    );
    return { status: r.status, stderr: r.stderr ?? '' };
  };

  it('exits non-zero and names the root when one vanished', () => {
    const { status, stderr } = runChild(
      [
        'const root = mod.suiteTempRoot();',
        'rmSync(root, { recursive: true, force: true });',
        "mod.makeTempDir('after-');",
        'process.stderr.write(`ORIGINAL ${root}\\n`);',
      ].join('\n'),
    );

    assert.equal(status, 1, `a recovered run still fails; stderr:\n${stderr}`);
    const original = /ORIGINAL (.+)/.exec(stderr)?.[1]?.trim();
    assert.ok(original, 'the child must report the root it lost');
    assert.match(stderr, /disappeared mid-run/);
    assert.ok(
      stderr.includes(original),
      'the exit reaper must name the vanished path, not just its count',
    );
  });

  it('exits zero when the root survives the run', () => {
    const { status, stderr } = runChild(
      ["mod.makeTempDir('kept-');"].join('\n'),
    );

    assert.equal(status, 0, stderr);
    assert.doesNotMatch(stderr, /disappeared mid-run/);
  });
});

describe('test-temp — makeTempDir', () => {
  it('nests every directory inside the single suite root', () => {
    const a = makeTempDir('alpha-', deps());
    const b = makeTempDir('beta-', deps());
    const root = suiteTempRoot(deps());

    assert.ok(a.startsWith(root + path.sep));
    assert.ok(b.startsWith(root + path.sep));
    assert.notEqual(a, b);
    // One entry in the shared temp root, not one per directory.
    assert.deepEqual(readdirSync(fakeTmp), [path.basename(root)]);
  });

  it('returns an absolute, existing, writable directory', () => {
    const dir = makeTempDir('x-', deps());

    assert.ok(path.isAbsolute(dir));
    assert.ok(existsSync(dir));
  });

  it('keeps the caller-supplied prefix in the directory name', () => {
    const dir = makeTempDir('readable-label-', deps());

    assert.ok(path.basename(dir).startsWith('readable-label-'));
  });
});

describe('test-temp — reaping', () => {
  it('removes the root and everything under it', () => {
    const dir = makeTempDir('doomed-', deps());
    const root = suiteTempRoot(deps());

    const reaped = reapSuiteTempRoot();

    assert.equal(reaped, root);
    assert.ok(!existsSync(dir));
    assert.ok(!existsSync(root));
    assert.deepEqual(readdirSync(fakeTmp), []);
  });

  it('runs the registered exit hook, leaving the shared root clean', () => {
    let onExitFn = null;
    const d = { tmpdir: () => fakeTmp, onExit: (fn) => (onExitFn = fn) };
    makeTempDir('exit-', d);

    onExitFn();

    assert.deepEqual(readdirSync(fakeTmp), []);
  });

  it('is a no-op when this process never minted a root', () => {
    assert.equal(reapSuiteTempRoot(), null);
  });

  it('does not reap twice — the second call has nothing to remove', () => {
    makeTempDir('once-', deps());

    assert.ok(reapSuiteTempRoot() !== null);
    assert.equal(reapSuiteTempRoot(), null);
  });

  it('swallows a teardown failure and reports it instead of throwing', () => {
    makeTempDir('locked-', deps());
    const warnings = [];
    const fsImpl = {
      rmSync: () => {
        throw new Error('EPERM: locked');
      },
    };

    assert.doesNotThrow(() =>
      reapSuiteTempRoot({ fsImpl, warn: (m) => warnings.push(m) }),
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /failed to reap suite temp root/);
    assert.match(warnings[0], /EPERM: locked/);
  });

  it('forgets the root even when removal failed, so exit does not re-throw', () => {
    makeTempDir('locked-', deps());
    const fsImpl = {
      rmSync: () => {
        throw new Error('EPERM');
      },
    };

    reapSuiteTempRoot({ fsImpl, warn: () => {} });

    assert.equal(_currentSuiteTempRoot(), null);
  });
});

describe('test-temp — creator-only semantics', () => {
  it('a process that minted no root cannot reap another process s root', () => {
    // Simulate a sibling process's root sitting in the shared temp dir.
    const foreign = mkdtempSync(
      path.join(fakeTmp, `${SUITE_ROOT_PREFIX}999999-`),
    );

    const reaped = reapSuiteTempRoot();

    assert.equal(reaped, null, 'nothing was minted here, so nothing is reaped');
    assert.ok(existsSync(foreign), 'the foreign root survives untouched');
  });

  it('reaps only its own root, leaving a sibling process s root alone', () => {
    const sibling = mkdtempSync(
      path.join(fakeTmp, `${SUITE_ROOT_PREFIX}999999-`),
    );
    const mine = suiteTempRoot(deps());

    reapSuiteTempRoot();

    assert.ok(!existsSync(mine));
    assert.ok(existsSync(sibling), 'a sibling process s root is untouched');
  });
});

describe('test-temp — guard helpers', () => {
  it('lists only suite roots, ignoring unrelated temp entries', () => {
    mkdtempSync(path.join(fakeTmp, `${SUITE_ROOT_PREFIX}1-`));
    mkdtempSync(path.join(fakeTmp, 'something-else-'));

    const roots = listSuiteTempRoots(fakeTmp);

    assert.equal(roots.length, 1);
    assert.ok(roots[0].startsWith(SUITE_ROOT_PREFIX));
  });

  it('returns an empty list when the temp dir does not exist', () => {
    assert.deepEqual(listSuiteTempRoots(path.join(fakeTmp, 'absent')), []);
  });

  it('reports a root created since the snapshot as surviving', () => {
    const before = listSuiteTempRoots(fakeTmp);
    const leaked = path.basename(suiteTempRoot(deps()));

    assert.deepEqual(survivingSuiteTempRoots(fakeTmp, before), [leaked]);
  });

  it('ignores a root that already existed at snapshot time', () => {
    mkdtempSync(path.join(fakeTmp, `${SUITE_ROOT_PREFIX}222-`));
    const before = listSuiteTempRoots(fakeTmp);

    assert.deepEqual(survivingSuiteTempRoots(fakeTmp, before), []);
  });

  it('reports nothing once the run reaps its own root', () => {
    const before = listSuiteTempRoots(fakeTmp);
    suiteTempRoot(deps());
    reapSuiteTempRoot();

    assert.deepEqual(survivingSuiteTempRoots(fakeTmp, before), []);
  });
});

describe('test-temp — raw-tmpdir lint', () => {
  /** Build a throwaway repo tree with the given files. */
  const repoWith = (files) => {
    const root = makeTempDir('lint-repo-', deps());
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(root, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, body, 'utf8');
    }
    return root;
  };

  it('flags a mkdtemp call that reaches os.tmpdir() directly', () => {
    const root = repoWith({
      'tests/leaky.test.js':
        "const d = mkdtempSync(path.join(os.tmpdir(), 'leaky-'));\n",
    });

    const findings = findRawTmpdirMkdtemp(root, ['tests/**/*.js']);

    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, 'tests/leaky.test.js');
    assert.equal(findings[0].line, 1);
  });

  it('flags the bare-import and fs-namespaced call shapes too', () => {
    const root = repoWith({
      'tests/a.test.js': "mkdtempSync(join(tmpdir(), 'a-'));\n",
      'tests/b.test.js': "fs.mkdtempSync(path.join(os.tmpdir(), 'b-'));\n",
    });

    const findings = findRawTmpdirMkdtemp(root, ['tests/**/*.js']);

    assert.deepEqual(findings.map((f) => f.file).sort(), [
      'tests/a.test.js',
      'tests/b.test.js',
    ]);
  });

  it('accepts a directory obtained from the helper', () => {
    const root = repoWith({
      'tests/clean.test.js': "const d = makeTempDir('clean-');\n",
    });

    assert.deepEqual(findRawTmpdirMkdtemp(root, ['tests/**/*.js']), []);
  });

  it('honours the escape marker on the same line and the line above', () => {
    const root = repoWith({
      'tests/same.test.js':
        "mkdtempSync(path.join(os.tmpdir(), 'x-')); // test-temp-allow: needs the real root\n",
      'tests/above.test.js':
        "// test-temp-allow: needs the real root\nmkdtempSync(path.join(os.tmpdir(), 'y-'));\n",
    });

    assert.deepEqual(findRawTmpdirMkdtemp(root, ['tests/**/*.js']), []);
  });

  it('does not fire on files outside the passed globs', () => {
    const root = repoWith({
      'tests/in.test.js': "mkdtempSync(path.join(os.tmpdir(), 'in-'));\n",
      'src/out.js': "mkdtempSync(path.join(os.tmpdir(), 'out-'));\n",
    });

    const findings = findRawTmpdirMkdtemp(root, ['tests/**/*.js']);

    assert.deepEqual(
      findings.map((f) => f.file),
      ['tests/in.test.js'],
    );
  });

  it('narrows the scan with a !-prefixed exclude rather than widening it', () => {
    const root = repoWith({
      'tests/kept.test.js': "mkdtempSync(path.join(os.tmpdir(), 'k-'));\n",
      'tests/waived.test.js': "mkdtempSync(path.join(os.tmpdir(), 'w-'));\n",
      'src/untouched.js': "mkdtempSync(path.join(os.tmpdir(), 'u-'));\n",
    });

    const findings = findRawTmpdirMkdtemp(root, [
      'tests/**/*.js',
      '!tests/waived.test.js',
    ]);

    assert.deepEqual(
      findings.map((f) => f.file),
      ['tests/kept.test.js'],
      'the exclude must not pull in files outside the positive globs',
    );
  });

  it('scans nothing when only excludes are supplied', () => {
    const root = repoWith({
      'tests/in.test.js': "mkdtempSync(path.join(os.tmpdir(), 'in-'));\n",
    });

    assert.deepEqual(findRawTmpdirMkdtemp(root, ['!tests/**']), []);
  });

  it('scans nothing when no globs are supplied (consumer default)', () => {
    const root = repoWith({
      'tests/in.test.js': "mkdtempSync(path.join(os.tmpdir(), 'in-'));\n",
    });

    assert.deepEqual(findRawTmpdirMkdtemp(root, []), []);
    assert.deepEqual(findRawTmpdirMkdtemp(root, undefined), []);
  });

  it('descends dot-prefixed payload dirs so .agents __tests__ are covered', () => {
    const root = repoWith({
      '.agents/scripts/__tests__/x.test.js':
        "mkdtempSync(path.join(os.tmpdir(), 'x-'));\n",
    });

    const findings = findRawTmpdirMkdtemp(root, ['.agents/**/__tests__/**']);

    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, '.agents/scripts/__tests__/x.test.js');
  });
});
