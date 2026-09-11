/**
 * Story #5300 — the CI-gap intake filer.
 *
 * These pin the four behaviours the prose-only predecessor could not have:
 * a closed verdict set, occurrence-accumulating dedup, an unroutable bucket
 * that says so, and a refused cross-repo write that degrades out loud.
 *
 * Every port is a stub — the module performs no I/O of its own, which is the
 * property that lets the whole filing path be exercised without a tracker.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fingerprintFooter } from '../../../.agents/scripts/lib/findings/route-finding.js';
import {
  appendOccurrence,
  assertIntakeVerdict,
  buildIntakeFinding,
  CI_GAP_INTAKE_MARKER,
  fileCiGapIntake,
  INTAKE_VERDICTS,
  normaliseSignature,
  REFUSED_VERDICT,
} from '../../../.agents/scripts/lib/orchestration/ci-gap-intake.js';

const DIGEST = Object.freeze({
  storyId: 5300,
  prNumber: 42,
  headSha: 'abc123def4567890abc123def4567890abc123de',
  failingCheck: 'Launch-journey e2e canary',
  runId: 34553187641,
  runUrl: 'https://github.com/acme/product/actions/runs/34553187641',
  classification: 'test',
  logTail:
    '\nError: page.goto: net::ERR_ABORTED; maybe frame was detached?\n  at signInReturningGuardian (e2e/support/auth.ts:321)\n',
});

const CURRENT = Object.freeze({ owner: 'acme', repo: 'product' });

/** Repos map with every bucket resolvable. */
const REPOS_ALL = Object.freeze({
  consumer: CURRENT,
  framework: { owner: 'dsj1984', repo: 'mandrel' },
  platform: { owner: 'acme', repo: 'platform' },
});

/** Repos map with no platform bucket configured — the unroutable case. */
const REPOS_NO_PLATFORM = Object.freeze({
  consumer: CURRENT,
  framework: { owner: 'dsj1984', repo: 'mandrel' },
  platform: null,
});

/** Ports that record calls and report success. */
function makePorts({ hits = [], createResult, updateResult } = {}) {
  const calls = { search: [], create: [], update: [] };
  return {
    calls,
    ports: {
      searchIssues: async (query) => {
        calls.search.push(query);
        return hits;
      },
      createIssue: async (args) => {
        calls.create.push(args);
        return (
          createResult ?? {
            url: 'https://github.com/acme/product/issues/7',
            number: 7,
            error: null,
          }
        );
      },
      updateIssue: async (args) => {
        calls.update.push(args);
        return updateResult ?? { url: null, error: null };
      },
    },
  };
}

const BASE = {
  digest: DIGEST,
  repos: REPOS_ALL,
  currentRepo: CURRENT,
  prNumber: 42,
  now: '2026-09-11T12:00:00.000Z',
};

describe('ci-gap-intake — verdict set (AC-2)', () => {
  it('accepts exactly the three Option-2 verdicts', () => {
    for (const verdict of INTAKE_VERDICTS) {
      assert.equal(assertIntakeVerdict(verdict), verdict);
    }
    assert.deepEqual(
      [...INTAKE_VERDICTS],
      ['pre-existing', 'capacity', 'unreproducible-tier'],
      'the set must mirror .agents/rules/ci-remediation.md, not extend it',
    );
  });

  it('refuses defect-in-diff by name, pointing at Option 1', async () => {
    assert.throws(() => assertIntakeVerdict(REFUSED_VERDICT), /Option 1/);
    await assert.rejects(
      fileCiGapIntake({
        ...BASE,
        verdict: REFUSED_VERDICT,
        bucket: 'consumer',
        ports: makePorts().ports,
      }),
      /Option 1/,
    );
  });

  it('refuses an unknown verdict rather than defaulting to one', () => {
    assert.throws(() => assertIntakeVerdict('flaky'), /unknown verdict/);
  });

  it('refuses an unknown ownership bucket', async () => {
    await assert.rejects(
      fileCiGapIntake({
        ...BASE,
        verdict: 'capacity',
        bucket: 'somewhere-else',
        ports: makePorts().ports,
      }),
      /unknown ownership bucket/,
    );
  });
});

