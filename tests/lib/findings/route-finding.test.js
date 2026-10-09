import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  auditFindingRecord,
  parseAuditFindingRecords,
} from '../../../.agents/scripts/lib/findings/audit-finding-record.js';
import {
  normalizeOwnedProvenance,
  ownedProvenanceSource,
} from '../../../.agents/scripts/lib/findings/provenance-field.js';
import {
  __testing,
  carryProvenanceFooters,
  extractProvenanceFooters,
  fingerprintFinding,
  fingerprintFooter,
  parseFingerprintFooter,
  routeFinding,
  semanticKeyFooter,
  semanticKeyFor,
} from '../../../.agents/scripts/lib/findings/route-finding.js';

// Internal helper: the module's three call sites reach it directly, so it is
// exposed through `__testing` rather than widening the public surface.
const { parseSemanticKeyFooter } = __testing;

const baseFinding = {
  title: 'Unparameterised SQL query in login handler',
  area: 'injection',
  primaryFile: 'src/routes/auth/login.js',
  severity: 'high',
  labels: ['security', 'sql'],
};

test('fingerprintFinding produces a stable sha1 for identical inputs', () => {
  const a = fingerprintFinding(baseFinding);
  const b = fingerprintFinding({ ...baseFinding });
  assert.equal(a.full, b.full);
  assert.equal(a.full.length, 40);
  assert.equal(a.short.length, 12);
  assert.equal(a.short, a.full.slice(0, 12));
});

test('fingerprintFinding is order-independent in labels', () => {
  const a = fingerprintFinding(baseFinding);
  const b = fingerprintFinding({ ...baseFinding, labels: ['sql', 'security'] });
  assert.equal(a.full, b.full);
});

test('fingerprintFinding is case- and whitespace-insensitive', () => {
  const a = fingerprintFinding(baseFinding);
  const b = fingerprintFinding({
    ...baseFinding,
    title: '  UNPARAMETERISED SQL QUERY IN LOGIN HANDLER  ',
    severity: 'High',
  });
  assert.equal(a.full, b.full);
});

test('fingerprintFinding differs when title differs', () => {
  const a = fingerprintFinding(baseFinding);
  const b = fingerprintFinding({ ...baseFinding, title: 'SQLi in signup' });
  assert.notEqual(a.full, b.full);
});

test('fingerprintFinding differs when severity differs', () => {
  const a = fingerprintFinding(baseFinding);
  const b = fingerprintFinding({ ...baseFinding, severity: 'low' });
  assert.notEqual(a.full, b.full);
});

test('fingerprintFinding differs when primaryFile differs', () => {
  const a = fingerprintFinding(baseFinding);
  const b = fingerprintFinding({ ...baseFinding, primaryFile: 'src/x.js' });
  assert.notEqual(a.full, b.full);
});

test('fingerprintFinding tolerates missing fields', () => {
  const fp = fingerprintFinding({ title: 'only a title' });
  assert.equal(fp.full.length, 40);
  assert.equal(fp.components.area, '');
  assert.equal(fp.components.labels, '');
  assert.equal(fp.components.primaryFile, '');
});

test('fingerprintFinding tolerates a null finding', () => {
  const fp = fingerprintFinding(null);
  assert.equal(fp.full.length, 40);
});

test('fingerprintFooter round-trips through parseFingerprintFooter (AC #4)', () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const footer = fingerprintFooter(sha);
  const body = `Some issue body.\n\n${footer}\n`;
  assert.deepEqual(parseFingerprintFooter(body), [sha]);
});

test('fingerprintFooter rejects a non-sha argument', () => {
  assert.throws(() => fingerprintFooter('not-a-sha'));
  assert.throws(() => fingerprintFooter(null));
});

test('parseFingerprintFooter returns empty array when marker absent', () => {
  assert.deepEqual(parseFingerprintFooter('hello world'), []);
});

