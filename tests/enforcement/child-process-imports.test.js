/**
 * child-process-imports.test.js — the ratchet behind the one exec surface
 * (Story #5009).
 *
 * `.agents/scripts/lib/child-exec.js` owns the child-process stdout ceiling,
 * the `shell: false` posture, and the child failure-message shape. That
 * ownership only holds if new code cannot quietly reach around it, which is
 * what this test enforces: the set of modules importing `node:child_process`
 * directly is **captured**, not migrated. Every entry below was already an
 * importer when the wrapper landed and is grandfathered as-is; the test fails
 * on the fifty-first.
 *
 * The failure mode this prevents is the one the ENOBUFS class kept
 * reproducing — a new spawn site with no `maxBuffer`, inheriting Node's 1 MB
 * default, killing its own child on a large `git show` or a chatty `pre-push`
 * hook, and getting fixed one site at a time (Stories #4914, #4915, #4948).
 *
 * Removing a module from the tree means removing its allowlist line: the
 * stale-entry test below refuses to let the allowlist outlive its files, so
 * the ratchet tightens with every deletion instead of accumulating slack.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Shipped source roots. Everything else (tests, fixtures, temp) is out of scope. */
const SCAN_ROOTS = ['.agents/scripts', 'bin', 'lib'];

/** Directory names never descended into while scanning. */
const SKIP_DIRS = new Set([
  '.git',
  '.worktrees',
  '__tests__',
  'coverage',
  'fixtures',
  'node_modules',
  'temp',
]);

/**
 * Static `import … from`, `require(…)` and dynamic `import(…)` of the Node
 * child-process module. A bare mention in a comment or JSDoc type is not an
 * import and must not trip the ratchet.
 */
const CHILD_PROCESS_IMPORT_RE =
  /(?:from\s*['"]node:child_process['"]|require\(\s*['"]node:child_process['"]\s*\)|import\(\s*['"]node:child_process['"]\s*\))/;

/** The shared exec surface itself — necessarily an importer, by definition. */
const WRAPPER = '.agents/scripts/lib/child-exec.js';

/**
 * Modules importing `node:child_process` directly as of Story #5009.
 *
 * Grandfathered, not endorsed. New code calls `child-exec.js` instead; an
 * addition here needs a reason that the wrapper genuinely cannot serve —
 * `spawn` streaming, a `timeout` bound, or a raw `error`/`signal` the
 * wrapper's contract deliberately does not surface.
 */
