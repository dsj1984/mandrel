/**
 * What an audit-seeded plan leaves behind for the next sweep: the provenance
 * footers every Story carries — since Story #5502 the ONLY cross-run dedup
 * memory — and the `audit::*` labels the dedup corpus is listed by.
 *
 * Story #5502 retired the cross-run ledger, which made footer carriage
 * load-bearing: a footer dropped on the way to persist is a finding silently
 * re-filed by the next sweep. The oversize-seed cases below pin that carriage
 * fail-closed end to end, through plan-context's real truncation.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import {
  auditFindingRecord,
  parseAuditFindingRecords,
} from '../../../.agents/scripts/lib/findings/audit-finding-record.js';
import {
  parseFingerprintFooter,
  parseSemanticKeyFooter,
} from '../../../.agents/scripts/lib/findings/route-finding.js';
import {
  buildPlanContext,
  PLAN_CONTEXT_ENVELOPE_BYTE_CEILING,
} from '../../../.agents/scripts/lib/orchestration/plan-context.js';
import {
  resolveSeedProvenance,
  withAuditLabels,
} from '../../../.agents/scripts/lib/orchestration/plan-persist/audit-provenance.js';
import { runPlanPersist } from '../../../.agents/scripts/lib/orchestration/plan-persist/run-plan-persist.js';
import {
  assemblePlanStories,
  createStoryIssues,
} from '../../../.agents/scripts/lib/orchestration/plan-persist/story-ops.js';
import { serialize } from '../../../.agents/scripts/lib/story-body/story-body.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SEED = [
  `<!-- audit-fingerprints: ${SHA_A},${SHA_B} -->`,
  '<!-- audit-semantic-keys: clean-code␟lib/a.js,performance␟lib/b.js -->',
  '<!-- audit-labels: audit::clean-code,audit::performance -->',
].join('\n');

function ticket(slug, overrides = {}) {
  return {
    slug,
    type: 'story',
    title: `Story ${slug}`,
    body: serialize({
      goal: `Goal of ${slug}.`,
      changes: [{ path: `src/${slug}.js`, assumption: 'creates' }],
      acceptance: [`${slug} works`],
      verify: ['npm test (unit)'],
      reason_to_exist: `Deliver ${slug}`,
    }),
    ...overrides,
  };
}

/** Assemble a plan the way the orchestrator does, seed included. */
function plan(tickets) {
  const { stories } = assemblePlanStories(tickets, { provenanceSource: SEED });
  return { tickets, stories };
}

describe('withAuditLabels — the corpus labels', () => {
  it('stamps the seed audit::* labels on every Story', () => {
    const { stories } = plan([ticket('a'), ticket('b')]);
    for (const story of withAuditLabels(stories, SEED)) {
      assert.ok(story.labels.includes('audit::clean-code'));
      assert.ok(story.labels.includes('audit::performance'));
    }
  });

  it('adds nothing when the seed carries no label footer', () => {
    const { stories } = assemblePlanStories([ticket('a')]);
    const [story] = withAuditLabels(stories, '');
    assert.equal(
      story.labels.some((l) => l.startsWith('audit::')),
      false,
    );
  });

  it('is idempotent — a second application adds no duplicate', () => {
    const { stories } = plan([ticket('a')]);
    const once = withAuditLabels(stories, SEED);
    const twice = withAuditLabels(once, SEED);
    const audit = twice[0].labels.filter((l) => l === 'audit::clean-code');
    assert.equal(audit.length, 1);
  });
});

describe('resolveSeedProvenance', () => {
  it('prefers the carried seed.provenance over the seed text', () => {
    const envelope = { seed: { content: 'no footers here', provenance: SEED } };
    assert.equal(resolveSeedProvenance(envelope), SEED);
  });

  it('falls back to an untruncated seed text', () => {
    assert.equal(resolveSeedProvenance({ seed: { content: SEED } }), SEED);
  });

  it('is empty for a --tickets run with no envelope seed', () => {
    assert.equal(resolveSeedProvenance(null), '');
    assert.equal(resolveSeedProvenance({ seed: { text: 'chat' } }), '');
  });

  it('refuses a truncated seed whose footers were not carried', () => {
    const envelope = {
      seed: { content: SEED.slice(0, 20) },
      truncated: [{ field: 'seed', note: '.content cut to a prefix' }],
    };
    assert.throws(
      () => resolveSeedProvenance(envelope),
      /truncated the seed and carries no seed\.provenance.*No Issue was created/s,
    );
  });
});

// ---------------------------------------------------------------------------
// AC-5 — an audit seed large enough for plan-context to truncate.
// ---------------------------------------------------------------------------

const GROUPS = 125;
const shaFor = (i) => i.toString(16).padStart(40, '0');

