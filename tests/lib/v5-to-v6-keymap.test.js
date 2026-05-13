/**
 * v5-to-v6-keymap — data-only invariants on the rewrite table that drives
 * `migrate-to-v6.js`. The CLI itself is exercised in
 * [`tests/scripts/migrate-to-v6.test.js`](../scripts/migrate-to-v6.test.js);
 * this file pins the shape and coverage of the keymap as data.
 *
 * Acceptance (Task #1622):
 *   - Every removed/renamed key in the v5.x → v6.0 delta is present in the
 *     table.
 *   - Each entry has either a `to` target or an explicit `removedIn`
 *     deprecation note.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  keymapByFrom,
  V5_TO_V6_KEYMAP,
} from '../../.agents/scripts/lib/v5-to-v6-keymap.js';

describe('v5-to-v6-keymap — table shape invariants', () => {
  it('is a non-empty frozen array', () => {
    assert.ok(Array.isArray(V5_TO_V6_KEYMAP), 'expected array export');
    assert.ok(V5_TO_V6_KEYMAP.length > 0, 'expected at least one entry');
    assert.ok(
      Object.isFrozen(V5_TO_V6_KEYMAP),
      'table must be frozen so callers cannot mutate the shared module',
    );
  });

  it('every entry is itself frozen', () => {
    for (const entry of V5_TO_V6_KEYMAP) {
      assert.ok(
        Object.isFrozen(entry),
        `entry for ${entry.from} must be frozen`,
      );
    }
  });

  it('every entry has a non-empty `from` dot path', () => {
    for (const entry of V5_TO_V6_KEYMAP) {
      assert.equal(typeof entry.from, 'string', 'from must be a string');
      assert.ok(entry.from.length > 0, 'from must be non-empty');
      // Dot paths should not start or end with a dot, and should not
      // contain double dots — these are simple guardrails against the
      // most likely table-edit typos.
      assert.ok(
        !entry.from.startsWith('.'),
        `from must not start with '.': ${entry.from}`,
      );
      assert.ok(
        !entry.from.endsWith('.'),
        `from must not end with '.': ${entry.from}`,
      );
      assert.ok(
        !entry.from.includes('..'),
        `from must not contain '..': ${entry.from}`,
      );
    }
  });

  it('every entry has a non-empty single-sentence `note`', () => {
    for (const entry of V5_TO_V6_KEYMAP) {
      assert.equal(typeof entry.note, 'string', 'note must be a string');
      assert.ok(
        entry.note.length > 0,
        `note must be non-empty for ${entry.from}`,
      );
    }
  });

  it('every entry has either a `to` target or an explicit `removedIn` note (story AC)', () => {
    for (const entry of V5_TO_V6_KEYMAP) {
      const hasTo = typeof entry.to === 'string' && entry.to.length > 0;
      const hasRemovedIn =
        typeof entry.removedIn === 'string' && entry.removedIn.length > 0;
      assert.ok(
        hasTo || hasRemovedIn,
        `entry ${entry.from} must declare either a 'to' target or 'removedIn' (got to=${JSON.stringify(entry.to)}, removedIn=${JSON.stringify(entry.removedIn)})`,
      );
      if (!hasTo) {
        assert.equal(
          entry.to,
          null,
          `entry ${entry.from} with no 'to' must use null sentinel (got ${JSON.stringify(entry.to)})`,
        );
      }
    }
  });

  it('removedIn values look like semver tags', () => {
    for (const entry of V5_TO_V6_KEYMAP) {
      if (entry.removedIn === undefined) continue;
      assert.match(
        entry.removedIn,
        /^\d+\.\d+\.\d+$/u,
        `removedIn must look like X.Y.Z for ${entry.from} (got ${entry.removedIn})`,
      );
    }
  });

  it('no two entries share the same `from` path', () => {
    const seen = new Set();
    for (const entry of V5_TO_V6_KEYMAP) {
      assert.ok(
        !seen.has(entry.from),
        `duplicate 'from' path in keymap: ${entry.from}`,
      );
      seen.add(entry.from);
    }
  });
});

describe('v5-to-v6-keymap — content coverage (story AC: every v5→v6 delta present)', () => {
  // Anchor set — every key that the changelog says was renamed or removed
  // between v5.x and v6.0.0. Sourced from docs/CHANGELOG.md 5.31.0 and
  // 5.40.0 release notes. If a future cleanup introduces a new delta, this
  // anchor list and the table both grow together.
  const REQUIRED_KEYS = Object.freeze([
    'agentSettings.sprintClose.runRetro',
    'agentSettings.epicClose.runRetro',
    'agentSettings.riskGates.heuristics',
    'orchestration.hitl',
    'orchestration.executor',
    'orchestration.runners.epicRunner',
    'orchestration.runners.epicRunner.idleTimeoutSec',
    'orchestration.runners.epicRunner.pollIntervalSec',
    'orchestration.runners.epicRunner.logsDir',
    'orchestration.runners.closeRetry',
  ]);

  for (const key of REQUIRED_KEYS) {
    it(`includes a rewrite entry for ${key}`, () => {
      const found = V5_TO_V6_KEYMAP.some((entry) => entry.from === key);
      assert.ok(
        found,
        `expected v5→v6 keymap to include an entry for ${key}; ` +
          'see docs/CHANGELOG.md 5.31.0 + 5.40.0 release notes for provenance',
      );
    });
  }

  it('renames the runner block from epicRunner to deliverRunner', () => {
    const entry = V5_TO_V6_KEYMAP.find(
      (e) => e.from === 'orchestration.runners.epicRunner',
    );
    assert.ok(entry, 'expected runners.epicRunner entry');
    assert.equal(entry.to, 'orchestration.runners.deliverRunner');
  });

  it('renames closeRetry to storyMergeRetry', () => {
    const entry = V5_TO_V6_KEYMAP.find(
      (e) => e.from === 'orchestration.runners.closeRetry',
    );
    assert.ok(entry, 'expected runners.closeRetry entry');
    assert.equal(entry.to, 'orchestration.runners.storyMergeRetry');
  });

  it('renames riskGates.heuristics to planning.riskHeuristics', () => {
    const entry = V5_TO_V6_KEYMAP.find(
      (e) => e.from === 'agentSettings.riskGates.heuristics',
    );
    assert.ok(entry, 'expected riskGates.heuristics entry');
    assert.equal(entry.to, 'agentSettings.planning.riskHeuristics');
  });

  it('removes orchestration.hitl with no replacement', () => {
    const entry = V5_TO_V6_KEYMAP.find((e) => e.from === 'orchestration.hitl');
    assert.ok(entry);
    assert.equal(entry.to, null);
    assert.equal(typeof entry.removedIn, 'string');
  });

  it('removes orchestration.executor with no replacement', () => {
    const entry = V5_TO_V6_KEYMAP.find(
      (e) => e.from === 'orchestration.executor',
    );
    assert.ok(entry);
    assert.equal(entry.to, null);
    assert.equal(typeof entry.removedIn, 'string');
  });
});

describe('v5-to-v6-keymap — keymapByFrom accessor', () => {
  it('returns a Map keyed by the legacy `from` path', () => {
    const map = keymapByFrom();
    assert.ok(map instanceof Map);
    assert.equal(map.size, V5_TO_V6_KEYMAP.length);
    for (const entry of V5_TO_V6_KEYMAP) {
      assert.strictEqual(map.get(entry.from), entry);
    }
  });

  it('returns a fresh Map per call so mutation is isolated', () => {
    const a = keymapByFrom();
    const b = keymapByFrom();
    assert.notStrictEqual(a, b);
    a.delete('orchestration.hitl');
    // Mutating `a` must not leak into the next call's view.
    assert.ok(b.has('orchestration.hitl'));
  });
});

describe('v5-to-v6-keymap — against representative fixtures', () => {
  /**
   * Fixture A — a v5.39.x `.agentrc.json` shape that carries every
   * removed/renamed key. After applying the keymap, no legacy key should
   * survive in the consumer's config.
   */
  const v5Consumer = Object.freeze({
    agentSettings: {
      epicClose: { runRetro: false, skipDocsFreshness: true },
      riskGates: { heuristics: ['destructive-migration', 'auth-change'] },
      sprintClose: { runRetro: true },
    },
    orchestration: {
      provider: 'github',
      hitl: {},
      executor: 'manual',
      runners: {
        epicRunner: {
          enabled: true,
          concurrencyCap: 3,
          idleTimeoutSec: 900,
          pollIntervalSec: 5,
          logsDir: '.agents/runs',
        },
        closeRetry: { maxAttempts: 3, backoffMs: [250, 500, 1000] },
      },
    },
  });

  it("every legacy 'from' path in fixture A is matched by a keymap entry", () => {
    const legacyPaths = [
      'agentSettings.sprintClose.runRetro',
      'agentSettings.epicClose.runRetro',
      'agentSettings.riskGates.heuristics',
      'orchestration.hitl',
      'orchestration.executor',
      'orchestration.runners.epicRunner.idleTimeoutSec',
      'orchestration.runners.epicRunner.pollIntervalSec',
      'orchestration.runners.epicRunner.logsDir',
      'orchestration.runners.epicRunner',
      'orchestration.runners.closeRetry',
    ];
    const map = keymapByFrom();
    for (const path of legacyPaths) {
      assert.ok(
        map.has(path),
        `fixture-A path ${path} has no keymap entry; ` +
          'consumer would still carry the legacy key after migration',
      );
    }
    // Sanity: the fixture itself is intact and untouched by accessor reads.
    assert.equal(v5Consumer.orchestration.provider, 'github');
  });

  /**
   * Fixture B — an already-v6 consumer. None of its top-level keys should
   * appear as a `from` in the keymap (those are the *destinations*, not
   * legacy sources).
   */
  const v6Consumer = Object.freeze({
    agentSettings: {
      planning: { riskHeuristics: ['destructive-migration'] },
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
    },
    orchestration: {
      provider: 'github',
      runners: {
        deliverRunner: { enabled: true, concurrencyCap: 3 },
        storyMergeRetry: { maxAttempts: 3 },
      },
    },
  });

  it('no v6 destination key collides with a keymap `from`', () => {
    const map = keymapByFrom();
    const v6Paths = [
      'agentSettings.planning.riskHeuristics',
      'orchestration.runners.deliverRunner',
      'orchestration.runners.storyMergeRetry',
    ];
    for (const path of v6Paths) {
      assert.ok(
        !map.has(path),
        `v6 destination ${path} accidentally appears as a legacy 'from'; ` +
          'the migration would loop or no-op incorrectly',
      );
    }
    assert.equal(v6Consumer.orchestration.provider, 'github');
  });
});