test('parseFingerprintFooter ignores malformed sha entries', () => {
  const body =
    '<!-- audit-fingerprints: notasha, abc, 0123456789abcdef0123456789abcdef01234567 -->';
  assert.deepEqual(parseFingerprintFooter(body), [
    '0123456789abcdef0123456789abcdef01234567',
  ]);
});

test('parseFingerprintFooter tolerates non-string input', () => {
  assert.deepEqual(parseFingerprintFooter(null), []);
  assert.deepEqual(parseFingerprintFooter(undefined), []);
});

test('routeFinding returns new when no existing issue matches (AC #1)', async () => {
  const result = await routeFinding(baseFinding, {
    searchIssues: async () => [],
  });
  assert.equal(result.decision, 'new');
  assert.equal(result.matchedIssue, null);
});

test('routeFinding returns update-existing for a single open match (AC #2)', async () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const result = await routeFinding(baseFinding, {
    searchIssues: async () => [
      { number: 42, state: 'open', body: fingerprintFooter(sha) },
    ],
  });
  assert.equal(result.decision, 'update-existing');
  assert.equal(result.matchedIssue.number, 42);
});

test('routeFinding returns duplicate for multiple open matches (AC #2)', async () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const footer = fingerprintFooter(sha);
  const result = await routeFinding(baseFinding, {
    searchIssues: async () => [
      { number: 42, state: 'open', body: footer },
      { number: 43, state: 'open', body: footer },
    ],
  });
  assert.equal(result.decision, 'duplicate');
  assert.equal(result.matchedIssue.number, 42);
});

test('routeFinding returns regression-of-closed for a closed match (AC #3)', async () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const result = await routeFinding(baseFinding, {
    searchIssues: async () => [
      { number: 99, state: 'closed', body: fingerprintFooter(sha) },
    ],
  });
  assert.equal(result.decision, 'regression-of-closed');
  assert.equal(result.matchedIssue.number, 99);
});

test('routeFinding prefers an open match over a closed one', async () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const footer = fingerprintFooter(sha);
  const result = await routeFinding(baseFinding, {
    searchIssues: async () => [
      { number: 99, state: 'closed', body: footer },
      { number: 42, state: 'open', body: footer },
    ],
  });
  assert.equal(result.decision, 'update-existing');
  assert.equal(result.matchedIssue.number, 42);
});

test('routeFinding ignores a search hit whose body lacks the footer', async () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const result = await routeFinding(baseFinding, {
    searchIssues: async () => [
      { number: 7, state: 'open', body: `mentions ${sha} in prose only` },
    ],
  });
  assert.equal(result.decision, 'new');
  assert.equal(result.matchedIssue, null);
});

test('routeFinding accepts a hit with no body (search-only confirmation)', async () => {
  const result = await routeFinding(baseFinding, {
    searchIssues: async () => [{ number: 5, state: 'open' }],
  });
  assert.equal(result.decision, 'update-existing');
  assert.equal(result.matchedIssue.number, 5);
});

test('routeFinding throws when searchIssues port is missing', async () => {
  await assert.rejects(() => routeFinding(baseFinding, {}));
});

test('routeFinding exposes the fingerprint it routed on', async () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const result = await routeFinding(baseFinding, {
    searchIssues: async () => [],
  });
  assert.equal(result.fingerprint, sha);
});

// --- Routing: gather from every wired port, then confirm by footer ---

test('routeFinding runs BOTH ports and unions their pools (Story #5079)', async () => {
  const calls = [];
  const { full: sha } = fingerprintFinding(baseFinding);
  const result = await routeFinding(baseFinding, {
    searchCandidates: async (finding) => {
      calls.push('semantic');
      assert.equal(finding.title, baseFinding.title);
      return [{ number: 42, state: 'open', body: fingerprintFooter(sha) }];
    },
    searchIssues: async (queried) => {
      calls.push('fingerprint');
      assert.equal(queried, sha);
      return [];
    },
  });
  // The semantic pass WIDENS the exact lookup; it does not replace it. Both
  // ports run, fingerprint first, and confirmation reads their union.
  assert.deepEqual(calls, ['fingerprint', 'semantic']);
  assert.equal(result.decision, 'update-existing');
  assert.equal(result.matchedIssue.number, 42);
});

