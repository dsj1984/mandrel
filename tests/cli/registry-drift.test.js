// tests/cli/registry-drift.test.js
/**
 * Unit tests for the `agents-drift` doctor check in lib/cli/registry.js.
 *
 * The check compares the consumer's materialized `./.agents/<f>` bytes against
 * the installed `@mandrelai/agents` package payload, excluding the
 * `.agents/local/` zone (Story #3498). Every branch is driven through
 * injectable seams (`cwd`, `fsImpl`, `resolvePackageRoot`) so no real
 * filesystem or package is touched — matching the seam style of the other
 * registry checks (see tests/cli/registry.test.js).
 *
 * Coverage contract (per AC):
 *   1. Compares ./.agents/ bytes to the package payload, excluding .agents/local/
 *   2. A hand-edited materialized file → ok:false naming the file + a remedy
 *      pointing at `mandrel sync` / the .agents/local/ zone
 *   3. The check logs only paths and counts — never file contents
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { registry } from '../../lib/cli/registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Locate the agents-drift check, failing fast if it is missing. */
function driftCheck() {
  const check = registry.find((c) => c.name === 'agents-drift');
  assert.ok(check, 'Expected an `agents-drift` check in the registry');
  return check;
}

/**
 * Assert the standard doctor result shape: `{ ok, detail, remedy? }`, with a
 * non-empty `remedy` whenever `ok` is false.
 *
 * @param {{ ok: unknown, detail: unknown, remedy?: unknown }} result
 * @param {{ expectOk?: boolean }} [opts]
 */
function assertResultShape(result, { expectOk } = {}) {
  assert.equal(typeof result.ok, 'boolean', 'result.ok must be boolean');
  assert.equal(typeof result.detail, 'string', 'result.detail must be string');
  assert.ok(result.detail.length > 0, 'result.detail must be non-empty');
  if (!result.ok) {
    assert.equal(
      typeof result.remedy,
      'string',
      'result.remedy must be a string when ok is false',
    );
    assert.ok(
      result.remedy.length > 0,
      'result.remedy must be non-empty when ok is false',
    );
  }
  if (expectOk !== undefined) {
    assert.equal(result.ok, expectOk, `Expected result.ok to be ${expectOk}`);
  }
}

/**
 * Build an in-memory fs seam from a `{ '<relPosixPath>': Buffer|string }` map.
 * Keys are relative to a root the test passes as `root`; entries describe both
 * the package-payload tree and the materialized tree under their own roots.
 *
 * The map's keys are absolute paths (already joined by the test). Directories
 * are inferred from the file paths.
 *
 * @param {Record<string, Buffer|string>} fileMap - absolute path → contents
 * @returns {{ existsSync: Function, readdirSync: Function, readFileSync: Function }}
 */
function makeFs(fileMap) {
  const files = new Map(
    Object.entries(fileMap).map(([k, v]) => [
      normalize(k),
      Buffer.isBuffer(v) ? v : Buffer.from(v),
    ]),
  );

  // Collect the set of directory paths implied by the file paths.
  const dirs = new Set();
  for (const filePath of files.keys()) {
    let dir = parentOf(filePath);
    while (dir && !dirs.has(dir)) {
      dirs.add(dir);
      dir = parentOf(dir);
    }
  }

  function existsSync(p) {
    const n = normalize(p);
    return files.has(n) || dirs.has(n);
  }

  function readdirSync(dir, opts) {
    const n = normalize(dir);
    const seen = new Map(); // childName → isDirectory
    const prefix = `${n}/`;
    for (const filePath of files.keys()) {
      if (filePath.startsWith(prefix)) {
        const remainder = filePath.slice(prefix.length);
        const slash = remainder.indexOf('/');
        if (slash === -1) {
          seen.set(remainder, false);
        } else {
          seen.set(remainder.slice(0, slash), true);
        }
      }
    }
    const names = [...seen.entries()];
    if (opts?.withFileTypes) {
      return names.map(([name, isDir]) => ({
        name,
        isDirectory: () => isDir,
        isFile: () => !isDir,
      }));
    }
    return names.map(([name]) => name);
  }

  function readFileSync(p) {
    const n = normalize(p);
    const buf = files.get(n);
    if (!buf) {
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    }
    return buf;
  }

  return { existsSync, readdirSync, readFileSync };
}

/** Normalize OS separators to POSIX for the in-memory map keys. */
function normalize(p) {
  return String(p).replace(/\\/g, '/');
}

/** Return the parent directory of a normalized path, or '' at the root. */
function parentOf(p) {
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '' : p.slice(0, idx);
}

const PKG_ROOT = '/fake/project/node_modules/@mandrelai/agents';
const PROJECT = '/fake/project';

// ---------------------------------------------------------------------------
// agents-drift
// ---------------------------------------------------------------------------