const ALLOWLIST = new Set([
  WRAPPER,
  '.agents/scripts/bootstrap.js',
  '.agents/scripts/check-windows-git-perf.js',
  '.agents/scripts/diagnose-friction.js',
  '.agents/scripts/evidence-gate.js',
  '.agents/scripts/lib/bootstrap/gh-list.js',
  '.agents/scripts/lib/bootstrap/gh-preflight.js',
  '.agents/scripts/lib/bootstrap/preflight.js',
  '.agents/scripts/lib/bootstrap/project-bootstrap.js',
  '.agents/scripts/lib/bootstrap/prompt.js',
  '.agents/scripts/lib/bootstrap/quality-bootstrap.js',
  '.agents/scripts/lib/checks/state.js',
  '.agents/scripts/lib/close-validation/commands.js',
  '.agents/scripts/lib/close-validation/process.js',
  '.agents/scripts/lib/config/temp-paths.js',
  '.agents/scripts/lib/coverage-capture.js',
  '.agents/scripts/lib/dead-exports-knip.js',
  '.agents/scripts/lib/feedback-loop/graduator-gh.js',
  '.agents/scripts/lib/format-generated-json.js',
  '.agents/scripts/lib/gh-exec.js',
  '.agents/scripts/lib/git-utils.js',
  '.agents/scripts/lib/install-cmd-parser.js',
  '.agents/scripts/lib/onboard/init-tail.js',
  '.agents/scripts/lib/orchestration/git-cleanup/phases/git-probes.js',
  '.agents/scripts/lib/orchestration/pr-watch.js',
  '.agents/scripts/lib/orchestration/remote-verifier.js',
  '.agents/scripts/lib/orchestration/review-providers/codex.js',
  '.agents/scripts/lib/orchestration/review-providers/scoped-lint.js',
  '.agents/scripts/lib/orchestration/review-providers/security-review.js',
  '.agents/scripts/lib/orchestration/story-close/format-autofix.js',
  '.agents/scripts/lib/single-story-sweep/protection-ctx.js',
  // Story #5485: streams a full suite as a supervised process group (inherit
  // stdio, group kill, suite-ready handshake) that the wrapper cannot serve.
  '.agents/scripts/lib/supervised-suite.js',
  '.agents/scripts/lib/test-runner-contract.js',
  '.agents/scripts/lib/worktree/git-hooks.js',
  '.agents/scripts/lib/worktree/lifecycle/force-drain.js',
  '.agents/scripts/lib/worktree/node-modules-strategy.js',
  '.agents/scripts/lint-issue-body.js',
  '.agents/scripts/mandrel-update-preflight.js',
  '.agents/scripts/providers/github/auth.js',
  '.agents/scripts/providers/github/projects-v2-graphql.js',
  '.agents/scripts/quality-watch.js',
  '.agents/scripts/run-tests.js',
  'lib/cli/guarded-sync.js',
  'lib/cli/init.js',
  'lib/cli/registry.js',
  'lib/cli/update.js',
]);

/**
 * A numeric `maxBuffer` option literal — the hand-copied constant this Story
 * consolidated, and the shape that had drifted to 10 / 16 / 64 MB across nine
 * modules. `maxBuffer: someIdentifier` is fine: the identifier resolves to an
 * import from the wrapper.
 */
const NUMERIC_MAX_BUFFER_RE = /maxBuffer\s*:\s*\d/;

/** Where the ceiling constant is *defined*, as opposed to referenced. */
const MAX_BUFFER_DEFINITION_RE = /\bMAX_BUFFER_BYTES\s*=/;

/**
 * Every non-test `.js` file under `SCAN_ROOTS`, as repo-relative POSIX paths.
 *
 * @param {string} root - Absolute repository root.
 * @returns {string[]}
 */
function listSourceFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.js') &&
        !entry.name.endsWith('.test.js')
      ) {
        found.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  for (const scanRoot of SCAN_ROOTS) {
    const abs = path.join(root, scanRoot);
    if (fs.existsSync(abs)) walk(abs);
  }
  return found.sort();
}

/**
 * Partition scanned files against the allowlist. Pure over its `read`
 * argument so the ratchet's own logic is testable without touching the tree.
 *
 * @param {string[]} files - Repo-relative paths.
 * @param {(file: string) => string} read - File-contents reader.
 * @param {Set<string>} allowlist
 * @returns {{ importers: string[], unallowed: string[], stale: string[] }}
 */
function auditChildProcessImports(files, read, allowlist) {
  const importers = files.filter((file) =>
    CHILD_PROCESS_IMPORT_RE.test(read(file)),
  );
  const importerSet = new Set(importers);
  return {
    importers,
    unallowed: importers.filter((file) => !allowlist.has(file)),
    stale: [...allowlist].filter((file) => !importerSet.has(file)).sort(),
  };
}

/**
 * Source files whose text matches `pattern`.
 *
 * @param {string[]} files
 * @param {(file: string) => string} read
 * @param {RegExp} pattern
 * @returns {string[]}
 */
function filesMatching(files, read, pattern) {
  return files.filter((file) => pattern.test(read(file)));
}

const readSource = (file) =>
  fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