test('routeFinding confirms an Issue only the fingerprint port returns (Story #5079)', async () => {
  // The measured shape behind #5079: the filed Story carries the finding's
  // fingerprint footer, but the semantic bag-of-words query does not retrieve
  // it (GitHub returned total_count: 0 for the real query). Before the union
  // the whole pool was that empty semantic result, so the finding routed
  // `new` and the audit loop re-filed an Issue that already existed.
  const { full: sha } = fingerprintFinding(baseFinding);
  const result = await routeFinding(baseFinding, {
    searchCandidates: async () => [],
    searchIssues: async () => [
      { number: 5077, state: 'open', body: fingerprintFooter(sha) },
    ],
  });
  assert.equal(result.decision, 'update-existing');
  assert.equal(result.matchedIssue.number, 5077);
});

test('routeFinding routes a closed fingerprint-only match to regression-of-closed (Story #5079)', async () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const result = await routeFinding(baseFinding, {
    searchCandidates: async () => [],
    searchIssues: async () => [
      { number: 4321, state: 'closed', body: fingerprintFooter(sha) },
    ],
  });
  assert.equal(result.decision, 'regression-of-closed');
  assert.equal(result.matchedIssue.number, 4321);
});

test('routeFinding de-duplicates an Issue both ports return (Story #5079)', async () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const hit = { number: 77, state: 'open', body: fingerprintFooter(sha) };
  const result = await routeFinding(baseFinding, {
    searchCandidates: async () => [{ ...hit }],
    searchIssues: async () => [{ ...hit }],
  });
  // One Issue confirming twice must not read as two open matches.
  assert.equal(result.decision, 'update-existing');
  assert.equal(result.matchedIssue.number, 77);
});

test('routeFinding propagates a searchIssues failure even when the semantic pass succeeds (Story #5079)', async () => {
  // A pool gathered from only some of its sources is unknown, not smaller —
  // the caller must degrade rather than report a confident decision.
  await assert.rejects(
    () =>
      routeFinding(baseFinding, {
        searchCandidates: async () => [],
        searchIssues: async () => {
          throw new Error('rate limit still exhausted after cooldown');
        },
      }),
    /rate limit/,
  );
});

test('routeFinding propagates a searchCandidates failure even when the fingerprint pass succeeds (Story #5079)', async () => {
  await assert.rejects(
    () =>
      routeFinding(baseFinding, {
        searchCandidates: async () => {
          throw new Error('search query rejected (HTTP 422)');
        },
        searchIssues: async () => [],
      }),
    /422/,
  );
});

test('routeFinding fingerprint-confirms the semantic candidate pool (drops a similar-but-unrelated hit)', async () => {
  const result = await routeFinding(baseFinding, {
    searchCandidates: async () => [
      // Semantically similar title, but the body carries no fingerprint footer.
      { number: 7, state: 'open', title: 'SQL injection in login', body: '' },
    ],
  });
  assert.equal(result.decision, 'new');
  assert.equal(result.matchedIssue, null);
});

test('routeFinding routes a closed semantic candidate to regression-of-closed', async () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const result = await routeFinding(baseFinding, {
    searchCandidates: async () => [
      { number: 99, state: 'closed', body: fingerprintFooter(sha) },
    ],
  });
  assert.equal(result.decision, 'regression-of-closed');
  assert.equal(result.matchedIssue.number, 99);
});

test('routeFinding preserves the decision enum across both ports', async () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const footer = fingerprintFooter(sha);
  const viaSemantic = await routeFinding(baseFinding, {
    searchCandidates: async () => [
      { number: 1, state: 'open', body: footer },
      { number: 2, state: 'open', body: footer },
    ],
  });
  const viaFingerprint = await routeFinding(baseFinding, {
    searchIssues: async () => [
      { number: 1, state: 'open', body: footer },
      { number: 2, state: 'open', body: footer },
    ],
  });
  assert.equal(viaSemantic.decision, 'duplicate');
  assert.equal(viaFingerprint.decision, 'duplicate');
});

