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
import { parseFingerprintFooter } from '../../../.agents/scripts/lib/findings/route-finding.js';
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
function oversizeAuditSeed() {
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

async function oversizeEnvelope() {
  return buildPlanContext({
    mode: 'seed-file',
    seedFileContent: oversizeAuditSeed(),
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