describe('ci-gap-intake — body and labels (AC-1)', () => {
  it('files a graduatable, fingerprinted intake issue', async () => {
    const { ports, calls } = makePorts();
    const res = await fileCiGapIntake({
      ...BASE,
      verdict: 'capacity',
      bucket: 'platform',
      evidence: 'load average 51.58 on 18 cores; no swarm-os work running',
      ports,
    });

    assert.equal(res.decision, 'new');
    assert.deepEqual(res.labels, ['meta::platform-gap', 'friction::capacity']);
    for (const section of [
      CI_GAP_INTAKE_MARKER,
      '## Signature',
      '## Verdict',
      '## Routing',
      '## Occurrences',
    ]) {
      assert.ok(res.body.includes(section), `body must carry ${section}`);
    }
    assert.ok(
      res.body.includes(fingerprintFooter([res.fingerprint])),
      'body must carry the fingerprint footer future runs dedup against',
    );
    // The evidence is the verdict's proof obligation — it must reach the body.
    assert.match(res.body, /load average 51\.58/);
    assert.match(
      res.body,
      /mandrel-plan/,
      'body must name the graduation step',
    );
    assert.equal(calls.create[0].owner, 'acme');
    assert.equal(calls.create[0].repo, 'platform');
  });

  it('marks an unproven verdict rather than rendering an empty proof line', async () => {
    const { ports } = makePorts();
    const res = await fileCiGapIntake({
      ...BASE,
      verdict: 'capacity',
      bucket: 'framework',
      evidence: '   ',
      ports,
    });
    assert.match(res.body, /unproven/);
  });

  it('normalises run-specific noise out of the dedup identity', () => {
    const a = normaliseSignature(
      'timeout after 15000ms at 2026-09-11T10:00:00Z on port :61512 (sha deadbeefcafe)',
    );
    const b = normaliseSignature(
      'timeout after 20000ms at 2026-09-12T11:30:00Z on port :49221 (sha feedfacebeef)',
    );
    assert.equal(a, b, 'two occurrences of one defect must fingerprint alike');
  });

  it('keeps two verdicts over one signature distinct', () => {
    const capacity = buildIntakeFinding({
      digest: DIGEST,
      verdict: 'capacity',
      bucket: 'platform',
    });
    const preExisting = buildIntakeFinding({
      digest: DIGEST,
      verdict: 'pre-existing',
      bucket: 'platform',
    });
    assert.notEqual(capacity.area, preExisting.area);
  });
});