test('routeFinding throws when neither a searchCandidates nor a searchIssues port is supplied', async () => {
  await assert.rejects(() => routeFinding(baseFinding, {}));
  await assert.rejects(() => routeFinding(baseFinding));
});

// ---------------------------------------------------------------------------
// Story #4877 — multi-footer parsing and the mechanical provenance carry.
// ---------------------------------------------------------------------------

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

test('parseFingerprintFooter reads EVERY footer occurrence, not just the first', () => {
  // The audit Single-plan seed stamps one footer pair per MVP Scope bullet, so a
  // multi-group seed carries several. A first-match-only parse silently dropped
  // every group but the first — which would make the carry below look wired
  // while leaking most of the provenance.
  const seed = [
    '## MVP Scope',
    '',
    `1. **Group one** — architecture`,
    `   ${fingerprintFooter(SHA_A)}`,
    `2. **Group two** — quality`,
    `   ${fingerprintFooter([SHA_B, SHA_C])}`,
  ].join('\n');
  assert.deepEqual(parseFingerprintFooter(seed), [SHA_A, SHA_B, SHA_C]);
});

test('parseFingerprintFooter de-duplicates a sha repeated across footers', () => {
  const body = `${fingerprintFooter(SHA_A)}\n${fingerprintFooter([SHA_A, SHA_B])}`;
  assert.deepEqual(parseFingerprintFooter(body), [SHA_A, SHA_B]);
});

test('parseSemanticKeyFooter reads every footer occurrence', () => {
  const seed = [
    `   ${semanticKeyFooter('architecture␟lib/a.js')}`,
    `   ${semanticKeyFooter('quality␟lib/b.js')}`,
  ].join('\n');
  assert.deepEqual(parseSemanticKeyFooter(seed), [
    'architecture␟lib/a.js',
    'quality␟lib/b.js',
  ]);
});

test('carryProvenanceFooters copies both footers from the seed into the body (AC-5)', () => {
  const seed = [
    '# Idea Seed: Audit Remediation',
    '',
    '## MVP Scope',
    '',
    '1. **Fix the seam** — architecture',
    `   ${fingerprintFooter(SHA_A)}`,
    `   ${semanticKeyFooter('architecture␟lib/seam.js')}`,
  ].join('\n');
  const body = '## Goal\n\nRemediate the seam.\n';

  const result = carryProvenanceFooters({ from: seed, into: body });

  assert.equal(result.carried, true);
  assert.deepEqual(result.fingerprints, [SHA_A]);
  assert.deepEqual(result.semanticKeys, ['architecture␟lib/seam.js']);
  assert.ok(
    result.body.startsWith(body),
    'the authored body must be preserved verbatim ahead of the carried footers',
  );
  assert.deepEqual(parseFingerprintFooter(result.body), [SHA_A]);
  assert.deepEqual(parseSemanticKeyFooter(result.body), [
    'architecture␟lib/seam.js',
  ]);
});

test('carryProvenanceFooters carries every group of a multi-group seed', () => {
  const seed = [
    `1. **One**`,
    `   ${fingerprintFooter(SHA_A)}`,
    `2. **Two**`,
    `   ${fingerprintFooter(SHA_B)}`,
  ].join('\n');
  const result = carryProvenanceFooters({ from: seed, into: '## Goal\n' });
  assert.deepEqual(result.fingerprints, [SHA_A, SHA_B]);
  assert.deepEqual(parseFingerprintFooter(result.body), [SHA_A, SHA_B]);
});

