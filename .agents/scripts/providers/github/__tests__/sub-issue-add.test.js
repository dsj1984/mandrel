/**
 * sub-issue-add.test.js — the container-Epic sub-issue writer (Story #5139).
 *
 * Two contracts carry the weight:
 *   1. `sub_issue_id` must be the child's **database id**, never its issue
 *      number. Both are plausible integers, so a mix-up does not throw — it
 *      silently links the wrong issue. Only a test can catch that.
 *   2. The writer never throws. The Epic body's checklist is the durable
 *      mirror, so a lost edge must degrade, not abort a persist that has
 *      already created every Story.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addSubIssueEdges, linkStoriesToEpic } from '../sub-issue-add.js';

/** A `gh` double recording every POST. */
function ghDouble({ fail = () => false } = {}) {
  const posts = [];
  return {
    posts,
    api: async ({ method, endpoint, body }) => {
      if (method !== 'POST') return {};
      if (fail(body?.sub_issue_id)) {
        throw new Error(`boom for ${body?.sub_issue_id}`);
      }
      posts.push({ endpoint, body });
      return {};
    },
  };
}

const base = { owner: 'o', repo: 'r', issueNumber: 5 };

describe('addSubIssueEdges', () => {
  it('POSTs sub_issue_id to the parent sub_issues endpoint', async () => {
    const gh = ghDouble();
    const out = await addSubIssueEdges({
      ...base,
      gh,
      childInternalIds: [900, 901],
      paginate: async () => [],
    });
    assert.deepEqual(out, { added: 2, skipped: 0, failed: 0 });
    assert.equal(gh.posts[0].endpoint, '/repos/o/r/issues/5/sub_issues');
    assert.deepEqual(
      gh.posts
        .map((p) => p.body)
        .sort((a, b) => a.sub_issue_id - b.sub_issue_id),
      [{ sub_issue_id: 900 }, { sub_issue_id: 901 }],
    );
  });

  it('is idempotent — an existing edge is skipped, not re-POSTed', async () => {
    const gh = ghDouble();
    const out = await addSubIssueEdges({
      ...base,
      gh,
      childInternalIds: [900, 901],
      paginate: async () => [{ id: 900 }],
    });
    assert.deepEqual(out, { added: 1, skipped: 1, failed: 0 });
    assert.equal(gh.posts.length, 1);
    assert.equal(gh.posts[0].body.sub_issue_id, 901);
  });

  it('counts a failed edge and still writes the rest — never throws', async () => {
    const gh = ghDouble({ fail: (id) => id === 900 });
    const out = await addSubIssueEdges({
      ...base,
      gh,
      childInternalIds: [900, 901],
      paginate: async () => [],
    });
    assert.deepEqual(out, { added: 1, skipped: 0, failed: 1 });
  });

  it('treats an unreadable existing-edge list as empty and posts them all', async () => {
    const gh = ghDouble();
    const out = await addSubIssueEdges({
      ...base,
      gh,
      childInternalIds: [900],
      paginate: async () => {
        throw new Error('search down');
      },
    });
    assert.deepEqual(out, { added: 1, skipped: 0, failed: 0 });
  });

  it('no-ops on an empty child list without touching the API', async () => {
    const gh = ghDouble();
    let paginated = false;
    const out = await addSubIssueEdges({
      ...base,
      gh,
      childInternalIds: [],
      paginate: async () => {
        paginated = true;
        return [];
      },
    });
    assert.deepEqual(out, { added: 0, skipped: 0, failed: 0 });
    assert.equal(paginated, false);
    assert.equal(gh.posts.length, 0);
  });
});

