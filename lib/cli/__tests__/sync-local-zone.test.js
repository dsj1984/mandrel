// lib/cli/__tests__/sync-local-zone.test.js
/**
 * Unit tests for the `.agents/local/` sync-exempt local-additions zone
 * (Story #3498, f-drift-local-zone).
 *
 * Contract under test (Story #3498 AC):
 *   1. runSync skips any path under `.agents/local/` when copying the
 *      package payload — proven by pre-populating a consumer-authored
 *      `.agents/local/custom.md` in the destination via an injected fs
 *      seam and asserting it is left byte-identical after a sync.
 *   2. `mandrel sync` writes no file into `.agents/local/` from the package
 *      payload — proven by seeding a (hypothetical) payload file under the
 *      source `.agents/local/` and asserting it is never enumerated, never
 *      copied, and never appears in the dry-run plan.
 *
 * Every test drives runSync through the same injectable seams used by
 * sync.test.js (resolvePackageRoot, fs, cwd, write, writeErr, exit) backed
 * by an in-memory filesystem fake, so no real package resolution and no
 * real disk I/O occur (testing-standards § Unit: all filesystem I/O MUST
 * be mocked; sync.js injectable-seam style — no real child processes).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { runSync } from '../sync.js';

// ---------------------------------------------------------------------------
// In-memory filesystem fake (mirrors sync.test.js)
// ---------------------------------------------------------------------------

/**
 * Build an in-memory fs whose `seed` maps absolute file paths → contents.
 * Directories are inferred from the seeded file paths.
 *
 * Tracks writes (copyFileSync) and guards against symlink creation.
 */
function makeFs(seed = {}) {
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
const PKG_ROOT = path.join(PROJECT, 'node_modules', '@mandrelai', 'agents');
const SRC_AGENTS = path.join(PKG_ROOT, '.agents');
const resolveToPkg = () => PKG_ROOT;

/** Seed a normal package payload of two non-local files under <pkg>/.agents/. */
function seedPackagePayload() {
  return {
    [path.join(SRC_AGENTS, 'instructions.md')]: '# instructions\n',
    [path.join(SRC_AGENTS, 'rules', 'security-baseline.md')]: '# security\n',
  };
}

const baseOpts = (fs, cap) => ({
  argv: [],
  resolvePackageRoot: resolveToPkg,
  fs,
  cwd: () => PROJECT,
  write: cap.write,
  writeErr: cap.writeErr,
  exit: cap.exit,
});

// ---------------------------------------------------------------------------
// AC1 — pre-existing consumer .agents/local/ additions survive sync
// ---------------------------------------------------------------------------

describe('runSync — .agents/local/ consumer additions survive', () => {
  it('leaves a pre-existing .agents/local/custom.md untouched', () => {
    // Arrange: a normal payload plus a consumer-authored file already living
    // in the destination's local zone.
    const localAddition = path.join(PROJECT, '.agents', 'local', 'custom.md');
    const fs = makeFs({
      ...seedPackagePayload(),
      [localAddition]: '# my custom local note\n',
    });
    const cap = makeCapture();

    // Act
    const result = runSync(baseOpts(fs, cap));

    // Assert: the local addition is byte-identical and the regular payload
    // still materialized.
    assert.equal(fs.files.get(localAddition), '# my custom local note\n');
    assert.equal(
      fs.files.get(path.join(PROJECT, '.agents', 'instructions.md')),
      '# instructions\n',
    );
    assert.equal(result.copied, 2);
    assert.equal(cap.exitCode, null);
  });

  it('never writes into the destination .agents/local/ subtree', () => {
    const localAddition = path.join(PROJECT, '.agents', 'local', 'custom.md');
    const fs = makeFs({
      ...seedPackagePayload(),
      [localAddition]: '# my custom local note\n',
    });
    const cap = makeCapture();

    runSync(baseOpts(fs, cap));

    // The only destination file under .agents/local/ is the one the consumer
    // authored; sync added nothing there.
    const localPrefix = path.join(PROJECT, '.agents', 'local') + path.sep;
    const localDestFiles = [...fs.files.keys()].filter((k) =>
      k.startsWith(localPrefix),
    );
    assert.deepEqual(localDestFiles, [localAddition]);
  });
});

// ---------------------------------------------------------------------------
// AC2 — a payload file under .agents/local/ is never materialized
// ---------------------------------------------------------------------------

describe('runSync — payload .agents/local/ is skipped on copy', () => {
  it('does not copy a source .agents/local/ file into the destination', () => {
    // Arrange: a payload that (hypothetically) ships a file under local/.
    // The published payload ships none, but the skip must hold defensively.
    const srcLocal = path.join(SRC_AGENTS, 'local', 'should-not-copy.md');
    const fs = makeFs({
      ...seedPackagePayload(),
      [srcLocal]: '# payload local file\n',
    });
    const cap = makeCapture();

    // Act
    const result = runSync(baseOpts(fs, cap));

    // Assert: the local payload file was never copied to the destination.
    const destLocal = path.join(
      PROJECT,
      '.agents',
      'local',
      'should-not-copy.md',
    );
    assert.equal(fs.files.has(destLocal), false);
    // Only the two non-local payload files were materialized.
    assert.equal(result.copied, 2);
  });

  it('omits .agents/local/ paths from the --dry-run plan', () => {
    const srcLocal = path.join(SRC_AGENTS, 'local', 'should-not-copy.md');
    const fs = makeFs({
      ...seedPackagePayload(),
      [srcLocal]: '# payload local file\n',
    });
    const cap = makeCapture();

    const result = runSync({ ...baseOpts(fs, cap), argv: ['--dry-run'] });

    const joined = cap.out.join('');
    assert.doesNotMatch(joined, /local/);
    assert.match(joined, /Dry run: 2 file\(s\)/);
    assert.equal(result.planned, 2);
  });

  it('still materializes a deeper non-top-level directory named local', () => {
    // The skip is scoped to the top-level .agents/local/ only — a nested
    // rules/local/ must still copy.
    const nestedLocal = path.join(SRC_AGENTS, 'rules', 'local', 'note.md');
    const fs = makeFs({
      ...seedPackagePayload(),
      [nestedLocal]: '# nested local note\n',
    });
    const cap = makeCapture();

    const result = runSync(baseOpts(fs, cap));

    const destNested = path.join(
      PROJECT,
      '.agents',
      'rules',
      'local',
      'note.md',
    );
    assert.equal(fs.files.get(destNested), '# nested local note\n');
    assert.equal(result.copied, 3);
  });
});
