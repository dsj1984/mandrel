/**
 * epic-container.test.js — the container-Epic shape (Story #5139).
 *
 * The load-bearing assertions here are the *negative* ones: an Epic body must
 * carry no `## Spec` / `## Acceptance` / `## Verify`, because the Epic is a
 * pure container and anything unique living in it would be invisible to every
 * agent delivering the children.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { appendEpicChildIds } from '../epic-checklist.js';
import {
  CHECKLIST_ITEM_LINE_RE,
  composeEpicBody,
  isEpicTicket,
  nativeChildReader,
  normalizeChildIds,
  readEpicChildIds,
  readEpicChildIdsFrom,
} from '../epic-container.js';

describe('node-id resolution, through the reader that consumes it', () => {
  // `resolveEpicNodeId` is module-private: the reader below is its only
  // production caller, and a helper nothing outside imports fails the
  // production dead-export gate. Driving it through `nativeChildReader` also
  // pins the thing that actually matters — that an unresolvable id means "skip
  // the read", not "send undefined to `$id: ID!`".
  function recordingProvider() {
    const calls = [];
    return {
      calls,
      getNativeSubIssues: async (nodeId, id) => {
        calls.push({ nodeId, id });
        return [11];
      },
    };
  }

  it('reads the camelCase id a mapped ticket carries', async () => {
    const provider = recordingProvider();
    await nativeChildReader(provider)({ nodeId: 'I_mapped', id: 1 });
    assert.deepEqual(provider.calls, [{ nodeId: 'I_mapped', id: 1 }]);
  });

  it('reads the snake_case id a raw REST issue carries', async () => {
    // A raw REST payload names it `node_id`, and the expansion path can still
    // hold one (Story #5251).
    const provider = recordingProvider();
    await nativeChildReader(provider)({ node_id: 'I_raw', number: 1 });
    assert.deepEqual(provider.calls, [{ nodeId: 'I_raw', id: 1 }]);
  });

  it('prefers the mapped name when an object somehow carries both', async () => {
    const provider = recordingProvider();
    await nativeChildReader(provider)({
      nodeId: 'I_mapped',
      node_id: 'I_raw',
      id: 1,
    });
    assert.deepEqual(provider.calls, [{ nodeId: 'I_mapped', id: 1 }]);
  });

  it('skips the read rather than handing an unusable value to $id: ID!', async () => {
    // Every one of these reached GraphQL as an invalid `ID!` variable, whose
    // rejection classifies as `permanent` — a hard API error manufactured
    // from a missing field. Skipping lets the body checklist stand in.
    for (const epic of [
      {},
      { nodeId: undefined },
      { node_id: null },
      { nodeId: '' },
      { node_id: 12345 },
      undefined,
      null,
    ]) {
      const provider = recordingProvider();
      assert.deepEqual(
        await nativeChildReader(provider)(epic),
        [],
        JSON.stringify(epic ?? null),
      );
      assert.deepEqual(provider.calls, [], 'the API was never reached');
    }
  });

  it('yields [] on a provider exposing no sub-issue read at all', async () => {
    assert.deepEqual(await nativeChildReader({})({ nodeId: 'I_x', id: 1 }), []);
  });

  it('accepts the legacy private alias so older doubles keep working', async () => {
    const calls = [];
    const ids = await nativeChildReader({
      _getNativeSubIssues: async (nodeId, id) => {
        calls.push({ nodeId, id });
        return [11, 12];
      },
    })({ nodeId: 'I_x', id: 1 });
    assert.deepEqual(ids, [11, 12]);
    assert.deepEqual(calls, [{ nodeId: 'I_x', id: 1 }]);
  });
});

describe('isEpicTicket', () => {
  it('reads the type::epic label in both label shapes', () => {
    assert.equal(isEpicTicket({ labels: ['type::epic'] }), true);
    assert.equal(isEpicTicket({ labels: [{ name: 'type::epic' }] }), true);
  });

  it('is false for a Story, a bare issue and a malformed input', () => {
    assert.equal(isEpicTicket({ labels: ['type::story'] }), false);
    assert.equal(isEpicTicket({ labels: [] }), false);
    assert.equal(isEpicTicket({}), false);
    assert.equal(isEpicTicket(null), false);
  });

  it('does not consult the body — a hand-edited Epic is still an Epic', () => {
    const epic = { labels: ['type::epic'], body: 'operator rewrote this' };
    assert.equal(isEpicTicket(epic), true);
  });
});

describe('composeEpicBody', () => {
  it('renders a goal paragraph and one checklist line per child', () => {
    const body = composeEpicBody({
      goal: 'Group the auth work.',
      childIds: [7, 8],
    });
    assert.match(body, /## Goal\n\nGroup the auth work\./);
    assert.match(body, /- \[ \] #7\n- \[ \] #8/);
  });

  it('carries NO execution payload — the container invariant', () => {
    const body = composeEpicBody({ goal: 'A goal.', childIds: [1] });
    assert.ok(!body.includes('## Spec'), 'an Epic must carry no Spec');
    assert.ok(
      !body.includes('## Acceptance'),
      'an Epic must carry no Acceptance',
    );
    assert.ok(!body.includes('## Verify'), 'an Epic must carry no Verify');
    assert.ok(!body.includes('## Changes'), 'an Epic must carry no Changes');
  });

  it('round-trips through readEpicChildIds', () => {
    const ids = [12, 34, 56];
    assert.deepEqual(
      readEpicChildIds(composeEpicBody({ goal: 'g', childIds: ids })),
      ids,
    );
  });

  it('renders an explicit empty state rather than a bare heading', () => {
    assert.match(composeEpicBody({ goal: 'g' }), /_No child Stories linked\._/);
  });

  it('throws on a missing or blank goal', () => {
    assert.throws(
      () => composeEpicBody({ goal: '', childIds: [1] }),
      /requires a goal/,
    );
    assert.throws(() => composeEpicBody({ goal: '   ' }), /requires a goal/);
    assert.throws(() => composeEpicBody({}), /requires a goal/);
  });
});

describe('readEpicChildIds', () => {
  it('reads checked and unchecked items alike', () => {
    const body = '## Stories\n\n- [ ] #10\n- [x] #11\n- [X] #12\n';
    assert.deepEqual(readEpicChildIds(body), [10, 11, 12]);
  });

  it('ignores an issue reference that is not a standalone checklist line', () => {
    const body = '## Goal\n\nSupersedes #99 and relates to #98.\n\n- [ ] #10\n';
    assert.deepEqual(readEpicChildIds(body), [10]);
  });

  it('does not leak regex lastIndex between calls', () => {
    const body = '- [ ] #1\n- [ ] #2\n';
    assert.deepEqual(readEpicChildIds(body), [1, 2]);
    assert.deepEqual(
      readEpicChildIds(body),
      [1, 2],
      're-read must be identical',
    );
  });

  it('returns [] for absent, empty and non-string bodies', () => {
    assert.deepEqual(readEpicChildIds(undefined), []);
    assert.deepEqual(readEpicChildIds(''), []);
    assert.deepEqual(readEpicChildIds(42), []);
  });
});

describe('the checklist grammar accepts a real hand-maintained tracker (Story #5210)', () => {
  // Verbatim shapes from container Epic #1891, whose 70 annotated rows the
  // old whole-line grammar matched none of. It presented 3 of 58 children to
  // the rollup, which closed it with 23 still open.
  const ANNOTATED = [
    '- [ ] Design & content sign-off (#1897): _pending_',
    '- [ ] 1.4 #1909 (Part A DONE; Part B blocked on the Infisical ceiling)',
    '- [x] 1.1 #1874 done',
  ].join('\n');

  it('reads an id carried anywhere on the row, not only as the whole row', () => {
    assert.deepEqual(readEpicChildIds(ANNOTATED), [1897, 1909, 1874]);
  });

  it('still refuses a prose line that is not a checklist row at all', () => {
    const body = 'Supersedes #99 and relates to #98.\n\n- [ ] #10\n';
    assert.deepEqual(readEpicChildIds(body), [10]);
  });

  it('takes the FIRST reference on a row, so one row is one child', () => {
    assert.deepEqual(
      readEpicChildIds('- [ ] blocked by #7, tracked as #8'),
      [7],
    );
  });

  it('ignores a row whose "id" is not a whole token', () => {
    assert.deepEqual(readEpicChildIds('- [ ] see #12abc\n'), []);
  });

  it('the /g reader and its single-line twin accept the same line set', () => {
    const lines = [
      '- [ ] #10',
      '- [x] #11',
      '- [X]   #12',
      '- [ ] Design & content sign-off (#1897): _pending_',
      '- [ ] 1.4 #1909 (Part B blocked)',
      '  - [ ] #13',
      '- [ ] no reference here',
      '- [ ] see #12abc',
      'Supersedes #99.',
      '* [ ] #14',
      '',
    ];
    for (const line of lines) {
      assert.equal(
        CHECKLIST_ITEM_LINE_RE.test(line),
        readEpicChildIds(line).length > 0,
        `the two grammars disagree on: ${JSON.stringify(line)}`,
      );
    }
  });
});

describe('normalizeChildIds', () => {
  it('dedupes, preserves first-seen order and drops non-positive integers', () => {
    assert.deepEqual(
      normalizeChildIds([3, 1, 3, 0, -2, 'x', null, 2]),
      [3, 1, 2],
    );
  });

  it('returns [] for a non-array', () => {
    assert.deepEqual(normalizeChildIds(null), []);
  });
});

describe('readEpicChildIdsFrom', () => {
  const epic = { number: 5, body: '- [ ] #10\n- [ ] #11\n' };

  it('unions the native edges with the body checklist, deduped', async () => {
    const result = await readEpicChildIdsFrom({
      epic,
      readNativeChildIds: async () => [11, 12],
    });
    assert.deepEqual(result, {
      ids: [11, 12, 10],
      nativeReadFailed: false,
      // #10 is in the checklist and NOT in the native edges, so the union owes
      // it to the body alone. Callers deciding what an unresolvable id means
      // need that split: a native id that will not resolve is a failed read, a
      // body-only one is a typo in hand-edited prose.
      bodyOnlyIds: [10],
    });
  });

  it('names no id body-only when the native read already vouched for it', async () => {
    const result = await readEpicChildIdsFrom({
      epic,
      readNativeChildIds: async () => [10, 11],
    });
    assert.deepEqual(result.bodyOnlyIds, []);
  });

  it('names nothing body-only when the native read FAILED', async () => {
    // With no authoritative source to contrast against, nothing is "body-only"
    // in the sense that matters — every id is unvouched, and the caller must
    // treat an unreadable one as a read failure, not a typo.
    const result = await readEpicChildIdsFrom({
      epic,
      readNativeChildIds: async () => {
        throw new Error('GraphQL unavailable');
      },
    });
    assert.equal(result.nativeReadFailed, true);
    assert.deepEqual(result.bodyOnlyIds, []);
  });

  it('falls back to the checklist alone when there is no native reader', async () => {
    assert.deepEqual(await readEpicChildIdsFrom({ epic }), {
      ids: [10, 11],
      nativeReadFailed: false,
      bodyOnlyIds: [],
    });
  });

  it('degrades to the checklist and warns when the native read throws', async () => {
    const warnings = [];
    const { ids } = await readEpicChildIdsFrom({
      epic,
      readNativeChildIds: async () => {
        throw new Error('GraphQL unavailable');
      },
      onWarn: (m) => warnings.push(m),
    });
    assert.deepEqual(
      ids,
      [10, 11],
      'a failed API read must not lose the body children',
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Epic #5/);
    assert.match(warnings[0], /GraphQL unavailable/);
  });

  it('REPORTS the degrade, so a truncated list is not mistaken for a small Epic (Story #5210)', async () => {
    const { nativeReadFailed } = await readEpicChildIdsFrom({
      epic,
      readNativeChildIds: async () => {
        throw new Error('gh-exec: gh exited with code 1');
      },
    });
    assert.equal(
      nativeReadFailed,
      true,
      'the caller deciding an irreversible close must be able to see this',
    );
  });

  it('warns that the list may be incomplete, not merely that a read failed', async () => {
    const warnings = [];
    await readEpicChildIdsFrom({
      epic,
      readNativeChildIds: async () => {
        throw new Error('boom');
      },
      onWarn: (m) => warnings.push(m),
    });
    assert.match(warnings[0], /may be incomplete/);
  });

  it('is not "degraded" when the caller supplied no reader — it asked for no authority', async () => {
    const { nativeReadFailed } = await readEpicChildIdsFrom({ epic });
    assert.equal(nativeReadFailed, false);
  });
});

describe('appendEpicChildIds — adoption writes into a live body (Story #5155)', () => {
  const MARKER = '<!-- mandrel-epic-fingerprint abcd1234 -->';

  it('replaces the empty-container placeholder rather than leaving it standing', () => {
    const body = `${composeEpicBody({ goal: 'Group it.' })}\n${MARKER}\n`;
    assert.ok(body.includes('_No child Stories linked._'));

    const next = appendEpicChildIds(body, [7, 8]);

    assert.ok(!next.includes('_No child Stories linked._'));
    assert.ok(next.includes('- [ ] #7'));
    assert.ok(next.includes('- [ ] #8'));
    assert.ok(next.includes(MARKER), 'the fingerprint marker survives');
  });

  it('is idempotent — a resumed persist must not double-list its cohort', () => {
    const body = `${composeEpicBody({ goal: 'g' })}\n${MARKER}\n`;
    const once = appendEpicChildIds(body, [7, 8]);
    const twice = appendEpicChildIds(once, [7, 8]);

    assert.equal(twice, once);
    assert.deepEqual(readEpicChildIds(twice), [7, 8]);
  });

  it('returns the body byte-identical when every id is already listed', () => {
    const body = composeEpicBody({ goal: 'g', childIds: [1, 2] });
    assert.equal(appendEpicChildIds(body, [2, 1]), body);
  });

  it('preserves checked state and appends after the last existing row', () => {
    const body = composeEpicBody({ goal: 'g', childIds: [1, 2] }).replace(
      '- [ ] #1',
      '- [x] #1',
    );

    const next = appendEpicChildIds(body, [2, 9]);

    assert.ok(next.includes('- [x] #1'), 'a ticked child stays ticked');
    assert.deepEqual(
      readEpicChildIds(next),
      [1, 2, 9],
      'original order first, then the appended id',
    );
  });

  it('keeps the goal prose untouched', () => {
    const goal = 'Group the auth hardening work for Q3.';
    const next = appendEpicChildIds(composeEpicBody({ goal }), [5]);
    assert.ok(next.includes(goal));
  });

  it('adds a checklist section to a hand-written Epic that has none', () => {
    const next = appendEpicChildIds('Some operator prose, no headings.\n', [3]);

    assert.ok(next.includes('## Stories'));
    assert.deepEqual(readEpicChildIds(next), [3]);
    assert.ok(next.startsWith('Some operator prose, no headings.'));
  });

  it('appends after the last ANNOTATED row, not the last bare one (Story #5210)', () => {
    const body = [
      '## Goal',
      '',
      'Group them.',
      '',
      '## Stories',
      '',
      '- [ ] #1',
      '- [ ] Design sign-off (#2): _pending_',
      '',
    ].join('\n');

    const next = appendEpicChildIds(body, [9]);
    const lines = next.split('\n');

    assert.ok(
      lines.indexOf('- [ ] #9') >
        lines.indexOf('- [ ] Design sign-off (#2): _pending_'),
      'a new row must land after every existing row, annotated or not',
    );
    assert.deepEqual(readEpicChildIds(next), [1, 2, 9]);
  });

  it('is still idempotent against an annotated row naming the same id', () => {
    const body = '## Stories\n\n- [ ] Design sign-off (#2): _pending_\n';
    assert.equal(appendEpicChildIds(body, [2]), body);
  });

  it('ignores non-ids and a non-string body without throwing', () => {
    assert.equal(appendEpicChildIds('body', []), 'body');
    assert.equal(appendEpicChildIds('body', [0, -1, 'x', null]), 'body');
    assert.equal(appendEpicChildIds(null, [1]).includes('- [ ] #1'), true);
  });
});