describe('ci-gap-intake — recurrence (AC-3)', () => {
  it('updates the existing issue and appends exactly one occurrence row', async () => {
    // Seed an open issue carrying the fingerprint this filing will compute.
    const finding = buildIntakeFinding({
      digest: DIGEST,
      verdict: 'capacity',
      bucket: 'platform',
    });
    const probe = await fileCiGapIntake({
      ...BASE,
      verdict: 'capacity',
      bucket: 'platform',
      ports: makePorts().ports,
    });
    assert.ok(finding.area);

    const existingBody = probe.body;
    const before = existingBody
      .split('\n')
      .filter((l) => l.startsWith('| 20')).length;

    const { ports, calls } = makePorts({
      hits: [
        {
          number: 7,
          state: 'open',
          title: 'CI gap (capacity)',
          body: existingBody,
          url: 'https://github.com/acme/platform/issues/7',
        },
      ],
    });
    const res = await fileCiGapIntake({
      ...BASE,
      verdict: 'capacity',
      bucket: 'platform',
      ports,
      now: '2026-09-18T09:00:00.000Z',
    });

    assert.equal(res.decision, 'update-existing');
    assert.equal(
      calls.create.length,
      0,
      'a recurrence must never mint an issue',
    );
    assert.equal(calls.update.length, 1);
    assert.equal(res.issue.number, 7);

    const after = res.body
      .split('\n')
      .filter((l) => l.startsWith('| 20')).length;
    assert.equal(after, before + 1, 'exactly one new occurrence row');
    assert.match(res.body, /2026-09-18T09:00:00\.000Z/);
    assert.match(res.body, /34553187641/, 'the row carries the run link');
    assert.match(res.body, /abc123def456/, 'the row carries the head SHA');
  });

  it('grafts a table onto a body an operator has rewritten', () => {
    const grafted = appendOccurrence('Someone rewrote this by hand.', {
      at: '2026-09-18T09:00:00.000Z',
      runUrl: null,
      headSha: null,
      prNumber: null,
    });
    assert.match(grafted, /## Occurrences/);
    assert.match(grafted, /2026-09-18/);
  });

  it('stops rather than guessing `new` when the dedup lookup fails', async () => {
    const res = await fileCiGapIntake({
      ...BASE,
      verdict: 'capacity',
      bucket: 'platform',
      ports: {
        searchIssues: async () => {
          throw new Error('search index unavailable');
        },
        createIssue: async () => assert.fail('must not file on a blind lookup'),
        updateIssue: async () =>
          assert.fail('must not update on a blind lookup'),
      },
    });
    assert.equal(res.decision, 'lookup-failed');
    assert.match(res.errors[0], /search index unavailable/);
  });
});

describe('ci-gap-intake — unroutable bucket (AC-4)', () => {
  it('files locally and names the missing key in the body and on stderr', async () => {
    const warnings = [];
    const { ports, calls } = makePorts();
    const res = await fileCiGapIntake({
      ...BASE,
      verdict: 'capacity',
      bucket: 'platform',
      repos: REPOS_NO_PLATFORM,
      ports,
      logger: { warn: (m) => warnings.push(m) },
    });

    assert.equal(res.routing.routable, false);
    assert.equal(res.routing.missingKey, 'github.followUpRepos.platform');
    assert.match(res.body, /unroutable/);
    assert.match(res.body, /github\.followUpRepos\.platform/);
    assert.equal(calls.create[0].owner, 'acme');
    assert.equal(calls.create[0].repo, 'product', 'filed where the run stands');
    assert.ok(
      warnings.some((w) => w.includes('github.followUpRepos.platform')),
      'the operator must be told which key would fix the routing',
    );
  });

  it('still labels the filing by its owner, not by where it landed', async () => {
    const { ports } = makePorts();
    const res = await fileCiGapIntake({
      ...BASE,
      verdict: 'capacity',
      bucket: 'platform',
      repos: REPOS_NO_PLATFORM,
      ports,
    });
    assert.ok(res.labels.includes('meta::platform-gap'));
  });
});

describe('ci-gap-intake — refused cross-repo write (AC-5)', () => {
  it('degrades to a local filing that records the deferral', async () => {
    const warnings = [];
    let attempt = 0;
    const create = [];
    const res = await fileCiGapIntake({
      ...BASE,
      verdict: 'pre-existing',
      bucket: 'framework',
      ports: {
        searchIssues: async () => [],
        createIssue: async (args) => {
          create.push(args);
          attempt += 1;
          return attempt === 1
            ? {
                url: null,
                number: null,
                error: 'HTTP 403: Resource not accessible by integration',
              }
            : {
                url: 'https://github.com/acme/product/issues/9',
                number: 9,
                error: null,
              };
        },
        updateIssue: async () => ({ url: null, error: null }),
      },
      logger: { warn: (m) => warnings.push(m) },
    });

    assert.equal(res.decision, 'new');
    assert.equal(create.length, 2, 'attempt the routed repo, then degrade');
    assert.equal(create[0].repo, 'mandrel');
    assert.equal(create[1].repo, 'product');
    assert.match(res.body, /deferred to dsj1984\/mandrel/);
    assert.match(res.body, /Resource not accessible by integration/);
    assert.equal(res.errors.length, 0, 'a handled deferral is not an error');
    assert.ok(warnings.some((w) => w.includes('refused')));
  });

  it('reports a local create failure rather than claiming success', async () => {
    const res = await fileCiGapIntake({
      ...BASE,
      verdict: 'pre-existing',
      bucket: 'consumer',
      ports: {
        searchIssues: async () => [],
        createIssue: async () => ({ url: null, error: 'gh exited 1' }),
        updateIssue: async () => ({ url: null, error: null }),
      },
    });
    assert.equal(res.decision, 'create-failed');
    assert.match(res.errors[0], /gh exited 1/);
  });
});

describe('ci-gap-intake — dry run', () => {
  it('composes the filing and writes nothing', async () => {
    const { ports, calls } = makePorts();
    const res = await fileCiGapIntake({
      ...BASE,
      verdict: 'unreproducible-tier',
      bucket: 'framework',
      dryRun: true,
      ports,
    });
    assert.equal(res.dryRun, true);
    assert.equal(calls.create.length, 0);
    assert.equal(calls.update.length, 0);
    assert.ok(res.body.includes(CI_GAP_INTAKE_MARKER));
  });
});