test('carryProvenanceFooters is idempotent — a resumed persist cannot stack footers', () => {
  const seed = `${fingerprintFooter(SHA_A)}\n${semanticKeyFooter('architecture␟lib/a.js')}`;
  const once = carryProvenanceFooters({ from: seed, into: '## Goal\n' });
  const twice = carryProvenanceFooters({ from: seed, into: once.body });

  assert.equal(twice.carried, false);
  assert.equal(
    twice.body,
    once.body,
    're-running must not append a second footer',
  );
  assert.deepEqual(parseFingerprintFooter(twice.body), [SHA_A]);
});

test('carryProvenanceFooters preserves a hand-authored fingerprint and adds the union', () => {
  const body = `## Goal\n\nhi\n\n${fingerprintFooter(SHA_C)}\n`;
  const result = carryProvenanceFooters({
    from: fingerprintFooter([SHA_A, SHA_C]),
    into: body,
  });

  assert.deepEqual(
    result.fingerprints,
    [SHA_A],
    'only the shas the body was missing are carried',
  );
  assert.deepEqual(
    parseFingerprintFooter(result.body).sort(),
    [SHA_A, SHA_C].sort(),
    'the body ends up carrying the union of both sides',
  );
});

test('carryProvenanceFooters is a no-op for a seed with no provenance', () => {
  const body = '## Goal\n\nA plain non-audit plan.\n';
  const result = carryProvenanceFooters({
    from: '# Idea Seed\n\nNo footers here.\n',
    into: body,
  });
  assert.equal(result.carried, false);
  assert.equal(result.body, body);
  assert.deepEqual(result.fingerprints, []);
  assert.deepEqual(result.semanticKeys, []);
});

test('carryProvenanceFooters tolerates absent and non-string arguments', () => {
  assert.equal(carryProvenanceFooters().carried, false);
  assert.equal(carryProvenanceFooters({ from: null, into: null }).body, '');
  assert.equal(
    carryProvenanceFooters({ from: 42, into: '## Goal\n' }).carried,
    false,
  );
});

test('extractProvenanceFooters keeps every audit footer verbatim and nothing else', () => {
  const sha = 'c'.repeat(40);
  const seed = [
    '# Seed',
    `<!-- audit-fingerprints: ${sha} -->`,
    'prose <!-- unrelated: x -->',
    '<!--audit-semantic-keys: quality␟lib/a.js -->',
    '<!-- audit-labels: audit::quality -->',
  ].join('\n');
  const out = extractProvenanceFooters(seed);
  assert.equal(
    out,
    [
      `<!-- audit-fingerprints: ${sha} -->`,
      '<!--audit-semantic-keys: quality␟lib/a.js -->',
      '<!-- audit-labels: audit::quality -->',
    ].join('\n'),
  );
  assert.deepEqual(parseFingerprintFooter(out), [sha]);
});

test('extractProvenanceFooters is empty for a non-string or footer-less seed', () => {
  assert.equal(extractProvenanceFooters(undefined), '');
  assert.equal(extractProvenanceFooters(42), '');
  assert.equal(extractProvenanceFooters('# plain seed'), '');
});

test('a Story carrying carried-through provenance dedupes on the next sweep (AC-6)', async () => {
  // End to end: the sweep plans a finding, the Story is persisted with the
  // provenance the carry copied in, and the NEXT sweep over the unchanged
  // finding recognises that Story instead of filing a duplicate.
  const finding = {
    title: 'Optional field nothing populates',
    area: 'architecture',
    primaryFile: 'lib/opts.js',
    severity: 'medium',
    labels: ['audit::architecture'],
  };
  const { full: sha } = fingerprintFinding(finding);

  const seed = `1. **Fix it**\n   ${fingerprintFooter(sha)}`;
  const persistedBody = carryProvenanceFooters({
    from: seed,
    into: '## Goal\n\nRemediate.\n',
  }).body;

  const issues = [{ number: 99, state: 'open', body: persistedBody }];
  const result = await routeFinding(finding, {
    searchIssues: async (queried) =>
      issues.filter((i) => i.body.includes(queried)),
  });

  assert.equal(
    result.decision,
    'update-existing',
    'the second sweep must recognise the planned Story, not re-file it',
  );
  assert.equal(result.matchedIssue.number, 99);
});

