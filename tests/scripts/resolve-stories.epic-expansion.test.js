/**
 * The resolve-stories.js CLI join: an Epic id typed by the operator actually
 * reaches `expandEpicIds` and the Stories that come back are what get resolved
 * (Story #5139).
 *
 * The unit tests around `expandEpicIds` prove the expansion; these prove the
 * CLI *wires it up*. Without this, `fetchStories` could stop calling it and
 * every expansion test would stay green while `/mandrel-deliver <epicId>`
 * hard-errored on "not a Story".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  fetchStories,
  nativeChildReader,
} from '../../.agents/scripts/resolve-stories.js';

const story = (number, extra = {}) => ({
  number,
  title: `Story ${number}`,
  labels: ['type::story', 'agent::ready'],
  state: 'open',
  body: '',
  ...extra,
});

const epic = (number, childIds) => ({
  number,
  title: 'Container',
  labels: ['type::epic'],
  state: 'open',
  body: `## Stories\n\n${childIds.map((c) => `- [ ] #${c}`).join('\n')}\n`,
});

function providerFor(issues, { native } = {}) {
  return {
    getTicket: async (id) => issues.get(Number(id)) ?? null,
    _getNativeSubIssues: native,
  };
}

describe('fetchStories — Epic expansion at the CLI seam', () => {
  it('resolves an Epic id into Story records for its open children', async () => {
    const issues = new Map([
      [1, epic(1, [10, 11])],
      [10, story(10)],
      [11, story(11)],
    ]);
    const records = await fetchStories(providerFor(issues), [1]);
    assert.deepEqual(
      records.map((r) => r.id),
      [10, 11],
    );
    assert.ok(
      records.every((r) => r.labels.includes('type::story')),
      'every resolved record must be a Story',
    );
  });

  it('drops a landed child so only outstanding work is resolved', async () => {
    const issues = new Map([
      [1, epic(1, [10, 11])],
      [10, story(10)],
      [11, story(11, { state: 'closed' })],
    ]);
    const records = await fetchStories(providerFor(issues), [1]);
    assert.deepEqual(
      records.map((r) => r.id),
      [10],
    );
  });

  it('leaves a plain Story id alone', async () => {
    const issues = new Map([[10, story(10)]]);
    const records = await fetchStories(providerFor(issues), [10]);
    assert.deepEqual(
      records.map((r) => r.id),
      [10],
    );
  });

  it('resolves a mixed Epic + Story invocation without duplicates', async () => {
    const issues = new Map([
      [1, epic(1, [10, 11])],
      [10, story(10)],
      [11, story(11)],
      [20, story(20)],
    ]);
    const records = await fetchStories(providerFor(issues), [20, 1, 10]);
    assert.deepEqual(
      records.map((r) => r.id).sort((a, b) => a - b),
      [10, 11, 20],
    );
  });

  it('still hard-errors on a named ticket that is neither type', async () => {
    const issues = new Map([
      [9, { number: 9, labels: ['type::chore'], state: 'open', body: '' }],
    ]);
    await assert.rejects(
      () => fetchStories(providerFor(issues), [9]),
      /is not a Story/,
    );
  });

  it('propagates the empty-Epic refusal rather than resolving nothing', async () => {
    const issues = new Map([[1, epic(1, [])]]);
    await assert.rejects(
      () => fetchStories(providerFor(issues), [1]),
      /lists no child Stories/,
    );
  });
});

describe('nativeChildReader', () => {
  it('reads children through the provider GraphQL surface', async () => {
    const seen = [];
    const provider = {
      _getNativeSubIssues: async (nodeId, id) => {
        seen.push({ nodeId, id });
        return [10, 11];
      },
    };
    const ids = await nativeChildReader(provider)({ nodeId: 'N1', number: 1 });
    assert.deepEqual(ids, [10, 11]);
    assert.deepEqual(seen, [{ nodeId: 'N1', id: 1 }]);
  });

  it('yields [] on a provider without the GraphQL surface', async () => {
    assert.deepEqual(await nativeChildReader({})({ number: 1 }), []);
  });

  it('lets the body checklist stand in when the native read throws', async () => {
    const issues = new Map([
      [1, epic(1, [10])],
      [10, story(10)],
    ]);
    const provider = providerFor(issues, {
      native: async () => {
        throw new Error('GraphQL unavailable');
      },
    });
    const records = await fetchStories(provider, [1]);
    assert.deepEqual(
      records.map((r) => r.id),
      [10],
      'a failed API read must not lose the checklist children',
    );
  });
});
