// lib/cli/__tests__/sync.test.js
/**
 * Unit tests for lib/cli/sync.js — the `mandrel sync` materializer.
 *
 * Every test drives runSync through injectable seams (resolvePackageRoot,
 * fs, cwd, write, writeErr, exit) backed by an in-memory filesystem fake,
 * so no real package resolution and no real disk I/O occur (testing-standards
 * § Unit: all filesystem I/O MUST be mocked).
 *
 * Coverage contract (per Story #3467 AC):
 *   1. Copies the package .agents/ tree into ./.agents/ as plain files
 *      (no symlinks created — symlinkSync is never called).
 *   2. Re-running is idempotent — a second run leaves ./.agents/
 *      byte-identical.
 *   3. Exits non-zero with an actionable message when @mandrel/agents is
 *      not resolvable in node_modules.
 *   4. --dry-run reports planned copies and writes nothing.
 *   5. Module shape: runSync named export + default function export.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import sync, { runSync } from '../sync.js';

// ---------------------------------------------------------------------------
// In-memory filesystem fake
// ---------------------------------------------------------------------------

/**
 * Build an in-memory fs whose `seed` maps absolute file paths → contents.
 * Directories are inferred from the seeded file paths.
 *
 * Tracks writes (copyFileSync) and guards against symlink creation so tests
 * can prove the materializer never produces symlinks.
 */