// ---------------------------------------------------------------------------
// Dedup attribution (Story #5045, AC-2)
//
// Confirmation admits two strengths of claim: an issue carrying the finding's
// exact FINGERPRINT owns it, while one carrying only the location-based
// SEMANTIC KEY is merely adjacent. Reading the confirmed pool flat conflated
// them, which produced two wrong routes — an arbitrary `open[0]` pick, and a
// closed owner masked by any open neighbour.
// ---------------------------------------------------------------------------

/** A finding and the two identities an Issue body can confirm it by. */
const attributedFinding = {
  title: 'Unread field nothing populates',
  area: 'architecture',
  primaryFile: 'lib/opts.js',
  severity: 'medium',
  labels: ['audit::architecture'],
};
const ATTRIBUTED_SHA = fingerprintFinding(attributedFinding).full;
const ATTRIBUTED_KEY = semanticKeyFor(attributedFinding);

/** An Issue body stamped with exactly the identities that Story owns. */
function stampedBody({ shas = [], keys = [] } = {}) {
  const parts = ['## Goal', '', 'Remediate.', ''];
  if (shas.length > 0) parts.push(fingerprintFooter(shas));
  if (keys.length > 0) parts.push(semanticKeyFooter(keys));
  return parts.join('\n');
}

/** Route through the semantic-first port with semantic-key confirmation on. */
function routeAgainst(issues) {
  return routeFinding(
    attributedFinding,
    { searchCandidates: async () => issues },
    { semanticKeyConfirm: true },
  );
}

test('a semantic key matches the OWNING open Story, never an arbitrary open[0]', async () => {
  // #201 merely shares the location; #202 carries the finding's fingerprint.
  // The search port returns the neighbour first, which is exactly how the old
  // `open[0]` pick landed on the wrong Story.
  const issues = [
    {
      number: 201,
      state: 'open',
      body: stampedBody({ keys: [ATTRIBUTED_KEY] }),
    },
    {
      number: 202,
      state: 'open',
      body: stampedBody({ shas: [ATTRIBUTED_SHA], keys: [ATTRIBUTED_KEY] }),
    },
  ];

  const result = await routeAgainst(issues);

  assert.equal(
    result.decision,
    'update-existing',
    'one owner and one neighbour is not a duplicate',
  );
  assert.equal(
    result.matchedIssue.number,
    202,
    'the issue carrying the fingerprint owns the finding',
  );
});

test('the owning open Story wins regardless of the port’s return order', async () => {
  const owner = {
    number: 202,
    state: 'open',
    body: stampedBody({ shas: [ATTRIBUTED_SHA] }),
  };
  const neighbour = {
    number: 201,
    state: 'open',
    body: stampedBody({ keys: [ATTRIBUTED_KEY] }),
  };
  for (const order of [
    [owner, neighbour],
    [neighbour, owner],
  ]) {
    const result = await routeAgainst(order);
    assert.equal(result.matchedIssue.number, 202);
    assert.equal(result.decision, 'update-existing');
  }
});

test('a key owned by a CLOSED Story routes as a regression, not skip-open', async () => {
  // The regression the flat read masked: #300 tracked this exact finding and
  // was closed; #301 is an open Story at the same location tracking something
  // else. Routing to #301 would file a genuine regression as business as usual.
  const issues = [
    {
      number: 301,
      state: 'open',
      body: stampedBody({ keys: [ATTRIBUTED_KEY] }),
    },
    {
      number: 300,
      state: 'closed',
      body: stampedBody({ shas: [ATTRIBUTED_SHA], keys: [ATTRIBUTED_KEY] }),
    },
  ];

  const result = await routeAgainst(issues);

  assert.equal(
    result.decision,
    'regression-of-closed',
    'the owning issue’s state decides the route',
  );
  assert.equal(result.matchedIssue.number, 300);
});

