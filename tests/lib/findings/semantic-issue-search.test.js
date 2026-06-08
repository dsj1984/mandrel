import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  __testing,
  buildQuery,
  searchSemanticCandidates,
} from '../../../.agents/scripts/lib/findings/semantic-issue-search.js';

const { tokenize, jaccard, dedupeByNumber } = __testing;

const finding = {
  title: 'Unparameterised SQL query in login handler',
  area: 'injection',
  primaryFile: 'src/routes/auth/login.js',
  severity: 'high',
  labels: ['security', 'sql'],
};

test('buildQuery joins title, area, and primaryFile into normalised text', () => {
  const query = buildQuery(finding);
  assert.ok(query.includes('unparameterised sql query'));
  assert.ok(query.includes('injection'));
  assert.ok(query.includes('login js'));
});

test('buildQuery tolerates a finding with only a title', () => {
  const query = buildQuery({ title: 'Just a title' });
  assert.equal(query, 'just a title');
});

test('tokenize drops sub-2-char noise tokens', () => {
  const tokens = tokenize('a fix in the db layer');
  assert.ok(tokens.has('fix'));
  assert.ok(tokens.has('the'));
  assert.ok(tokens.has('db'));
  assert.ok(!tokens.has('a'));
});

test('jaccard is 0 when either token set is empty', () => {
  assert.equal(jaccard(new Set(), new Set(['x'])), 0);
  assert.equal(jaccard(new Set(['x']), new Set()), 0);
});

test('jaccard is 1 for identical token sets', () => {
  const a = new Set(['sql', 'login']);
  const b = new Set(['login', 'sql']);
  assert.equal(jaccard(a, b), 1);
});

test('dedupeByNumber keeps the first occurrence of each issue number', () => {
  const out = dedupeByNumber([
    { number: 1, state: 'open' },
    { number: 1, state: 'closed' },
    { number: 2, state: 'open' },
    { number: undefined },
  ]);
  assert.deepEqual(
    out.map((i) => `${i.number}:${i.state}`),
    ['1:open', '2:open'],
  );
});

test('searchSemanticCandidates requires a search port', async () => {
  await assert.rejects(() => searchSemanticCandidates(finding, {}));
});

test('searchSemanticCandidates runs with no network — the search port is injected', async () => {
  let received = null;
  const result = await searchSemanticCandidates(finding, {
    search: async (query) => {
      received = query;
      return [];
    },
  });
  assert.ok(typeof received === 'string' && received.length > 0);
  assert.deepEqual(result, []);
});

test('searchSemanticCandidates returns candidates from BOTH open and closed issues', async () => {
  const result = await searchSemanticCandidates(finding, {
    search: async () => [
      { number: 10, state: 'open', title: 'SQL injection in login handler' },
      { number: 11, state: 'closed', title: 'SQL injection in login handler' },
    ],
  });
  const states = result.map((r) => r.state).sort();
  assert.deepEqual(states, ['closed', 'open']);
});

test('searchSemanticCandidates folds Epic sub-issues into the candidate pool', async () => {
  const result = await searchSemanticCandidates(
    finding,
    {
      search: async () => [
        { number: 10, state: 'open', title: 'SQL injection in login' },
      ],
      listEpicSubIssues: async (epicId) => {
        assert.equal(epicId, 3798);
        return [
          {
            number: 20,
            state: 'closed',
            title: 'Unparameterised SQL query in login handler',
          },
        ];
      },
    },
    { epicId: 3798 },
  );
  const numbers = result.map((r) => r.number).sort((a, b) => a - b);
  assert.deepEqual(numbers, [10, 20]);
});

test('searchSemanticCandidates dedupes an issue that appears in both search and sub-issues', async () => {
  const shared = {
    number: 30,
    state: 'open',
    title: 'Unparameterised SQL query in login handler',
  };
  const result = await searchSemanticCandidates(
    finding,
    {
      search: async () => [shared],
      listEpicSubIssues: async () => [shared],
    },
    { epicId: 3798 },
  );
  assert.equal(result.filter((r) => r.number === 30).length, 1);
});

test('searchSemanticCandidates sorts candidates best-match first', async () => {
  const result = await searchSemanticCandidates(finding, {
    search: async () => [
      { number: 1, state: 'open', title: 'Totally unrelated dashboard tweak' },
      {
        number: 2,
        state: 'open',
        title: 'Unparameterised SQL query in login handler',
      },
    ],
  });
  assert.equal(result[0].number, 2, 'closest title match ranks first');
  assert.ok(result[0].score >= result[1].score);
});

test('searchSemanticCandidates honours the limit option', async () => {
  const result = await searchSemanticCandidates(
    finding,
    {
      search: async () =>
        Array.from({ length: 10 }, (_, i) => ({
          number: i,
          state: 'open',
          title: 'sql injection login handler',
        })),
    },
    { limit: 3 },
  );
  assert.equal(result.length, 3);
});

test('searchSemanticCandidates drops malformed issue records', async () => {
  const result = await searchSemanticCandidates(finding, {
    search: async () => [
      { number: 'not-a-number', state: 'open', title: 'x' },
      { number: 5, state: 'open', title: 'sql injection login handler' },
      { state: 'open', title: 'no number' },
    ],
  });
  assert.deepEqual(
    result.map((r) => r.number),
    [5],
  );
});

test('searchSemanticCandidates skips Epic sub-issues when no epicId is in scope', async () => {
  let subIssuesCalled = false;
  await searchSemanticCandidates(finding, {
    search: async () => [],
    listEpicSubIssues: async () => {
      subIssuesCalled = true;
      return [];
    },
  });
  assert.equal(subIssuesCalled, false);
});