function makeFs(seed = {}) {
  // Live store: absolute path → contents. Seeded entries plus anything the
  // code under test writes via copyFileSync.
  const files = new Map(Object.entries(seed));
  const symlinkCalls = [];

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
    symlinkCalls,
    readdirSync(dir, _opts) {
      return dirEntries(dir);
    },
    existsSync(p) {
      const norm = p.endsWith(path.sep) ? p.slice(0, -1) : p;
      if (files.has(norm)) return true;
      // A directory "exists" if any seeded file lives under it.
      for (const abs of files.keys()) {
        if (abs.startsWith(norm + path.sep)) return true;
      }
      return false;
    },
    mkdirSync(_dir, _opts) {
      // No-op: directories are implied by file paths in this fake.
    },
    copyFileSync(src, dest) {
      if (!files.has(src)) {
        throw new Error(`copyFileSync: source missing ${src}`);
      }
      files.set(dest, files.get(src));
    },
    symlinkSync(target, p) {
      symlinkCalls.push({ target, path: p });
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
const PKG_ROOT = path.join(PROJECT, 'node_modules', '@mandrel', 'agents');

/** Seed a package payload of two files under <pkg>/.agents/. */
function seedPackagePayload() {
  const agentsDir = path.join(PKG_ROOT, '.agents');
  return {
    [path.join(agentsDir, 'instructions.md')]: '# instructions\n',
    [path.join(agentsDir, 'rules', 'security-baseline.md')]: '# security\n',
  };
}

const resolveToPkg = () => PKG_ROOT;

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('sync module exports', () => {
  it('exports runSync as a named export', () => {
    assert.equal(typeof runSync, 'function');
  });

  it('exports a default function for bin/mandrel.js dispatch', () => {
    assert.equal(typeof sync, 'function');
  });
});

// ---------------------------------------------------------------------------
// AC1 — copies the tree as plain files, no symlinks
// ---------------------------------------------------------------------------

describe('runSync — copies .agents/ payload as plain files', () => {
  it('copies every package file into ./.agents/', () => {
    const fs = makeFs(seedPackagePayload());
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

    const destInstr = path.join(PROJECT, '.agents', 'instructions.md');
    const destRule = path.join(
      PROJECT,
      '.agents',
      'rules',
      'security-baseline.md',
    );
    assert.equal(fs.files.get(destInstr), '# instructions\n');
    assert.equal(fs.files.get(destRule), '# security\n');
    assert.equal(result.copied, 2);
    assert.equal(cap.exitCode, null);
  });

  it('never creates a symlink', () => {
    const fs = makeFs(seedPackagePayload());
    const cap = makeCapture();
    runSync({
      argv: [],
      resolvePackageRoot: resolveToPkg,
      fs,
      cwd: () => PROJECT,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });
    assert.equal(fs.symlinkCalls.length, 0);
  });

  it('reports the materialized file count on stdout', () => {
    const fs = makeFs(seedPackagePayload());
    const cap = makeCapture();
    runSync({
      argv: [],
      resolvePackageRoot: resolveToPkg,
      fs,
      cwd: () => PROJECT,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });
    assert.match(cap.out.join(''), /Materialized 2 file\(s\)/);
  });
});

// ---------------------------------------------------------------------------
// AC2 — idempotency
// ---------------------------------------------------------------------------

describe('runSync — idempotent re-run', () => {
  it('leaves ./.agents/ byte-identical after a second run', () => {
    const fs = makeFs(seedPackagePayload());
    const opts = {
      argv: [],
      resolvePackageRoot: resolveToPkg,
      fs,
      cwd: () => PROJECT,
      write: () => {},
      writeErr: () => {},
      exit: () => {},
    };

    runSync(opts);
    // Snapshot the destination tree after the first run.
    const destPrefix = path.join(PROJECT, '.agents') + path.sep;
    const snapshot = JSON.stringify(
      [...fs.files.entries()].filter(([k]) => k.startsWith(destPrefix)).sort(),
    );

    runSync(opts);
    const after = JSON.stringify(
      [...fs.files.entries()].filter(([k]) => k.startsWith(destPrefix)).sort(),
    );

    assert.equal(after, snapshot);
  });
});

// ---------------------------------------------------------------------------
// AC3 — missing package → non-zero exit with actionable message
// ---------------------------------------------------------------------------

describe('runSync — @mandrel/agents not resolvable', () => {
  function resolveThrows() {
    const err = new Error("Cannot find module '@mandrel/agents/package.json'");
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }

  it('exits non-zero', () => {
    const fs = makeFs();
    const cap = makeCapture();
    runSync({
      argv: [],
      resolvePackageRoot: resolveThrows,
      fs,
      cwd: () => PROJECT,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });
    assert.equal(cap.exitCode, 1);
  });

  it('emits an actionable message naming the package and install command', () => {
    const fs = makeFs();
    const cap = makeCapture();
    runSync({
      argv: [],
      resolvePackageRoot: resolveThrows,
      fs,
      cwd: () => PROJECT,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });
    const joined = cap.err.join('');
    assert.match(joined, /@mandrel\/agents/);
    assert.match(joined, /npm install @mandrel\/agents/);
  });

  it('writes nothing to the destination', () => {
    const fs = makeFs();
    const cap = makeCapture();
    runSync({
      argv: [],
      resolvePackageRoot: resolveThrows,
      fs,
      cwd: () => PROJECT,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });
    assert.equal(fs.files.size, 0);
  });
});

// ---------------------------------------------------------------------------
// AC3b — package resolvable but ships no .agents/ payload
// ---------------------------------------------------------------------------

describe('runSync — package present but no .agents/ payload', () => {
  it('exits non-zero with an actionable message', () => {
    // Seed a package whose only file is its package.json (no .agents/ tree).
    const fs = makeFs({
      [path.join(PKG_ROOT, 'package.json')]: '{}',
    });
    const cap = makeCapture();
    runSync({
      argv: [],
      resolvePackageRoot: resolveToPkg,
      fs,
      cwd: () => PROJECT,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });
    assert.equal(cap.exitCode, 1);
    assert.match(cap.err.join(''), /no .agents\/ payload/);
  });
});

// ---------------------------------------------------------------------------
// AC4 — --dry-run reports planned copies, writes nothing
// ---------------------------------------------------------------------------

describe('runSync — --dry-run', () => {
  it('writes nothing to the destination', () => {
    const fs = makeFs(seedPackagePayload());
    const cap = makeCapture();
    const before = fs.files.size;
    runSync({
      argv: ['--dry-run'],
      resolvePackageRoot: resolveToPkg,
      fs,
      cwd: () => PROJECT,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });
    // No new files written: store size is unchanged from the seed.
    assert.equal(fs.files.size, before);
  });

  it('reports the planned copies and a dry-run summary', () => {
    const fs = makeFs(seedPackagePayload());
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
    const joined = cap.out.join('');
    assert.match(joined, /would copy/);
    assert.match(joined, /instructions\.md/);
    assert.match(joined, /Dry run: 2 file\(s\)/);
    assert.equal(result.planned, 2);
    assert.equal(result.copied, 0);
  });

  it('does not call exit on the dry-run happy path', () => {
    const fs = makeFs(seedPackagePayload());
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
    assert.equal(cap.exitCode, null);
  });
});