test('two open owners are still a duplicate, pinned deterministically', async () => {
  // A genuine duplicate — both carry the fingerprint — stays a duplicate. The
  // pin is the earliest-filed issue, not whichever the port returned first.
  const a = {
    number: 410,
    state: 'open',
    body: stampedBody({ shas: [ATTRIBUTED_SHA] }),
  };
  const b = {
    number: 405,
    state: 'open',
    body: stampedBody({ shas: [ATTRIBUTED_SHA] }),
  };
  for (const order of [
    [a, b],
    [b, a],
  ]) {
    const result = await routeAgainst(order);
    assert.equal(result.decision, 'duplicate');
    assert.equal(result.matchedIssue.number, 405);
  }
});

test('a location-only match still routes when nothing carries the fingerprint', async () => {
  // The semantic key exists to catch a reworded finding whose fingerprint has
  // drifted. Attribution must not narrow that away.
  const result = await routeAgainst([
    {
      number: 501,
      state: 'open',
      body: stampedBody({ keys: [ATTRIBUTED_KEY] }),
    },
  ]);
  assert.equal(result.decision, 'update-existing');
  assert.equal(result.matchedIssue.number, 501);
});

test('a closed location-only match is still a regression', async () => {
  const result = await routeAgainst([
    {
      number: 502,
      state: 'closed',
      body: stampedBody({ keys: [ATTRIBUTED_KEY] }),
    },
  ]);
  assert.equal(result.decision, 'regression-of-closed');
});

test('attributedPool keeps owners and drops location-only matches beside them', () => {
  const owner = {
    number: 9,
    state: 'open',
    body: stampedBody({ shas: [ATTRIBUTED_SHA] }),
  };
  const located = {
    number: 2,
    state: 'open',
    body: stampedBody({ keys: [ATTRIBUTED_KEY] }),
  };
  assert.deepEqual(
    __testing
      .attributedPool([located, owner], ATTRIBUTED_SHA)
      .map((i) => i.number),
    [9],
    'an owner outranks a neighbour regardless of input order',
  );
  // With no owner the location-only pool stands in, sorted by issue number.
  assert.deepEqual(
    __testing
      .attributedPool(
        [
          {
            number: 7,
            state: 'open',
            body: stampedBody({ keys: [ATTRIBUTED_KEY] }),
          },
          located,
        ],
        ATTRIBUTED_SHA,
      )
      .map((i) => i.number),
    [2, 7],
  );
});

// ---------------------------------------------------------------------------
// The per-Story `provenance` field (Story #5045, AC-1 support)
// ---------------------------------------------------------------------------

test('normalizeOwnedProvenance returns null for an absent field', () => {
  // `null` is what selects the recall-safe union fallback downstream — an
  // empty object would mean "this Story owns nothing" and strip its footers.
  assert.equal(normalizeOwnedProvenance(undefined), null);
  assert.equal(normalizeOwnedProvenance(null), null);
});

test('normalizeOwnedProvenance shape-checks, trims and de-duplicates', () => {
  assert.deepEqual(
    normalizeOwnedProvenance({
      fingerprints: [` ${ATTRIBUTED_SHA} `, ATTRIBUTED_SHA],
      semanticKeys: [ATTRIBUTED_KEY],
    }),
    { fingerprints: [ATTRIBUTED_SHA], semanticKeys: [ATTRIBUTED_KEY] },
  );
  assert.deepEqual(normalizeOwnedProvenance({}), {
    fingerprints: [],
    semanticKeys: [],
  });
});

test('normalizeOwnedProvenance rejects rather than silently dropping', () => {
  // A dropped identity is invisible until the NEXT sweep re-files planned
  // work, so every malformed shape fails at the validator instead.
  for (const bad of [
    'a string',
    ['an array'],
    { fingerprints: {} },
    { fingerprints: ['deadbeef'] },
    { fingerprints: [ATTRIBUTED_SHA.toUpperCase()] },
    { semanticKeys: [''] },
    { semanticKeys: ['carries,a,comma'] },
    { semanticKeys: ['carries>a>bracket'] },
    { extra: true },
  ]) {
    assert.throws(
      () => normalizeOwnedProvenance(bad, 'own-the-seam'),
      /provenance on "own-the-seam"/,
      `expected a throw for ${JSON.stringify(bad)}`,
    );
  }
});

