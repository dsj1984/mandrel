/**
 * Unit tests for the retrofit-task-bodies helpers (v5.33+).
 *
 * Pin the idempotency contract — a task already in four-section format MUST
 * be skipped — and the legacy-body extraction (parent / blocked-by) the
 * apply path depends on to preserve the orchestrator footer.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectNonConformingTasks,
  parseFooterBlockers,
  parseFooterParent,
  unifiedDiff,
} from '../.agents/scripts/lib/retrofit/task-body-retrofit.js';

function ticket(overrides) {
  return {
    id: 1,
    title: 't',
    body: '',
    labels: [],
    state: 'open',
    ...overrides,
  };
}

describe('unifiedDiff — edge cases', () => {
  it('emits a header pair even for empty inputs', () => {
    const out = unifiedDiff('', '', 'task#1');
    assert.match(out, /^--- task#1 \(current\)\n\+\+\+ task#1 \(proposed\)/);
  });

  it('returns equal lines as `  ` context when texts match', () => {
    const out = unifiedDiff('a\nb\nc', 'a\nb\nc', 't');
    const body = out.split('\n').slice(2);
    assert.deepEqual(body, ['  a', '  b', '  c']);
  });

  it('emits `- old` and `+ new` for divergent lines', () => {
    const out = unifiedDiff('a\nx\nc', 'a\ny\nc', 't');
    assert.ok(out.includes('- x'));
    assert.ok(out.includes('+ y'));
  });

  it('handles old shorter than new (pure additions at the end)', () => {
    const out = unifiedDiff('a', 'a\nb\nc', 't');
    const body = out.split('\n').slice(2);
    // first line equal, then two additions
    assert.equal(body[0], '  a');
    assert.ok(body.some((line) => line === '+ b'));
    assert.ok(body.some((line) => line === '+ c'));
  });

  it('handles new shorter than old (pure deletions at the end)', () => {
    const out = unifiedDiff('a\nb\nc', 'a', 't');
    const body = out.split('\n').slice(2);
    assert.equal(body[0], '  a');
    assert.ok(body.some((line) => line === '- b'));
    assert.ok(body.some((line) => line === '- c'));
  });

  it('null/undefined arms split into a single empty line each', () => {
    const out = unifiedDiff(null, null, 't');
    assert.equal(out.split('\n').slice(2).join(''), '  ');
  });
});

describe('isTaskTicket / isStoryTicket', () => {
  // Re-imported here so this batch's tests are self-contained.
  it('treats absent labels array as no-label', async () => {
    const m = await import(
      '../.agents/scripts/lib/retrofit/task-body-retrofit.js'
    );
    assert.equal(m.isTaskTicket({}), false);
    assert.equal(m.isStoryTicket({}), false);
  });

  it('returns true only for the matching type label', async () => {
    const m = await import(
      '../.agents/scripts/lib/retrofit/task-body-retrofit.js'
    );
    assert.equal(m.isTaskTicket({ labels: ['type::task'] }), true);
    assert.equal(m.isStoryTicket({ labels: ['type::story'] }), true);
    assert.equal(m.isTaskTicket({ labels: ['type::story'] }), false);
    assert.equal(m.isStoryTicket({ labels: ['type::task'] }), false);
  });
});

describe('parseFooterParent / parseFooterBlockers', () => {
  it('extracts parent and blocked-by from the legacy footer', () => {
    const body = [
      'Some body',
      '',
      '---',
      'parent: #728',
      'Epic: #700',
      '',
      'blocked by #790',
      'blocked by #791',
    ].join('\n');
    assert.equal(parseFooterParent(body), 728);
    assert.deepEqual(parseFooterBlockers(body), [790, 791]);
  });

  it('returns null/[] for bodies without a footer', () => {
    assert.equal(parseFooterParent('plain body'), null);
    assert.deepEqual(parseFooterBlockers('plain body'), []);
  });
});

describe('collectNonConformingTasks', () => {
  it('skips tasks whose body already has the ## Goal header', () => {
    const conforming = ticket({
      id: 793,
      title: 'Already retrofitted',
      labels: ['type::task'],
      body: [
        '## Goal',
        'do x per s1',
        '',
        '## Changes',
        '- src/x.ts: extract',
        '',
        '## Acceptance',
        '- [ ] tests pass',
        '',
        '## Verify',
        '- npm run test (unit)',
        '',
        '---',
        'parent: #728',
      ].join('\n'),
    });
    const nonConforming = ticket({
      id: 794,
      title: 'Legacy body',
      labels: ['type::task'],
      body: 'Brief description\n\n---\nparent: #728\nEpic: #700',
    });
    const story = ticket({
      id: 728,
      title: 'Parent Story',
      labels: ['type::story'],
      body: 'Story body',
    });

    const provider = {
      getTickets: async () => [conforming, nonConforming, story],
    };

    const results = collectNonConformingTasks(700, provider);
    return results.then((r) => {
      assert.equal(r.length, 1);
      assert.equal(r[0].task.id, 794);
      assert.equal(r[0].parentStory?.id, 728);
    });
  });

  it('returns empty when no tasks need retrofit', async () => {
    const conforming = ticket({
      id: 1,
      labels: ['type::task'],
      body: '## Goal\nx\n\n## Changes\n- a/b: c\n\n## Acceptance\n- [ ] x\n\n## Verify\n- y (unit)\n\n---\nparent: #2',
    });
    const provider = { getTickets: async () => [conforming] };
    const r = await collectNonConformingTasks(99, provider);
    assert.deepEqual(r, []);
  });

  it('handles missing parent Story (legacy footer with stale parent id)', async () => {
    const orphan = ticket({
      id: 9,
      labels: ['type::task'],
      body: 'x\n---\nparent: #404',
    });
    const provider = { getTickets: async () => [orphan] };
    const r = await collectNonConformingTasks(1, provider);
    assert.equal(r.length, 1);
    assert.equal(r[0].parentStory, null);
  });
});

describe('unifiedDiff', () => {
  it('produces a label-prefixed diff that distinguishes added / removed lines', () => {
    const out = unifiedDiff('a\nb\nc', 'a\nb\nc\nd', '#1');
    assert.match(out, /^--- #1 \(current\)/);
    assert.match(out, /\+\+\+ #1 \(proposed\)/);
    assert.match(out, /\+ d/);
  });
});
