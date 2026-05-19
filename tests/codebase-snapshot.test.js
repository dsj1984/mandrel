import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildCodebaseSnapshot,
  CODEBASE_SNAPSHOT_TIERS,
  resolveSnapshotConfig,
} from '../.agents/scripts/lib/codebase-snapshot.js';

/**
 * Story #2634 — codebase snapshot.
 *
 * The skinny tier is the Phase 7 default; the medium tier is opt-in via
 * `.agentrc.json#planning.codebaseSnapshot.tier`. The token-budget AC
 * asserts the skinny snapshot of *this* repo stays under 6k tokens —
 * the rough threshold beyond which the snapshot stops being a cheap
 * spec-author input.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function approxTokens(snapshotJson) {
  // The OpenAI / Anthropic family approximates 4 chars/token on
  // English-ish text. We use the same shortcut here so the test is
  // deterministic without pulling a tokenizer dep.
  return Math.ceil(snapshotJson.length / 4);
}

describe('resolveSnapshotConfig — defaults', () => {
  it('defaults to skinny tier with non-empty include/exclude globs', () => {
    const cfg = resolveSnapshotConfig(undefined);
    assert.equal(cfg.tier, 'skinny');
    assert.ok(cfg.include.length > 0);
    assert.ok(cfg.exclude.length > 0);
    assert.equal(cfg.recentCommitWindow, 30);
  });

  it('passes through valid tier overrides', () => {
    const cfg = resolveSnapshotConfig({ tier: 'medium' });
    assert.equal(cfg.tier, 'medium');
  });

  it('falls back to skinny when tier is not in the enum', () => {
    const cfg = resolveSnapshotConfig({ tier: 'fat' });
    assert.equal(cfg.tier, 'skinny');
  });

  it('exposes the canonical tier enum', () => {
    assert.deepEqual([...CODEBASE_SNAPSHOT_TIERS], ['skinny', 'medium']);
  });
});

describe('buildCodebaseSnapshot — skinny tier (this repo)', () => {
  const snapshot = buildCodebaseSnapshot({ cwd: REPO_ROOT });

  it('returns the skinny envelope shape', () => {
    assert.equal(snapshot.tier, 'skinny');
    assert.ok(Array.isArray(snapshot.files));
    assert.ok(snapshot.files.length > 0);
    assert.equal(snapshot.signatures, null);
    assert.ok(snapshot.pkg.name === 'mandrel');
    assert.ok(Array.isArray(snapshot.pkg.scripts));
    assert.ok(snapshot.pkg.scripts.includes('test'));
  });

  it('includes the orchestration scripts but excludes node_modules and tests', () => {
    const joined = snapshot.files.join('\n');
    assert.match(joined, /\.agents\/scripts\//);
    assert.doesNotMatch(joined, /node_modules\//);
    assert.doesNotMatch(joined, /\.test\.js$/m);
  });

  it('detects npm test as the runner', () => {
    assert.equal(snapshot.testSurface.runner, 'npm test');
  });

  it('stays under the 6k token budget on Mandrel', () => {
    const tokens = approxTokens(JSON.stringify(snapshot));
    assert.ok(
      tokens < 6000,
      `skinny snapshot exceeded budget: ${tokens} tokens (cap 6000)`,
    );
  });
});

describe('buildCodebaseSnapshot — medium tier exercises signatures', () => {
  // The medium tier is only exercised against a small fixture so the
  // full-repo signature collection doesn't dominate test runtime.
  let fixture;

  function setup() {
    fixture = mkdtempSync(path.join(tmpdir(), 'snapshot-fixture-'));
    mkdirSync(path.join(fixture, 'src'), { recursive: true });
    writeFileSync(
      path.join(fixture, 'package.json'),
      JSON.stringify({ name: 'fix', scripts: { test: 'node --test' } }),
    );
    writeFileSync(
      path.join(fixture, 'src/exports-various.js'),
      [
        'export function alpha() { return 1; }',
        'export class Beta {}',
        'export const gamma = 2;',
        'export default function delta() {}',
      ].join('\n'),
    );
  }

  function teardown() {
    rmSync(fixture, { recursive: true, force: true });
  }

  it('emits a non-null signatures array at medium tier', () => {
    setup();
    try {
      const snapshot = buildCodebaseSnapshot({
        cwd: fixture,
        tier: 'medium',
        include: ['src/**'],
        exclude: [],
      });
      assert.equal(snapshot.tier, 'medium');
      // The fixture isn't a git repo, so `files` is empty (git ls-files
      // returns nothing). The medium tier still emits `signatures` as
      // an array — empty — proving the field is present and the helper
      // does not throw on an empty file list.
      assert.ok(Array.isArray(snapshot.signatures));
    } finally {
      teardown();
    }
  });

  it('extracts export names from a file body when the file is tracked', () => {
    // Use an in-repo file that is already tracked by git so `git ls-files`
    // returns it. Logger.js is a stable, long-lived module with several
    // exports — pin against its shape.
    const snapshot = buildCodebaseSnapshot({
      cwd: REPO_ROOT,
      tier: 'medium',
      include: ['.agents/scripts/lib/Logger.js'],
      exclude: [],
    });
    assert.equal(snapshot.tier, 'medium');
    assert.ok(Array.isArray(snapshot.signatures));
    const entry = snapshot.signatures.find(
      (s) => s.path === '.agents/scripts/lib/Logger.js',
    );
    assert.ok(entry, 'expected snapshot to include Logger.js');
    // Logger.js exports both a default Logger and named utility helpers;
    // assert against any one stable name without overcommitting to a list.
    assert.ok(
      entry.exports.length > 0,
      `expected Logger.js to expose at least one export, got ${entry.exports.join(',')}`,
    );
  });
});

describe('buildCodebaseSnapshot — robustness', () => {
  it('returns a usable envelope even when cwd is not a git repo', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'snapshot-nongit-'));
    try {
      const snapshot = buildCodebaseSnapshot({ cwd: fixture });
      assert.equal(snapshot.tier, 'skinny');
      assert.deepEqual(snapshot.files, []);
      assert.deepEqual(snapshot.recentlyTouched, []);
      assert.deepEqual(snapshot.testSurface.featureRoots, []);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