test('ownedProvenanceSource renders a carryable footer document', () => {
  const source = ownedProvenanceSource({
    fingerprints: [ATTRIBUTED_SHA],
    semanticKeys: [ATTRIBUTED_KEY],
  });
  // The point of rendering the SAME footer vocabulary: the carry stays
  // additive, union-preserving and idempotent for an attributed plan.
  const carried = carryProvenanceFooters({
    from: source,
    into: '## Goal\n',
  });
  assert.deepEqual(parseFingerprintFooter(carried.body), [ATTRIBUTED_SHA]);
  assert.deepEqual(parseSemanticKeyFooter(carried.body), [ATTRIBUTED_KEY]);
  assert.equal(
    carryProvenanceFooters({ from: source, into: carried.body }).carried,
    false,
    're-stamping an attributed body is still a no-op',
  );
});

test('ownedProvenanceSource renders nothing for an empty or absent set', () => {
  for (const empty of [null, undefined, {}, { fingerprints: [] }]) {
    assert.equal(ownedProvenanceSource(empty), '');
    assert.equal(
      carryProvenanceFooters({
        from: ownedProvenanceSource(empty),
        into: '## Goal\n',
      }).carried,
      false,
    );
  }
});

// ---------------------------------------------------------------------------
// Story #5597 — the per-finding `audit-finding` seed record
// ---------------------------------------------------------------------------

test('auditFindingRecord round-trips sha, key, label and ordered files', () => {
  const record = {
    sha: 'd'.repeat(40),
    key: 'clean-code␟lib/a b.js',
    label: 'audit::clean-code',
    files: ['lib/a b.js', 'lib/x,y>z.js'],
  };
  const footer = auditFindingRecord(record);
  assert.match(
    footer,
    /^<!-- audit-finding: sha=d{40} key=\S+ label=\S+ files=\S+ -->$/,
  );
  assert.ok(!footer.slice(4, -3).includes('>'), 'no raw > inside the record');
  assert.deepEqual(parseAuditFindingRecords(footer), [record]);
});

test('auditFindingRecord omits an absent label and rejects a bad sha', () => {
  const footer = auditFindingRecord({ sha: 'e'.repeat(40), files: [] });
  assert.ok(!footer.includes('label='));
  assert.deepEqual(parseAuditFindingRecords(footer), [
    { sha: 'e'.repeat(40), key: '', label: null, files: [] },
  ]);
  assert.throws(() => auditFindingRecord({ sha: 'nope' }), /40-char sha1/);
});

test('parseAuditFindingRecords skips malformed records and repeats', () => {
  const sha = 'f'.repeat(40);
  const text = [
    '<!-- audit-finding: sha=short files=a.js -->',
    `<!-- audit-finding: sha=${sha} key=%E0%A4%A files=a.js -->`,
    `<!-- audit-finding: sha=${sha} key=k files=a.js -->`,
    `<!-- audit-finding: sha=${sha} key=k2 files=b.js -->`,
  ].join('\n');
  assert.deepEqual(parseAuditFindingRecords(text), [
    { sha, key: 'k', label: null, files: ['a.js'] },
  ]);
  assert.deepEqual(parseAuditFindingRecords(undefined), []);
});

test('extractProvenanceFooters carries audit-finding records verbatim', () => {
  const record = auditFindingRecord({
    sha: 'c'.repeat(40),
    key: 'quality␟lib/a.js',
    files: ['lib/a.js'],
  });
  const out = extractProvenanceFooters(`# Seed\nprose\n${record}\nmore`);
  assert.equal(out, record);
});
