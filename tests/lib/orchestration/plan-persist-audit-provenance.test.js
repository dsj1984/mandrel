/**
 * Story #5307 — what an audit-seeded plan leaves behind for the next sweep.
 *
 * Two halves, both driven from the persist orchestrator: the `audit::*` labels
 * the dedup corpus is listed by, and the cross-run ledger record of what this
 * run filed. Together they close the gap that made a chained-path Story
 * invisible to the sweep that proposed it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  recordAuditFilings,
  withAuditLabels,
} from '../../../.agents/scripts/lib/orchestration/plan-persist/audit-provenance.js';
import { assemblePlanStories } from '../../../.agents/scripts/lib/orchestration/plan-persist/story-ops.js';
import { serialize } from '../../../.agents/scripts/lib/story-body/story-body.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SEED = [
  `<!-- audit-fingerprints: ${SHA_A},${SHA_B} -->`,
  '<!-- audit-semantic-keys: clean-code␟lib/a.js,performance␟lib/b.js -->',
  '<!-- audit-labels: audit::clean-code,audit::performance -->',
].join('\n');

const quietLogger = { warn: () => {} };

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

/** Persist receipts for an assembled plan, numbered from 701. */
function receipts(stories) {
  return stories.map((s, i) => ({ slug: s.slug, id: 701 + i }));
}

function withTempLedger(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-provenance-'));
  try {
    return run(path.join(dir, 'audit-ledger.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('recordAuditFilings — the ledger record', () => {
  it('records each attributed Story against its own issue number', () => {
    withTempLedger((ledgerPath) => {
      const { tickets, stories } = plan([
        ticket('a', { provenance: { fingerprints: [SHA_A] } }),
        ticket('b', { provenance: { fingerprints: [SHA_B] } }),
      ]);
      const result = recordAuditFilings({
        stories,
        created: receipts(stories),
        tickets,
        ledgerPath,
        logger: quietLogger,
      });

      assert.equal(result.recorded, 2);
      const byFp = new Map(
        JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).entries.map((e) => [
          e.fingerprint,
          e,
        ]),
      );
      assert.equal(byFp.get(SHA_A).status, 'filed');
      assert.equal(byFp.get(SHA_A).issue.number, 701);
      assert.equal(byFp.get(SHA_B).issue.number, 702, 'each owns its own');
    });
  });

  it('records NOTHING when the seed carried footers but no Story attributed them', () => {
    withTempLedger((ledgerPath) => {
      const warnings = [];
      const { tickets, stories } = plan([ticket('a'), ticket('b')]);
      const result = recordAuditFilings({
        stories,
        created: receipts(stories),
        tickets,
        ledgerPath,
        logger: { warn: (m) => warnings.push(m) },
      });

      assert.equal(result.recorded, 0);
      assert.ok(result.ambiguous > 0);
      assert.equal(
        fs.existsSync(ledgerPath),
        false,
        'a coin-flip binding is worse than none — nothing is written',
      );
      assert.ok(
        warnings.some((w) => /ambiguous/.test(w)),
        'the cost is named on stderr, never silent',
      );
    });
  });

  it('writes no ledger at all for a plan carrying no provenance', () => {
    withTempLedger((ledgerPath) => {
      const { stories } = assemblePlanStories([ticket('a')]);
      const result = recordAuditFilings({
        stories,
        created: receipts(stories),
        tickets: [ticket('a')],
        ledgerPath,
        logger: quietLogger,
      });
      assert.equal(result.recorded, 0);
      assert.equal(result.ambiguous, 0);
      assert.equal(fs.existsSync(ledgerPath), false);
    });
  });

  it('is idempotent: a re-run records one entry per fingerprint, not two', () => {
    withTempLedger((ledgerPath) => {
      for (const _ of [1, 2]) {
        const { tickets, stories } = plan([
          ticket('a', { provenance: { fingerprints: [SHA_A] } }),
        ]);
        recordAuditFilings({
          stories,
          created: receipts(stories),
          tickets,
          ledgerPath,
          logger: quietLogger,
        });
      }
      const entries = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).entries;
      assert.equal(entries.length, 1);
      assert.equal(entries[0].fingerprint, SHA_A);
    });
  });

  it('never resurrects a finding whose Issue was closed', () => {
    withTempLedger((ledgerPath) => {
      fs.writeFileSync(
        ledgerPath,
        JSON.stringify({
          entries: [
            {
              fingerprint: SHA_A,
              semanticKey: 'clean-code␟lib/a.js',
              status: 'accepted-risk',
              issue: {
                number: 11,
                state: 'closed',
                stateReason: 'not_planned',
              },
            },
          ],
        }),
      );
      const { tickets, stories } = plan([
        ticket('a', { provenance: { fingerprints: [SHA_A] } }),
      ]);
      recordAuditFilings({
        stories,
        created: receipts(stories),
        tickets,
        ledgerPath,
        logger: quietLogger,
      });
      const entry = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).entries[0];
      assert.equal(entry.status, 'accepted-risk', 'the close still outranks');
      assert.equal(entry.issue.number, 11);
    });
  });
});

describe('recordAuditFilings — the dry-run contract', () => {
  it('records nothing and writes nothing under --dry-run', () => {
    withTempLedger((ledgerPath) => {
      const { tickets, stories } = plan([
        ticket('a', { provenance: { fingerprints: [SHA_A] } }),
      ]);
      const result = recordAuditFilings({
        stories,
        created: receipts(stories),
        tickets,
        ledgerPath,
        logger: quietLogger,
        dryRun: true,
      });
      assert.deepEqual(result, { recorded: 0, ambiguous: 0 });
      assert.equal(fs.existsSync(ledgerPath), false);
    });
  });

  it('skips a Story the create pass never opened', () => {
    withTempLedger((ledgerPath) => {
      const { tickets, stories } = plan([
        ticket('a', { provenance: { fingerprints: [SHA_A] } }),
      ]);
      const result = recordAuditFilings({
        stories,
        created: [],
        tickets,
        ledgerPath,
        logger: quietLogger,
      });
      assert.equal(result.recorded, 0);
      assert.equal(fs.existsSync(ledgerPath), false);
    });
  });
});

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