/**
 * A seed shaped like a real oversize `/audit-to-stories --emit-plan-seed`
 * output: one footer group per finding group, interleaved with prose, well
 * past the envelope ceiling so the tail groups sit after the cut.
 */
function oversizeAuditSeed({ records = false } = {}) {
  const filler =
    'Evidence and remediation prose for this finding group. '.repeat(
      Math.ceil((PLAN_CONTEXT_ENVELOPE_BYTE_CEILING * 1.5) / GROUPS / 55),
    );
  const parts = ['# Audit seed\n'];
  for (let i = 1; i <= GROUPS; i += 1) {
    parts.push(
      `## Group ${i}\n\n${filler}\n`,
      `<!-- audit-fingerprints: ${shaFor(i)} -->`,
      `<!-- audit-semantic-keys: clean-code␟lib/g${i}.js -->`,
      '<!-- audit-labels: audit::clean-code -->\n',
      ...(records
        ? [
            `${auditFindingRecord({
              sha: shaFor(i),
              key: `clean-code␟lib/g${i}.js`,
              label: 'audit::clean-code',
              files: [`lib/g${i}.js`],
            })}\n`,
          ]
        : []),
    );
  }
  return parts.join('\n');
}

function envelopeProvider() {
  return {
    getEpic: async (id) => ({ id, title: 'Epic', body: '' }),
    getTicket: async (id) => ({
      id,
      number: id,
      title: 'T',
      body: '',
      labels: [],
    }),
    getTickets: async () => [],
    listIssuesByLabel: async () => [],
    getTicketComments: async () => [],
  };
}

async function oversizeEnvelope(seedOpts) {
  return buildPlanContext({
    mode: 'seed-file',
    seedFileContent: oversizeAuditSeed(seedOpts),
    seedFilePath: 'temp/audit-seed.md',
    provider: envelopeProvider(),
    config: { github: { owner: 'o', repo: 'r' } },
    settings: {},
  });
}

describe('AC-5: footer carriage survives a truncated audit seed', () => {
  it('plan-context cuts the seed text but carries every footer apart from it', async () => {
    const env = await oversizeEnvelope();
    assert.ok(
      (env.truncated ?? []).some((t) => t.field === 'seed'),
      'precondition: the seed really was truncated',
    );
    assert.ok(
      parseFingerprintFooter(env.seed.content).length < GROUPS,
      'precondition: the cut seed text lost footer groups',
    );
    assert.equal(parseFingerprintFooter(env.seed.provenance).length, GROUPS);
  });

  it('carries every per-finding record through seed.provenance', async () => {
    const env = await oversizeEnvelope({ records: true });
    assert.ok(
      parseAuditFindingRecords(env.seed.content).length < GROUPS,
      'precondition: the cut seed text lost records',
    );
    const records = parseAuditFindingRecords(resolveSeedProvenance(env));
    assert.equal(records.length, GROUPS);
    assert.deepEqual(records.at(-1).files, [`lib/g${GROUPS}.js`]);
  });

  it('every seed footer reaches the persisted Story bodies', async () => {
    const env = await oversizeEnvelope();
    const provenanceSource = resolveSeedProvenance(env);
    const { stories } = assemblePlanStories([ticket('a'), ticket('b')], {
      provenanceSource,
    });
    const posted = [];
    await createStoryIssues({
      provider: {
        createIssue: async (payload) => {
          posted.push(payload.body);
          return { id: 300 + posted.length };
        },
      },
      stories: withAuditLabels(stories, provenanceSource),
    });
    assert.equal(posted.length, 2);
    for (const body of posted) {
      const carried = new Set(parseFingerprintFooter(body));
      for (let i = 1; i <= GROUPS; i += 1) {
        assert.ok(carried.has(shaFor(i)), `group ${i} footer dropped`);
      }
    }
  });

  it('persist refuses a truncated envelope without carried footers, before any create', async () => {
    const env = await oversizeEnvelope();
    const { provenance: _dropped, ...seed } = env.seed;
    let creates = 0;
    await assert.rejects(
      () =>
        runPlanPersist({
          provider: {
            createIssue: async () => {
              creates += 1;
              return { id: 1 };
            },
          },
          artifacts: {
            stories: [ticket('a')],
            planContextEnvelope: { ...env, seed },
          },
          opts: { dryRun: true, skipCleanup: true },
        }),
      /truncated the seed and carries no seed\.provenance/,
    );
    assert.equal(creates, 0, 'no Issue was created');
  });

  it('writes no ledger file', () => {
    assert.equal(fs.existsSync('baselines/audit-ledger.json'), false);
  });
});

// ---------------------------------------------------------------------------
// Story #5597 — N>1 plans attribute each finding to the Stories covering it
// ---------------------------------------------------------------------------

