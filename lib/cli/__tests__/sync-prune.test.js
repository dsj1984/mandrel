// lib/cli/__tests__/sync-prune.test.js
/**
 * Unit tests for the sync-prune pass introduced by Story #4046 A3.
 *
 * When `mandrel sync` runs, after the copy pass it deletes any file inside the
 * managed `.agents/` zone (everything outside `.agents/local/`) that has no
 * counterpart in the package payload. Consumer additions under `.agents/local/`
 * are never touched.
 *
 * Coverage contract (Story #4046 A3):
 *   1. A destination file that has no payload counterpart is pruned (deleted).
 *   2. A consumer file under `.agents/local/` is NOT pruned even if it has no
 *      payload counterpart.
 *   3. Consumer additions outside `.agents/local/` but inside the managed zone
 *      are pruned (e.g. `.agents/workflows/old-workflow.md` deleted upstream).
 *   4. `--dry-run` reports stale files that would be pruned but deletes nothing.
 *   5. After a prune pass, `runSync` is idempotent — a second run leaves
 *      the tree byte-identical and prunes nothing.
 *   6. `result.pruned` reports the number of deleted stale files.
 *
 * Tier: unit (testing-standards § Unit). All filesystem I/O is mocked via
 * the in-memory fs fake used by sync.test.js.
 *
 * Security (security-baseline § 5 — Data Leakage & Logging): fixtures carry
 * only file paths and content strings; no tokens or credentials.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { runSync } from '../sync.js';

// ---------------------------------------------------------------------------
// In-memory filesystem fake (extends sync.test.js fake with unlinkSync)
// ---------------------------------------------------------------------------

/**
 * Build an in-memory fs that supports the full surface runSync uses, including
 * `unlinkSync` for the prune pass.
 *
 * @param {Record<string,string>} seed - Absolute path → content.
 */
function makeFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  const unlinked = [];

  function dirEntries(dir) {
    const norm = dir.endsWith(path.sep) ? dir.slice(0, -1) : dir;
    const children = new Map(); // name → isDir
    for (const abs of files.keys()) {
      if (!abs.startsWith(norm + path.sep)) continue;
      const rest = abs.slice(norm.length + 1);
      const segments = rest.split(path.sep);
      const name = segments[0];
      children.set(name, segments.length > 1);
    }
    return [...children.entries()].map(([name, isDir]) => ({
      name,
      isDirectory: () => isDir,
    }));
  }

  return {
    files,
    unlinked,
    readdirSync(dir, _opts) {
      return dirEntries(dir);
    },
    existsSync(p) {
      const norm = p.endsWith(path.sep) ? p.slice(0, -1) : p;
      if (files.has(norm)) return true;
      for (const abs of files.keys()) {
        if (abs.startsWith(norm + path.sep)) return true;
      }
      return false;
    },
    mkdirSync() {},
    copyFileSync(src, dest) {
      if (!files.has(src))
        throw new Error(`copyFileSync: source missing ${src}`);
      files.set(dest, files.get(src));
    },
    symlinkSync() {},
    unlinkSync(p) {
      unlinked.push(p);
      files.delete(p);
    },
  };
}

/** Capture stdout/stderr writes and the exit code. */
function makeCapture() {
  const out = [];
  const err = [];
  let exitCode = null;
  return {
    out,
    err,
    get exitCode() {
      return exitCode;
    },
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    exit: (code) => {
      exitCode = code;
    },
  };
}

const PROJECT = path.join(path.sep, 'proj');
const PKG_ROOT = path.join(PROJECT, 'node_modules', 'mandrel');
const SRC_AGENTS = path.join(PKG_ROOT, '.agents');
const DEST_AGENTS = path.join(PROJECT, '.agents');
const resolveToPkg = () => PKG_ROOT;

/** Seed a minimal payload: two files. */
function seedPayload() {
  return {
    [path.join(SRC_AGENTS, 'instructions.md')]: '# instructions\n',
    [path.join(SRC_AGENTS, 'rules', 'security-baseline.md')]: '# security\n',
  };
}

// ---------------------------------------------------------------------------
// AC1 — upstream-deleted file is pruned from the consumer
// ---------------------------------------------------------------------------