describe('auditChildProcessImports (the ratchet itself)', () => {
  const fixture = {
    'a.js': "import { spawnSync } from 'node:child_process';\n",
    'b.js': "const cp = require('node:child_process');\n",
    'c.js': "const cp = await import('node:child_process');\n",
    'd.js': '// mentions node:child_process in prose only\n',
    'e.js': "import { spawnChild } from './lib/child-exec.js';\n",
  };
  const read = (file) => fixture[file];
  const files = Object.keys(fixture);

  it('flags a NEW importer that is not on the allowlist', () => {
    const { unallowed } = auditChildProcessImports(
      files,
      read,
      new Set(['b.js', 'c.js']),
    );
    assert.deepEqual(
      unallowed,
      ['a.js'],
      'a static import from an unlisted module must fail the ratchet',
    );
  });

  it('passes an importer that IS on the allowlist', () => {
    const { unallowed } = auditChildProcessImports(
      files,
      read,
      new Set(['a.js', 'b.js', 'c.js']),
    );
    assert.deepEqual(unallowed, []);
  });

  it('catches require() and dynamic import(), not prose mentions', () => {
    const { importers } = auditChildProcessImports(files, read, new Set());
    assert.deepEqual(
      importers,
      ['a.js', 'b.js', 'c.js'],
      'the comment-only and wrapper-using modules are not importers',
    );
  });

  it('reports allowlist entries that no longer import as stale', () => {
    const { stale } = auditChildProcessImports(
      files,
      read,
      new Set(['a.js', 'deleted.js']),
    );
    assert.deepEqual(stale, ['deleted.js']);
  });
});

describe('node:child_process imports across the shipped tree', () => {
  const files = listSourceFiles(REPO_ROOT);

  it('scans a non-trivial set of source files', () => {
    assert.ok(
      files.length > 100,
      `expected the scan to reach the shipped tree, saw ${files.length} files`,
    );
  });

  it('no module outside the allowlist imports node:child_process', () => {
    const { unallowed } = auditChildProcessImports(
      files,
      readSource,
      ALLOWLIST,
    );
    assert.deepEqual(
      unallowed,
      [],
      `New direct node:child_process importer(s):\n  ${unallowed.join('\n  ')}\n` +
        `→ use .agents/scripts/lib/child-exec.js (execFileCapture / spawnChild / spawnCapture),\n` +
        `  which owns the 64 MiB stdout ceiling, shell:false and error normalisation.\n` +
        `  If the wrapper genuinely cannot serve the call (streaming spawn, timeout\n` +
        `  bound, raw error/signal), add the file to ALLOWLIST in this test with a reason.`,
    );
  });

  it('the allowlist carries no stale entries', () => {
    const { stale } = auditChildProcessImports(files, readSource, ALLOWLIST);
    assert.deepEqual(
      stale,
      [],
      `ALLOWLIST entries that no longer import node:child_process:\n  ${stale.join('\n  ')}\n` +
        '→ delete those lines so the ratchet tightens instead of accumulating slack.',
    );
  });

  it('the wrapper is on the allowlist and does import it', () => {
    const { importers } = auditChildProcessImports(
      files,
      readSource,
      ALLOWLIST,
    );
    assert.ok(ALLOWLIST.has(WRAPPER));
    assert.ok(
      importers.includes(WRAPPER),
      'the shared exec surface must be the module that owns the real runners',
    );
  });
});

describe('maxBuffer is defined once (Story #5009 AC-1)', () => {
  const files = listSourceFiles(REPO_ROOT);

  it('exactly one module defines the ceiling constant', () => {
    assert.deepEqual(
      filesMatching(files, readSource, MAX_BUFFER_DEFINITION_RE),
      [WRAPPER],
      'the stdout ceiling has one definition site; every other module gets ' +
        'it by importing child-exec.js (or by letting its default apply)',
    );
  });

  it('no module carries a hand-written numeric maxBuffer literal', () => {
    assert.deepEqual(
      filesMatching(files, readSource, NUMERIC_MAX_BUFFER_RE),
      [],
      'a bare maxBuffer number re-forks the ceiling — pass an imported ' +
        'constant, or omit the option and take the wrapper default',
    );
  });
});