const SHA_ONE = '1'.repeat(40);
const SHA_TWO = '2'.repeat(40);
const SHA_THREE = '3'.repeat(40);
const KEY_ONE = 'clean-code␟a/one.js';
const KEY_TWO = 'performance␟b/two.js';
const KEY_THREE = 'security␟c/three.js';

/** A record-carrying seed, shaped like `buildPlanSeedMarkdown`'s footers. */
function recordSeed({ unattributed = false } = {}) {
  const ids = [
    [SHA_ONE, KEY_ONE, 'audit::clean-code', ['a/one.js']],
    [SHA_TWO, KEY_TWO, 'audit::performance', ['b/two.js']],
    ...(unattributed
      ? [[SHA_THREE, KEY_THREE, 'audit::security', ['c/three.js']]]
      : []),
  ];
  return [
    `<!-- audit-fingerprints: ${ids.map(([sha]) => sha).join(',')} -->`,
    `<!-- audit-semantic-keys: ${ids.map(([, key]) => key).join(',')} -->`,
    `<!-- audit-labels: ${ids.map(([, , label]) => label).join(',')} -->`,
    ...ids.map(([sha, key, label, files]) =>
      auditFindingRecord({ sha, key, label, files }),
    ),
  ].join('\n');
}

function storyOver(slug, paths, overrides = {}) {
  return ticket(slug, {
    body: serialize({
      goal: `Goal of ${slug}.`,
      changes: paths.map((path) => ({
        path,
        assumption: 'refactors-existing',
      })),
      acceptance: [`${slug} works`],
      verify: ['npm test (unit)'],
      reason_to_exist: `Deliver ${slug}`,
    }),
    ...overrides,
  });
}

function persistAttributed(tickets, seed) {
  const { stories, warnings } = assemblePlanStories(tickets, {
    provenanceSource: seed,
  });
  return { stories: withAuditLabels(stories, seed), warnings };
}

const auditLabels = (story) =>
  story.labels.filter((l) => l.startsWith('audit::')).sort();

