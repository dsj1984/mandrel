// tests/lifecycle/lifecycle-lint.test.js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  findMergeLockoutViolations,
  findPromiseAllViolations,
} from '../../scripts/check-lifecycle-lint.js';

describe('lifecycle-lint/no-promise-all-lifecycle', () => {
  let dir;
  beforeEach(() => {
    dir = makeTempDir('mandrel-lint-1-');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('flags Promise.all under the lifecycle dir', () => {
    const file = path.join(dir, 'bad.js');
    writeFileSync(
      file,
      `
async function emit(event, payload) {
  const listeners = [a, b, c];
  await Promise.all(listeners.map((l) => l(event, payload)));
}
`,
      'utf8',
    );
    const violations = findPromiseAllViolations(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, file);
    assert.match(violations[0].hint, /append-only/);
    assert.match(violations[0].hint, /sequential/);
  });

  it('does not flag files without Promise.all', () => {
    writeFileSync(
      path.join(dir, 'good.js'),
      'async function emit() { for (const l of listeners) await l(); }\n',
      'utf8',
    );
    const violations = findPromiseAllViolations(dir);
    assert.deepEqual(violations, []);
  });

  it('respects lint-lifecycle-disable inline opt-out', () => {
    writeFileSync(
      path.join(dir, 'opted-out.js'),
      'await Promise.all([]); // lint-lifecycle-disable -- justified bulk emit\n',
      'utf8',
    );
    const violations = findPromiseAllViolations(dir);
    assert.deepEqual(violations, []);
  });

  it('recurses into nested directories', () => {
    const nested = path.join(dir, 'listeners', 'deep');
    mkdirSync(nested, { recursive: true });
    const file = path.join(nested, 'bad.js');
    writeFileSync(file, 'Promise.all([])\n', 'utf8');
    const violations = findPromiseAllViolations(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, file);
  });
});

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'check-lifecycle-lint.js');

describe('lifecycle-lint/cli', () => {
  // Story #5024: `main()` was the whole uncovered surface of this script — the
  // pure rule finders were tested, the CLI that wires them and picks the exit
  // code never was. A lint whose runner is unexercised can report clean because
  // it never assembled the rule set.
  it('exits 0 against the live tree and names both surviving rules', () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /\[lifecycle-lint\] clean/);
    assert.match(result.stdout, /Promise\.all/);
    assert.match(result.stdout, /merge-lockout/);
  });

  it('exits 1 and tags the offending rule when a violation is planted', () => {
    // Plant into a temp root, NOT the live tree. The property this test was
    // written for — that the CLI's own discovery finds the violation, rather
    // than an injected fixture path — survives, because `--root` only moves
    // where the walk starts; the walk is still the CLI's.
    //
    // Planting into the real `.agents/` tree raced
    // `tests/e2e/sync-prune.integration.test.js`, which copies that same tree
    // with the real binary: the sync either lost the file between enumeration
    // and `copyfile` (ENOENT) or copied it on the first pass and pruned it on
    // the second, tripping the idempotence assertion. Both tests were correct
    // in isolation; this one mutated shared state the other read (Story #5052,
    // filed as #5051).
    const root = makeTempDir('mandrel-lint-cli-');
    try {
      const lifecycleDir = path.join(
        root,
        '.agents',
        'scripts',
        'lib',
        'orchestration',
        'lifecycle',
      );
      mkdirSync(lifecycleDir, { recursive: true });
      writeFileSync(
        path.join(lifecycleDir, 'zz-planted-violation.js'),
        'export const x = Promise.all([]);\n',
        'utf8',
      );

      const result = spawnSync(
        process.execPath,
        [SCRIPT_PATH, '--root', root],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      assert.equal(result.status, 1, `stdout: ${result.stdout}`);
      assert.match(result.stderr, /no-promise-all-lifecycle/);
      assert.match(result.stderr, /zz-planted-violation\.js/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves the real .agents/ tree untouched while scanning an injected root', () => {
    // The regression guard for #5051: the CLI test must not create the file
    // whose transient presence broke the sync e2e. Asserting on the exact path
    // keeps the guard honest if someone reinstates the live-tree plant.
    const livePlant = path.join(
      REPO_ROOT,
      '.agents',
      'scripts',
      'lib',
      'orchestration',
      'lifecycle',
      'zz-planted-violation.js',
    );
    const root = makeTempDir('mandrel-lint-cli-untouched-');
    try {
      const lifecycleDir = path.join(
        root,
        '.agents',
        'scripts',
        'lib',
        'orchestration',
        'lifecycle',
      );
      mkdirSync(lifecycleDir, { recursive: true });
      writeFileSync(
        path.join(lifecycleDir, 'zz-planted-violation.js'),
        'export const x = Promise.all([]);\n',
        'utf8',
      );

      spawnSync(process.execPath, [SCRIPT_PATH, '--root', root], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });

      assert.equal(
        existsSync(livePlant),
        false,
        'scanning an injected root must never write into the shared source tree',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the merge-lockout exemptions suffix-matched under an injected root', () => {
    // The allow-list is matched by absolute-path SUFFIX, so it has to keep
    // biting when the root moves. Re-anchoring it to the repo root would make
    // the authorized carrier report a violation under any other root.
    const root = makeTempDir('mandrel-lint-cli-exempt-');
    try {
      const phasesDir = path.join(
        root,
        '.agents',
        'scripts',
        'lib',
        'orchestration',
        'single-story-close',
        'phases',
      );
      mkdirSync(phasesDir, { recursive: true });
      writeFileSync(
        path.join(phasesDir, 'auto-merge.js'),
        "const cmd = 'gh pr merge --auto --squash';\n",
        'utf8',
      );

      const result = spawnSync(
        process.execPath,
        [SCRIPT_PATH, '--root', root],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      assert.equal(
        result.status,
        0,
        `the authorized carrier must stay exempt; stderr: ${result.stderr}`,
      );
      assert.match(result.stdout, /\[lifecycle-lint\] clean/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--help exits 0 with a usage block and never reaches the scan', () => {
    // Supplying `usage` is what makes runAsCli short-circuit --help before
    // main(); this script used to fall through and run a full scan, which is
    // why it sat in KNOWN_HELP_GAPS (tests/scripts/cli-help-contract.test.js).
    const result = spawnSync(process.execPath, [SCRIPT_PATH, '--help'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(
      result.stdout,
      /^Usage: node scripts\/check-lifecycle-lint\.js /m,
      'usage block did not print the invocation line',
    );
    assert.match(result.stdout, /--root <dir>/);
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      /\[lifecycle-lint\] clean/,
      '--help fell through to the scan path',
    );
  });
});

describe('lifecycle-lint/edge cases', () => {
  let dir;
  beforeEach(() => {
    dir = makeTempDir('mandrel-lint-edge-');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('treats a missing directory as clean rather than throwing', () => {
    // Load-bearing since Story #5024 deleted lifecycle/listeners/: a scan of a
    // directory that no longer exists must not crash the lint. ENOENT is the
    // only swallowed error — any other readdir failure still propagates.
    const gone = path.join(dir, 'no-such-dir');
    assert.deepEqual(findPromiseAllViolations(gone), []);
    assert.deepEqual(findMergeLockoutViolations(gone), []);
  });

  it('honours the lint-lifecycle-disable opt-out on a merge-lockout line', () => {
    const optedOut = path.join(dir, 'opted-out.js');
    writeFileSync(
      optedOut,
      "const cmd = 'gh pr merge'; // lint-lifecycle-disable\n",
      'utf8',
    );
    assert.deepEqual(findMergeLockoutViolations(dir), []);

    const notOptedOut = path.join(dir, 'plain.js');
    writeFileSync(notOptedOut, "const cmd = 'gh pr merge';\n", 'utf8');
    const violations = findMergeLockoutViolations(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, notOptedOut);
  });
});
