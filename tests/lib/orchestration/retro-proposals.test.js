/**
 * Unit tests for `composeRoutedProposals` (Story #2558, Epic #2547).
 *
 * Coverage:
 *   - Empty/invalid input → empty arrays.
 *   - >=2 occurrences ⇒ actionable; ==1 ⇒ discarded.
 *   - Source routing follows the dominant `source` tag.
 *   - Memory section is a free-text instruction list (not frontmatter).
 *   - Memorable single-occurrence categories are NOT discarded.
 *   - Unresolved agent::blocked events force actionable even with < 2 occurrences.
 *   - Deterministic ordering (sorted by category).
 *   - Pre-drafted `gh issue create` command shape includes `--repo`,
 *     `--label`, and `--body-file - <<EOF` heredoc.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { composeRoutedProposals } from '../../../.agents/scripts/lib/orchestration/retro-proposals.js';

const FRAMEWORK_REPO = 'dsj1984/mandrel';
const CONSUMER_REPO = 'dsj1984/domio';

function baseInput(overrides = {}) {
  return {
    epicId: 2547,
    frameworkRepo: FRAMEWORK_REPO,
    consumerRepo: CONSUMER_REPO,
    signals: [],
    unresolvedBlockedEvents: [],
    memorablePatterns: [],
    ...overrides,
  };
}

test('composeRoutedProposals: returns empty arrays for empty input', () => {
  const out = composeRoutedProposals(baseInput());
  assert.deepEqual(out, {
    framework: [],
    consumer: [],
    memory: [],
    discarded: [],
  });
});

test('composeRoutedProposals: returns empty arrays for null/undefined/invalid input', () => {
  assert.deepEqual(composeRoutedProposals(null), {
    framework: [],
    consumer: [],
    memory: [],
    discarded: [],
  });
  assert.deepEqual(composeRoutedProposals(undefined), {
    framework: [],
    consumer: [],
    memory: [],
    discarded: [],
  });
  // Missing epicId
  assert.deepEqual(
    composeRoutedProposals({
      frameworkRepo: 'a/b',
      consumerRepo: 'c/d',
    }),
    { framework: [], consumer: [], memory: [], discarded: [] },
  );
  // Missing repos
  assert.deepEqual(composeRoutedProposals({ epicId: 1 }), {
    framework: [],
    consumer: [],
    memory: [],
    discarded: [],
  });
});

test('composeRoutedProposals: >=2 occurrences become actionable; ==1 discarded', () => {
  const out = composeRoutedProposals(
    baseInput({
      signals: [
        { category: 'lint-loop', source: 'framework' },
        { category: 'lint-loop', source: 'framework' },
        { category: 'lint-loop', source: 'framework' },
        { category: 'flaky-deploy', source: 'consumer' },
      ],
    }),
  );
  assert.equal(out.framework.length, 1);
  assert.equal(out.framework[0].category, 'lint-loop');
  assert.equal(out.framework[0].occurrences, 3);
  assert.equal(out.consumer.length, 0);
  assert.equal(out.discarded.length, 1);
  assert.equal(out.discarded[0].category, 'flaky-deploy');
  assert.equal(out.discarded[0].occurrences, 1);
});

test('composeRoutedProposals: routes by dominant source tag', () => {
  const out = composeRoutedProposals(
    baseInput({
      signals: [
        // 2× framework, 1× consumer ⇒ framework dominant
        { category: 'mixed', source: 'framework' },
        { category: 'mixed', source: 'framework' },
        { category: 'mixed', source: 'consumer' },
        // 3× consumer ⇒ consumer dominant
        { category: 'consumer-only', source: 'consumer' },
        { category: 'consumer-only', source: 'consumer' },
        { category: 'consumer-only', source: 'consumer' },
      ],
    }),
  );
  assert.equal(out.framework.length, 1);
  assert.equal(out.framework[0].category, 'mixed');
  assert.equal(out.consumer.length, 1);
  assert.equal(out.consumer[0].category, 'consumer-only');
});

test('composeRoutedProposals: source tie resolves to first-seen source deterministically', () => {
  const a = composeRoutedProposals(
    baseInput({
      signals: [
        { category: 'tie', source: 'consumer' },
        { category: 'tie', source: 'framework' },
      ],
    }),
  );
  assert.equal(a.consumer.length, 1, 'first-seen consumer wins tie');
  assert.equal(a.framework.length, 0);

  const b = composeRoutedProposals(
    baseInput({
      signals: [
        { category: 'tie', source: 'framework' },
        { category: 'tie', source: 'consumer' },
      ],
    }),
  );
  assert.equal(b.framework.length, 1, 'first-seen framework wins tie');
  assert.equal(b.consumer.length, 0);
});

test('composeRoutedProposals: memory section is plain insight lines, not frontmatter', () => {
  const out = composeRoutedProposals(
    baseInput({
      memorablePatterns: [
        {
          category: 'pwsh-and',
          insight: 'PowerShell does not support && — use ; instead.',
        },
        {
          category: 'worktree-symlink',
          insight: 'Worktree node_modules can symlink on Windows when ADMIN-enabled.',
        },
      ],
    }),
  );
  assert.equal(out.memory.length, 2);
  // Sorted alphabetically by category for deterministic rendering.
  assert.equal(out.memory[0].category, 'pwsh-and');
  assert.equal(out.memory[1].category, 'worktree-symlink');
  // Insight is plain prose — no YAML / frontmatter markers.
  for (const m of out.memory) {
    assert.equal(m.insight.startsWith('---'), false);
    assert.equal(m.insight.includes('frontmatter'), false);
  }
});

test('composeRoutedProposals: memorable single-occurrence categories do not get discarded', () => {
  const out = composeRoutedProposals(
    baseInput({
      signals: [{ category: 'edge-case', source: 'consumer' }],
      memorablePatterns: [
        { category: 'edge-case', insight: 'Watch for this edge case next sprint.' },
      ],
    }),
  );
  assert.equal(out.discarded.length, 0, 'memorable category is not discarded');
  assert.equal(out.memory.length, 1);
  assert.equal(out.framework.length, 0);
  assert.equal(out.consumer.length, 0);
});

test('composeRoutedProposals: unresolved agent::blocked forces actionable even with <2 occurrences', () => {
  const out = composeRoutedProposals(
    baseInput({
      signals: [{ category: 'auth-regress', source: 'consumer' }],
      unresolvedBlockedEvents: [
        {
          ticketId: 9999,
          source: 'consumer',
          category: 'auth-regress',
          summary: 'Login broken at story close',
        },
      ],
    }),
  );
  assert.equal(out.consumer.length, 1);
  assert.equal(out.consumer[0].category, 'auth-regress');
  assert.equal(out.discarded.length, 0);
});

test('composeRoutedProposals: blocked event with no friction signal still produces an actionable', () => {
  const out = composeRoutedProposals(
    baseInput({
      unresolvedBlockedEvents: [
        {
          ticketId: 9999,
          source: 'framework',
          category: 'dispatch-stuck',
        },
      ],
    }),
  );
  assert.equal(out.framework.length, 1);
  assert.equal(out.framework[0].category, 'dispatch-stuck');
  assert.equal(out.framework[0].occurrences, 0);
});

test('composeRoutedProposals: deterministic ordering — output sorted by category', () => {
  const out = composeRoutedProposals(
    baseInput({
      signals: [
        { category: 'zeta', source: 'framework' },
        { category: 'zeta', source: 'framework' },
        { category: 'alpha', source: 'framework' },
        { category: 'alpha', source: 'framework' },
        { category: 'mid', source: 'consumer' },
        { category: 'mid', source: 'consumer' },
      ],
    }),
  );
  assert.deepEqual(
    out.framework.map((i) => i.category),
    ['alpha', 'zeta'],
  );
  assert.deepEqual(
    out.consumer.map((i) => i.category),
    ['mid'],
  );
});

test('composeRoutedProposals: gh issue create command shape is correct', () => {
  const out = composeRoutedProposals(
    baseInput({
      signals: [
        { category: 'lint-loop', source: 'framework' },
        { category: 'lint-loop', source: 'framework' },
      ],
    }),
  );
  const cmd = out.framework[0].command;
  assert.match(cmd, /gh issue create --repo dsj1984\/mandrel/);
  assert.match(cmd, /--title "Friction: lint-loop recurred 2 times in Epic #2547"/);
  assert.match(cmd, /--label "meta::framework-gap,friction::lint-loop"/);
  assert.match(cmd, /--body-file - <<EOF/);
  assert.match(cmd, /\nEOF$/);
});

test('composeRoutedProposals: consumer routing uses consumer-improvement meta label', () => {
  const out = composeRoutedProposals(
    baseInput({
      signals: [
        { category: 'flaky-test', source: 'consumer' },
        { category: 'flaky-test', source: 'consumer' },
      ],
    }),
  );
  const cmd = out.consumer[0].command;
  assert.match(cmd, /--repo dsj1984\/domio/);
  assert.match(cmd, /meta::consumer-improvement,friction::flaky-test/);
});

test('composeRoutedProposals: skips malformed signal records without crashing', () => {
  const out = composeRoutedProposals(
    baseInput({
      signals: [
        null,
        undefined,
        'not-an-object',
        42,
        { category: '', source: 'framework' }, // empty category dropped
        { category: 'good', source: 'framework' },
        { category: 'good', source: 'framework' },
      ],
    }),
  );
  assert.equal(out.framework.length, 1);
  assert.equal(out.framework[0].category, 'good');
});
