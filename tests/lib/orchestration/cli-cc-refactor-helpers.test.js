import assert from 'node:assert/strict';
import test from 'node:test';

import { formatDurationChunk } from '../../../.agents/scripts/lib/orchestration/lifecycle/trace-logger.js';
import {
  buildGateFailureError,
  lifecycleEmitsActive,
} from '../../../.agents/scripts/lib/orchestration/story-close/pre-merge-validation.js';

// Sibling unit tests for the pure helpers extracted while reducing the
// cyclomatic complexity of the CLI orchestration bodies (Story #4075).

test('formatDurationChunk', async (t) => {
  await t.test('returns (pending) when no terminal record', () => {
    assert.equal(
      formatDurationChunk({ ts: '2026-01-01T00:00:00Z' }),
      '(pending)',
    );
  });

  await t.test('formats the elapsed ms when terminal follows emit', () => {
    const emit = { ts: '2026-01-01T00:00:00.000Z' };
    const terminal = { ts: '2026-01-01T00:00:01.500Z' };
    assert.equal(formatDurationChunk(emit, terminal), '(1500ms)');
  });

  await t.test('returns empty string when terminal precedes emit', () => {
    const emit = { ts: '2026-01-01T00:00:05.000Z' };
    const terminal = { ts: '2026-01-01T00:00:00.000Z' };
    assert.equal(formatDurationChunk(emit, terminal), '');
  });

  await t.test('returns empty string when a timestamp is unparseable', () => {
    const emit = { ts: 'not-a-date' };
    const terminal = { ts: '2026-01-01T00:00:01.000Z' };
    assert.equal(formatDurationChunk(emit, terminal), '');
  });
});

test('lifecycleEmitsActive', async (t) => {
  const bus = { emit() {} };

  await t.test('true when both ids positive and bus present', () => {
    assert.equal(lifecycleEmitsActive({ epicId: 1, storyId: 2, bus }), true);
  });

  await t.test('false when storyId is null (legacy resume fixture)', () => {
    assert.equal(
      lifecycleEmitsActive({ epicId: 1, storyId: null, bus }),
      false,
    );
  });

  await t.test('false when epicId is non-positive', () => {
    assert.equal(lifecycleEmitsActive({ epicId: 0, storyId: 2, bus }), false);
  });

  await t.test('false when bus is absent', () => {
    assert.equal(
      lifecycleEmitsActive({ epicId: 1, storyId: 2, bus: undefined }),
      false,
    );
  });
});

test('buildGateFailureError', async (t) => {
  await t.test('stamps typed properties and the canonical message', () => {
    const err = buildGateFailureError({
      gate: { name: 'lint', hint: 'run npm run lint' },
      status: 2,
      gateCwd: '/work/tree',
    });
    assert.equal(err.code, 'PRE_MERGE_GATE_FAILED');
    assert.equal(err.gateName, 'lint');
    assert.equal(err.exitCode, 2);
    assert.equal(err.gateCwd, '/work/tree');
    assert.equal(
      err.message,
      'Pre-merge validation failed at "lint" (exit 2) in /work/tree. run npm run lint',
    );
  });

  await t.test('omits the cwd clause and hint when both absent', () => {
    const err = buildGateFailureError({
      gate: { name: 'test' },
      status: 1,
      gateCwd: null,
    });
    assert.equal(err.gateCwd, null);
    assert.equal(
      err.message,
      'Pre-merge validation failed at "test" (exit 1).',
    );
  });
});