describe('linkStoriesToEpic', () => {
  it('sends the DATABASE id, not the issue number', async () => {
    const gh = ghDouble();
    // Issue #10 has database id 90010 — the two must not be confused.
    const getTicket = async (n) => ({ internalId: n + 90000 });
    await linkStoriesToEpic({
      epicNumber: 5,
      childIssueNumbers: [10, 11],
      getTicket,
      owner: 'o',
      repo: 'r',
      gh,
      paginate: async () => [],
    });
    const sent = gh.posts.map((p) => p.body.sub_issue_id).sort();
    assert.deepEqual(sent, [90010, 90011]);
    assert.ok(
      !sent.includes(10),
      'issue number must never be sent as sub_issue_id',
    );
  });

  it('counts a child whose id cannot be resolved and links the others', async () => {
    const gh = ghDouble();
    const getTicket = async (n) => {
      if (n === 11) throw new Error('404');
      return { internalId: n + 90000 };
    };
    const out = await linkStoriesToEpic({
      epicNumber: 5,
      childIssueNumbers: [10, 11],
      getTicket,
      owner: 'o',
      repo: 'r',
      gh,
      paginate: async () => [],
    });
    assert.deepEqual(out, { added: 1, skipped: 0, failed: 1 });
  });

  it('counts a child with no numeric internalId as failed', async () => {
    const gh = ghDouble();
    const out = await linkStoriesToEpic({
      epicNumber: 5,
      childIssueNumbers: [10],
      getTicket: async () => ({ internalId: undefined }),
      owner: 'o',
      repo: 'r',
      gh,
      paginate: async () => [],
    });
    assert.deepEqual(out, { added: 0, skipped: 0, failed: 1 });
  });

  it('no-ops on an empty child list', async () => {
    const out = await linkStoriesToEpic({
      epicNumber: 5,
      childIssueNumbers: [],
      getTicket: async () => ({ internalId: 1 }),
      owner: 'o',
      repo: 'r',
      gh: ghDouble(),
    });
    assert.deepEqual(out, { added: 0, skipped: 0, failed: 0 });
  });
});

describe('linkStoriesToEpic — ids the caller already holds (Story #5280)', () => {
  it('issues no getTicket for a child whose database id createIssue returned', async () => {
    // `plan-persist` creates the cohort and is handed `internalId` in each
    // response, then threw it away — so linking the Epic re-read every Story
    // the same process had created seconds earlier, one round-trip per Story,
    // to recover a field it already had.
    const gh = ghDouble();
    const looked = [];
    await linkStoriesToEpic({
      epicNumber: 5,
      childIssueNumbers: [10, 11],
      knownInternalIds: new Map([
        [10, 90010],
        [11, 90011],
      ]),
      getTicket: async (n) => {
        looked.push(n);
        return { internalId: n + 90000 };
      },
      owner: 'o',
      repo: 'r',
      gh,
      paginate: async () => [],
    });

    assert.deepEqual(looked, [], 'no child was re-read');
    assert.deepEqual(
      gh.posts.map((p) => p.body.sub_issue_id).sort((a, b) => a - b),
      [90010, 90011],
      'the edges still carry the database ids',
    );
  });

  it('still looks up a child the caller has no id for', async () => {
    // A resumed run's adopted Stories were found by listing, not created, so
    // they carry no `internalId`. Absence means "not known here", never
    // "has none" — they must fall through to the lookup.
    const gh = ghDouble();
    const looked = [];
    await linkStoriesToEpic({
      epicNumber: 5,
      childIssueNumbers: [10, 11],
      knownInternalIds: new Map([[10, 90010]]),
      getTicket: async (n) => {
        looked.push(n);
        return { internalId: n + 90000 };
      },
      owner: 'o',
      repo: 'r',
      gh,
      paginate: async () => [],
    });

    assert.deepEqual(looked, [11], 'only the unknown child was read');
    assert.deepEqual(
      gh.posts.map((p) => p.body.sub_issue_id).sort((a, b) => a - b),
      [90010, 90011],
    );
  });

  it('reads every child when no map is supplied at all', async () => {
    const gh = ghDouble();
    const looked = [];
    await linkStoriesToEpic({
      epicNumber: 5,
      childIssueNumbers: [10, 11],
      getTicket: async (n) => {
        looked.push(n);
        return { internalId: n + 90000 };
      },
      owner: 'o',
      repo: 'r',
      gh,
      paginate: async () => [],
    });

    assert.deepEqual(looked, [10, 11], 'the pre-existing behaviour is intact');
  });
});
