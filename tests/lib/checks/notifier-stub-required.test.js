/**
 * Unit tests for the notifier-stub-required check.
 *
 * The check scans a `tests/` tree for Notifier / NotificationHook
 * constructor calls that omit `cwd` and/or `fetchImpl`. Real test trees
 * are too noisy for assertion, so each case here writes its own fixture
 * tree under an OS tmpdir and points the check at it via
 * `state.scanRoot`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import check from '../../../.agents/scripts/lib/checks/notifier-stub-required.js';

/**
 * Make a fresh fixture root for one test case. Returns `{ root, write }`
 * where `write(relPath, contents)` drops a file inside the root,
 * creating any intermediate directories.
 */
function makeFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'notifier-stub-fixture-'));
  return {
    root,
    write(relPath, contents) {
      const full = path.join(root, relPath);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents, 'utf8');
    },
  };
}

let fixture;

describe('notifier-stub-required.detect', () => {
  beforeEach(() => {
    fixture = makeFixtureRoot();
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('returns null when every Notifier construction passes cwd + fetchImpl', () => {
    fixture.write(
      'a.test.js',
      [
        "import { Notifier } from '../src/notifier.js';",
        '',
        'it("posts a message", () => {',
        '  const n = new Notifier({ cwd: tmp, fetchImpl: fakeFetch });',
        '  n.notify("hi");',
        '});',
      ].join('\n'),
    );
    fixture.write(
      'nested/b.test.js',
      [
        'const hook = new NotificationHook({',
        '  cwd: workDir,',
        '  fetchImpl: stubFetch,',
        '  channel: "#ops",',
        '});',
      ].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.equal(finding, null);
  });

  it('returns a blocker finding for each test file constructing Notifier without cwd + fetchImpl', () => {
    fixture.write(
      'leaky.test.js',
      [
        "import { Notifier } from '../src/notifier.js';",
        '',
        'it("forgets the stubs", () => {',
        '  const n = new Notifier({ channel: "#alerts" });',
        '});',
      ].join('\n'),
    );
    fixture.write(
      'nested/partial.test.js',
      ['const hook = new NotificationHook({ cwd: workDir });'].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.ok(finding, 'expected a finding');
    assert.equal(finding.id, 'notifier-stub-required');
    assert.equal(finding.severity, 'blocker');
    assert.equal(finding.autoCorrectable, false);
    assert.ok(/leaky\.test\.js:/.test(finding.detail));
    assert.ok(/partial\.test\.js:/.test(finding.detail));
    // The fully-leaky construction lists both keys missing.
    assert.ok(/missing \{ cwd, fetchImpl \}/.test(finding.detail));
    // The partial one only misses fetchImpl.
    assert.ok(/missing \{ fetchImpl \}/.test(finding.detail));
  });

  it('emits a fixCommand showing the canonical stub pattern', () => {
    fixture.write('leaky.test.js', 'const n = new Notifier({});');
    const finding = check.detect({ scanRoot: fixture.root });
    assert.ok(finding);
    assert.match(finding.fixCommand, /cwd:/);
    assert.match(finding.fixCommand, /fetchImpl:/);
  });

  it('treats files without Notifier constructions as no-op (no walk cost surfaces as a finding)', () => {
    fixture.write(
      'unrelated.test.js',
      'it("does math", () => assert(1+1===2));',
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.equal(finding, null);
  });

  it('skips node_modules and .worktrees subdirectories during the scan', () => {
    fixture.write(
      'node_modules/pkg/dist/leaky.test.js',
      'const n = new Notifier({});',
    );
    fixture.write(
      '.worktrees/story-9999/tests/leaky.test.js',
      'const n = new Notifier({});',
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.equal(finding, null);
  });
});