describe('Story #5597: per-Story attribution of an audit seed', () => {
  it('AC-1: each Story carries only the finding its changes[] cover', () => {
    const { stories, warnings } = persistAttributed(
      [storyOver('one', ['a/one.js']), storyOver('two', ['b/**'])],
      recordSeed(),
    );
    const bySlug = Object.fromEntries(stories.map((s) => [s.slug, s]));
    assert.deepEqual(parseFingerprintFooter(bySlug.one.body), [SHA_ONE]);
    assert.deepEqual(parseSemanticKeyFooter(bySlug.one.body), [KEY_ONE]);
    assert.deepEqual(auditLabels(bySlug.one), ['audit::clean-code']);
    assert.deepEqual(parseFingerprintFooter(bySlug.two.body), [SHA_TWO]);
    assert.deepEqual(parseSemanticKeyFooter(bySlug.two.body), [KEY_TWO]);
    assert.deepEqual(auditLabels(bySlug.two), ['audit::performance']);
    assert.deepEqual(warnings, []);
    for (const story of stories) {
      assert.ok(!story.body.includes('audit-finding'), 'record is seed-only');
    }
  });

  it('a finding covered by several Stories is stamped on each', () => {
    const { stories } = persistAttributed(
      [
        storyOver('one', ['a/one.js']),
        storyOver('both', ['a/*.js', 'b/two.js']),
      ],
      recordSeed(),
    );
    const both = stories.find((s) => s.slug === 'both');
    assert.deepEqual(parseFingerprintFooter(both.body).sort(), [
      SHA_ONE,
      SHA_TWO,
    ]);
  });

  it('secondary files attribute only when no Story covers the primary', () => {
    const seed = [
      `<!-- audit-fingerprints: ${SHA_ONE} -->`,
      auditFindingRecord({
        sha: SHA_ONE,
        key: KEY_ONE,
        label: 'audit::clean-code',
        files: ['a/one.js', 'b/two.js'],
      }),
    ].join('\n');
    const covered = persistAttributed(
      [storyOver('one', ['a/one.js']), storyOver('two', ['b/two.js'])],
      seed,
    ).stories;
    assert.deepEqual(
      covered.map((s) => parseFingerprintFooter(s.body)),
      [[SHA_ONE], []],
    );
    const fallback = persistAttributed(
      [storyOver('x', ['z/x.js']), storyOver('two', ['b/two.js'])],
      seed,
    ).stories;
    assert.deepEqual(
      fallback.map((s) => parseFingerprintFooter(s.body)),
      [[], [SHA_ONE]],
    );
  });

  it('AC-2: an uncovered finding rides on every Story and is warned', () => {
    const { stories, warnings } = persistAttributed(
      [storyOver('one', ['a/one.js']), storyOver('two', ['b/two.js'])],
      recordSeed({ unattributed: true }),
    );
    for (const story of stories) {
      assert.ok(parseFingerprintFooter(story.body).includes(SHA_THREE));
      assert.ok(parseSemanticKeyFooter(story.body).includes(KEY_THREE));
      assert.ok(story.labels.includes('audit::security'));
    }
    assert.deepEqual(warnings, [
      `unattributed audit finding ${SHA_THREE.slice(0, 12)} (c/three.js) — carried on all 2 Stories`,
    ]);
  });

  it('AC-2: runPlanPersist reports the unattributed finding in its warnings', async () => {
    // Real paths: persist cross-validates `refactors-existing` against main.
    const real = (slug, path) => {
      const acceptance = [`${slug} works`];
      const verify = ['npm test'];
      return {
        slug,
        type: 'story',
        title: `Story ${slug}`,
        acceptance,
        verify,
        body: serialize({
          goal: `Goal of ${slug}.`,
          changes: [{ path, assumption: 'refactors-existing' }],
          acceptance,
          verify,
        }),
      };
    };
    let id = 8800;
    const result = await runPlanPersist({
      provider: {
        createIssue: async () => ({ id: id++ }),
        getTicket: async (n) => ({ id: n, state: 'open', labels: [] }),
        listIssuesByLabel: async () => [],
        updateTicket: async () => {},
        getTicketComments: async () => [],
        postComment: async () => ({ id: 1 }),
      },
      artifacts: {
        stories: [
          real('one', 'tests/scripts/plan-persist.flat-stories.test.js'),
          real('two', 'tests/scripts/plan-persist.summary.test.js'),
        ],
        planContextEnvelope: {
          seed: { provenance: recordSeed({ unattributed: true }) },
        },
      },
      config: { project: { paths: { tempRoot: makeTempDir('attrib-') } } },
      opts: { dryRun: true, skipCleanup: true },
    });
    assert.ok(
      result.warnings.some((w) =>
        w.startsWith(
          `unattributed audit finding ${SHA_THREE.slice(0, 12)} (c/three.js)`,
        ),
      ),
      JSON.stringify(result.warnings),
    );
  });

  it('AC-3: an N==1 plan keeps the union footers and labels', () => {
    const seed = recordSeed();
    const { stories, warnings } = persistAttributed(
      [storyOver('one', ['a/one.js'])],
      seed,
    );
    assert.deepEqual(parseFingerprintFooter(stories[0].body), [
      SHA_ONE,
      SHA_TWO,
    ]);
    assert.deepEqual(auditLabels(stories[0]), [
      'audit::clean-code',
      'audit::performance',
    ]);
    assert.deepEqual(warnings, []);
  });

  it('AC-3: an N>1 plan over a record-less seed keeps the union', () => {
    const seed = recordSeed()
      .split('\n')
      .filter((l) => !l.includes('audit-finding'))
      .join('\n');
    const { stories } = persistAttributed(
      [storyOver('one', ['a/one.js']), storyOver('two', ['b/two.js'])],
      seed,
    );
    for (const story of stories) {
      assert.deepEqual(parseFingerprintFooter(story.body), [SHA_ONE, SHA_TWO]);
      assert.deepEqual(parseSemanticKeyFooter(story.body), [KEY_ONE, KEY_TWO]);
      assert.deepEqual(auditLabels(story), [
        'audit::clean-code',
        'audit::performance',
      ]);
    }
  });

  it('AC-4: an authored provenance overrides path attribution', () => {
    const { stories } = persistAttributed(
      [
        storyOver('one', ['a/one.js'], {
          provenance: { fingerprints: [SHA_TWO], semanticKeys: [KEY_TWO] },
        }),
        storyOver('two', ['b/two.js']),
      ],
      recordSeed(),
    );
    const [one, two] = stories;
    assert.deepEqual(parseFingerprintFooter(one.body), [SHA_TWO]);
    assert.deepEqual(parseSemanticKeyFooter(one.body), [KEY_TWO]);
    assert.deepEqual(auditLabels(one), ['audit::performance']);
    // SHA_ONE is covered only by the authored Story, so it is unattributed
    // and rides on the non-authored one.
    assert.deepEqual(parseFingerprintFooter(two.body).sort(), [
      SHA_ONE,
      SHA_TWO,
    ]);
  });

  it('an authored sha outside the seed records widens to the union labels', () => {
    const outside = '9'.repeat(40);
    const { stories } = persistAttributed(
      [
        storyOver('one', ['a/one.js'], {
          provenance: { fingerprints: [outside] },
        }),
        storyOver('two', ['b/two.js']),
      ],
      recordSeed(),
    );
    assert.deepEqual(auditLabels(stories[0]), [
      'audit::clean-code',
      'audit::performance',
    ]);
  });
});