describe('runSync — prune pass removes stale managed-zone files (A3)', () => {
  it('deletes a managed-zone file that has no payload counterpart', () => {
    // Arrange: payload has 2 files, but the consumer's .agents/ also has a
    // stale file (old-workflow.md) that was deleted from the payload.
    const staleFile = path.join(DEST_AGENTS, 'workflows', 'old-workflow.md');
    const fs = makeFs({
      ...seedPayload(),
      [staleFile]: '# stale workflow\n',
    });
    const cap = makeCapture();

    const result = runSync({
      argv: [],
      resolvePackageRoot: resolveToPkg,
      fs,
      cwd: () => PROJECT,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    // The stale file must be gone.
    assert.equal(
      fs.files.has(staleFile),
      false,
      'stale file must be deleted after sync',
    );
    assert.equal(result.pruned, 1);
    assert.equal(result.copied, 2);
    assert.equal(cap.exitCode, null);
    // The success message must mention pruning.
    assert.match(cap.out.join(''), /pruned 1 stale file/);
  });

  it('prunes multiple stale files in one pass', () => {
    const stale1 = path.join(DEST_AGENTS, 'workflows', 'old-a.md');
    const stale2 = path.join(DEST_AGENTS, 'workflows', 'old-b.md');
    const fs = makeFs({
      ...seedPayload(),
      [stale1]: '# old a\n',
      [stale2]: '# old b\n',
    });
    const cap = makeCapture();

    const result = runSync({
      argv: [],
      resolvePackageRoot: resolveToPkg,
      fs,
      cwd: () => PROJECT,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.equal(fs.files.has(stale1), false);
    assert.equal(fs.files.has(stale2), false);
    assert.equal(result.pruned, 2);
  });

  it('result.pruned is 0 when no stale files exist', () => {
    const fs = makeFs(seedPayload());
    const cap = makeCapture();

    const result = runSync({
      argv: [],
      resolvePackageRoot: resolveToPkg,
      fs,
      cwd: () => PROJECT,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.equal(result.pruned, 0);
    // No "pruned" mention in the normal success message.
    assert.doesNotMatch(cap.out.join(''), /pruned/);
  });
});

// ---------------------------------------------------------------------------
// AC2 — .agents/local/ is never pruned
// ---------------------------------------------------------------------------

describe('runSync — .agents/local/ consumer additions are never pruned (A3)', () => {
  it('does not delete a consumer file in the local zone', () => {
    const localFile = path.join(DEST_AGENTS, 'local', 'my-custom.md');
    const fs = makeFs({
      ...seedPayload(),
      [localFile]: '# consumer local file\n',
    });
    const cap = makeCapture();

    const result = runSync({
      argv: [],
      resolvePackageRoot: resolveToPkg,
      fs,
      cwd: () => PROJECT,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    // local zone file must still be present.
    assert.equal(
      fs.files.get(localFile),
      '# consumer local file\n',
      '.agents/local/ addition must not be pruned',
    );
    assert.equal(result.pruned, 0);
  });

  it('prunes a stale managed-zone file while preserving a local-zone file', () => {
    const staleFile = path.join(DEST_AGENTS, 'workflows', 'deleted.md');
    const localFile = path.join(DEST_AGENTS, 'local', 'mine.md');
    const fs = makeFs({
      ...seedPayload(),
      [staleFile]: '# stale\n',
      [localFile]: '# mine\n',
    });
    const cap = makeCapture();

    const result = runSync({
      argv: [],
      resolvePackageRoot: resolveToPkg,
      fs,
      cwd: () => PROJECT,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.equal(
      fs.files.has(staleFile),
      false,
      'stale managed-zone file pruned',
    );
    assert.equal(
      fs.files.get(localFile),
      '# mine\n',
      'local-zone file preserved',
    );
    assert.equal(result.pruned, 1);
  });
});

// ---------------------------------------------------------------------------
// AC4 — --dry-run reports stale files, deletes nothing
// ---------------------------------------------------------------------------

describe('runSync — --dry-run prune preview (A3)', () => {
  it('reports a stale file that would be pruned but does not delete it', () => {
    const staleFile = path.join(DEST_AGENTS, 'workflows', 'old.md');
    const fs = makeFs({
      ...seedPayload(),
      [staleFile]: '# stale\n',
    });
    const cap = makeCapture();

    const result = runSync({
      argv: ['--dry-run'],
      resolvePackageRoot: resolveToPkg,
      fs,
      cwd: () => PROJECT,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    // File still present (dry-run never deletes).
    assert.equal(
      fs.files.has(staleFile),
      true,
      'dry-run must not delete the file',
    );
    assert.equal(fs.unlinked.length, 0);

    // Output mentions the would-prune line.
    const joined = cap.out.join('');
    assert.match(joined, /would prune/);
    assert.match(joined, /old\.md/);
    // Summary mentions 1 stale file.
    assert.match(joined, /1 stale file\(s\) would be pruned/);

    // result.pruned is 0 on dry-run (nothing actually deleted).
    assert.equal(result.pruned, 0);
    assert.equal(result.planned, 2);
  });

  it('does not report a local-zone file as would-be pruned', () => {
    const localFile = path.join(DEST_AGENTS, 'local', 'mine.md');
    const fs = makeFs({
      ...seedPayload(),
      [localFile]: '# mine\n',
    });
    const cap = makeCapture();

    runSync({
      argv: ['--dry-run'],
      resolvePackageRoot: resolveToPkg,
      fs,
      cwd: () => PROJECT,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    // The local zone file must NOT appear in the would-prune output.
    assert.doesNotMatch(cap.out.join(''), /mine\.md/);
  });
});

// ---------------------------------------------------------------------------
// AC5 — idempotency with prune pass
// ---------------------------------------------------------------------------

describe('runSync — idempotency with prune pass', () => {
  it('leaves the destination tree byte-identical after a second run', () => {
    const staleFile = path.join(DEST_AGENTS, 'workflows', 'old.md');
    const fs = makeFs({
      ...seedPayload(),
      [staleFile]: '# stale\n',
    });
    const opts = {
      argv: [],
      resolvePackageRoot: resolveToPkg,
      fs,
      cwd: () => PROJECT,
      write: () => {},
      writeErr: () => {},
      exit: () => {},
    };

    // First run: prunes the stale file.
    const r1 = runSync(opts);
    assert.equal(r1.pruned, 1);

    const destPrefix = DEST_AGENTS + path.sep;
    const snapshot = JSON.stringify(
      [...fs.files.entries()].filter(([k]) => k.startsWith(destPrefix)).sort(),
    );

    // Second run: nothing to prune.
    const r2 = runSync(opts);
    assert.equal(r2.pruned, 0);

    const after = JSON.stringify(
      [...fs.files.entries()].filter(([k]) => k.startsWith(destPrefix)).sort(),
    );

    assert.equal(
      after,
      snapshot,
      'tree must be byte-identical after second run',
    );
  });
});