describe('agents-drift check', () => {
  it('returns ok=true when every materialized file matches the payload', () => {
    const fsImpl = makeFs({
      [`${PKG_ROOT}/.agents/instructions.md`]: 'hello',
      [`${PKG_ROOT}/.agents/rules/security.md`]: 'rule body',
      [`${PROJECT}/.agents/instructions.md`]: 'hello',
      [`${PROJECT}/.agents/rules/security.md`]: 'rule body',
    });
    const result = driftCheck().run({
      cwd: () => PROJECT,
      fsImpl,
      resolvePackageRoot: () => PKG_ROOT,
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /2 materialized file\(s\) match/);
  });

  it('returns ok=false naming the drifted file when a materialized file is hand-edited', () => {
    const fsImpl = makeFs({
      [`${PKG_ROOT}/.agents/instructions.md`]: 'canonical body',
      [`${PROJECT}/.agents/instructions.md`]: 'canonical body EDITED BY HAND',
    });
    const result = driftCheck().run({
      cwd: () => PROJECT,
      fsImpl,
      resolvePackageRoot: () => PKG_ROOT,
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.detail, /instructions\.md/);
    assert.match(result.detail, /differs/);
  });

  it('remedy points at `mandrel sync` and the .agents/local/ zone on drift', () => {
    const fsImpl = makeFs({
      [`${PKG_ROOT}/.agents/instructions.md`]: 'a',
      [`${PROJECT}/.agents/instructions.md`]: 'b',
    });
    const result = driftCheck().run({
      cwd: () => PROJECT,
      fsImpl,
      resolvePackageRoot: () => PKG_ROOT,
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /mandrel sync/);
    assert.match(result.remedy, /\.agents\/local\//);
  });

  it('excludes the .agents/local/ zone from the drift comparison', () => {
    // The local zone has no payload counterpart and arbitrary local content.
    // It must NOT be reported as drift.
    const fsImpl = makeFs({
      [`${PKG_ROOT}/.agents/instructions.md`]: 'same',
      [`${PROJECT}/.agents/instructions.md`]: 'same',
      [`${PROJECT}/.agents/local/my-notes.md`]: 'consumer-authored content',
    });
    const result = driftCheck().run({
      cwd: () => PROJECT,
      fsImpl,
      resolvePackageRoot: () => PKG_ROOT,
    });
    assertResultShape(result, { expectOk: true });
  });

  it('does not enumerate a top-level local/ dir even if the payload ships one', () => {
    // A future payload accidentally ships .agents/local/x; the destination
    // has a different x. Because the local zone is skipped during source
    // enumeration, this must not surface as drift.
    const fsImpl = makeFs({
      [`${PKG_ROOT}/.agents/instructions.md`]: 'same',
      [`${PKG_ROOT}/.agents/local/x.md`]: 'payload-shipped-local',
      [`${PROJECT}/.agents/instructions.md`]: 'same',
      [`${PROJECT}/.agents/local/x.md`]: 'consumer-edited-local',
    });
    const result = driftCheck().run({
      cwd: () => PROJECT,
      fsImpl,
      resolvePackageRoot: () => PKG_ROOT,
    });
    assertResultShape(result, { expectOk: true });
  });

  it('returns ok=false when a payload file is missing from ./.agents/', () => {
    const fsImpl = makeFs({
      [`${PKG_ROOT}/.agents/instructions.md`]: 'body',
      [`${PKG_ROOT}/.agents/rules/security.md`]: 'rule',
      // instructions.md present; rules/security.md absent in destination.
      [`${PROJECT}/.agents/instructions.md`]: 'body',
    });
    const result = driftCheck().run({
      cwd: () => PROJECT,
      fsImpl,
      resolvePackageRoot: () => PKG_ROOT,
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.detail, /security\.md/);
    assert.match(result.detail, /missing/);
    assert.match(result.remedy, /mandrel sync/);
  });

  it('is a no-op success when @mandrelai/agents is not installed', () => {
    const fsImpl = makeFs({
      [`${PROJECT}/.agents/instructions.md`]: 'body',
    });
    const result = driftCheck().run({
      cwd: () => PROJECT,
      fsImpl,
      resolvePackageRoot: () => {
        throw Object.assign(new Error('Cannot find module'), {
          code: 'MODULE_NOT_FOUND',
        });
      },
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /not installed/);
  });

  it('is a no-op success when the package ships no .agents/ payload', () => {
    const fsImpl = makeFs({
      [`${PROJECT}/.agents/instructions.md`]: 'body',
    });
    const result = driftCheck().run({
      cwd: () => PROJECT,
      fsImpl,
      resolvePackageRoot: () => PKG_ROOT, // PKG_ROOT/.agents does not exist in the map
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /no .agents\/ payload/);
  });

  it('is a no-op success when ./.agents/ is not materialized', () => {
    const fsImpl = makeFs({
      [`${PKG_ROOT}/.agents/instructions.md`]: 'body',
    });
    const result = driftCheck().run({
      cwd: () => PROJECT,
      fsImpl,
      resolvePackageRoot: () => PKG_ROOT,
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /not materialized/);
  });

  it('never echoes file contents in detail or remedy', () => {
    const secret = 'SENSITIVE-LOCAL-EDIT-CONTENT-12345';
    const fsImpl = makeFs({
      [`${PKG_ROOT}/.agents/instructions.md`]: 'canonical',
      [`${PROJECT}/.agents/instructions.md`]: secret,
    });
    const result = driftCheck().run({
      cwd: () => PROJECT,
      fsImpl,
      resolvePackageRoot: () => PKG_ROOT,
    });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.detail, new RegExp(secret));
    assert.doesNotMatch(result.detail, /\n/);
    if (result.remedy) {
      assert.doesNotMatch(result.remedy, new RegExp(secret));
    }
  });
});
