/**
 * Story #5300 — the `file-ci-gap.js` command surface.
 *
 * Two halves:
 *
 *   1. **The command contract**, exercised by spawning the real CLI: it
 *      answers `--help` on stdout, and it refuses to file when the CI digest
 *      the verdict's evidence comes from is absent.
 *   2. **The command's behaviour**, exercised in-process through
 *      `runFileCiGap` with an explicit ctx bag of stubs — the seam ADR
 *      20260502-960a mandates, so the whole path runs with no tracker and no
 *      network rather than being shaped around a test-only env branch.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  renderFrictionComment,
  runFileCiGap,
} from '../../.agents/scripts/file-ci-gap.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const CLI = path.join(REPO_ROOT, '.agents', 'scripts', 'file-ci-gap.js');

const DIGEST = Object.freeze({
  storyId: 5300,
  prNumber: 42,
  headSha: 'abc123def4567890abc123def4567890abc123de',
  failingCheck: 'Launch-journey e2e canary',
  runId: 34553187641,
  runUrl: 'https://github.com/acme/product/actions/runs/34553187641',
  classification: 'test',
  logTail: 'Error: page.goto: net::ERR_ABORTED; maybe frame was detached?\n',
});

const CONFIG = Object.freeze({
  github: {
    owner: 'acme',
    repo: 'product',
    followUpRepos: { framework: 'dsj1984/mandrel', platform: 'acme/platform' },
  },
});

/** Ports that report a clean `new` filing. */
function stubPorts(overrides = {}) {
  return {
    searchIssues: async () => [],
    createIssue: async () => ({
      url: 'https://github.com/acme/platform/issues/11',
      number: 11,
      error: null,
    }),
    updateIssue: async () => ({ url: null, error: null }),
    ...overrides,
  };
}

/** A ticketing provider stub recording comments and label writes. */
function stubProvider() {
  const posted = [];
  const labelWrites = [];
  return {
    posted,
    labelWrites,
    getTicketComments: async () => [],
    // The provider takes a `{ type, body }` payload; flatten it so the
    // assertions read the rendered comment rather than its envelope.
    postComment: async (ticketId, payload) => {
      posted.push({
        ticketId,
        type: payload?.type ?? null,
        body: typeof payload === 'string' ? payload : (payload?.body ?? ''),
      });
    },
    getTicket: async () => ({ number: 5300, labels: ['agent::closing'] }),
    updateTicket: async (ticketId, patch) => {
      labelWrites.push({ ticketId, patch });
    },
  };
}

const BASE = {
  storyId: 5300,
  config: CONFIG,
  digest: DIGEST,
  now: '2026-09-11T12:00:00.000Z',
  logger: { warn() {}, info() {}, error() {} },
};

describe('file-ci-gap CLI — command contract (AC-11)', () => {
  it('answers --help on stdout and exits 0', () => {
    const res = spawnSync(process.execPath, [CLI, '--help'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    assert.equal(res.status, 0);
    assert.ok(res.stdout.trim().length > 0, '--help must write to stdout');
    assert.match(res.stdout, /--verdict/);
    assert.match(res.stdout, /--owner/);
    assert.match(res.stdout, /mandrel-plan/, 'help names the graduation step');
  });

  it('refuses to file when no CI digest exists for the Story', () => {
    const res = spawnSync(
      process.execPath,
      [
        CLI,
        '--story',
        '999999',
        '--verdict',
        'capacity',
        '--owner',
        'platform',
      ],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    assert.notEqual(res.status, 0);
    assert.match(
      `${res.stderr}${res.stdout}`,
      /digest/i,
      'the refusal must name the missing evidence, not fail obscurely',
    );
  });
});

describe('file-ci-gap — dry run (AC-1)', () => {
  it('prints a graduatable filing and writes nothing', async () => {
    const ports = stubPorts();
    const calls = [];
    ports.createIssue = async (args) => {
      calls.push(args);
      return { url: null, number: null, error: null };
    };

    const result = await runFileCiGap({
      ...BASE,
      verdict: 'capacity',
      owner: 'platform',
      evidence:
        'load average 51.58 on 18 cores — neighbouring repo saturating the host',
      prNumber: 42,
      dryRun: true,
      ports,
      provider: stubProvider(),
    });

    // `main()` exits non-zero only when errors[] is non-empty, so an empty
    // errors[] IS the exit-0 contract the acceptance criterion names.
    assert.deepEqual(result.errors, []);
    assert.equal(calls.length, 0, 'a dry run must not write');
    assert.deepEqual(result.labels, [
      'meta::platform-gap',
      'friction::capacity',
    ]);
    for (const section of [
      '<!-- ci-gap-intake: v1 -->',
      '## Signature',
      '## Verdict',
      '## Routing',
      '## Occurrences',
    ]) {
      assert.ok(result.body.includes(section), `body must carry ${section}`);
    }
    assert.match(result.body, /<!-- audit-fingerprints: [0-9a-f]{40} -->/);
    assert.equal(result.actions.commented, false);
    assert.equal(result.actions.blocked, false);
    // The printed envelope is what an operator reads back.
    assert.equal(JSON.parse(JSON.stringify(result)).storyId, 5300);
  });

  it('rejects a --story that is not a positive issue number', async () => {
    await assert.rejects(
      runFileCiGap({
        ...BASE,
        storyId: 'nope',
        verdict: 'capacity',
        owner: 'platform',
      }),
      /--story/,
    );
  });
});

describe('file-ci-gap — friction comment and block (AC-9)', () => {
  it('comments without --block, and leaves the Story where it is', async () => {
    const provider = stubProvider();
    const result = await runFileCiGap({
      ...BASE,
      verdict: 'unreproducible-tier',
      owner: 'framework',
      evidence:
        'attach seam worked; webServer exited early before any test ran',
      ports: stubPorts(),
      provider,
    });

    assert.equal(result.actions.commented, true);
    assert.equal(result.actions.blocked, false);
    assert.equal(provider.labelWrites.length, 0, 'no --block, no label write');
    assert.equal(provider.posted.length, 1);
    assert.equal(provider.posted[0].type, 'friction');
    assert.match(provider.posted[0].body, /unreproducible-tier/);
    assert.match(
      provider.posted[0].body,
      /issues\/11/,
      'names the intake issue',
    );
  });

  it('flips the Story to agent::blocked with --block', async () => {
    const provider = stubProvider();
    const result = await runFileCiGap({
      ...BASE,
      verdict: 'capacity',
      owner: 'platform',
      block: true,
      ports: stubPorts(),
      provider,
    });

    assert.equal(result.actions.commented, true);
    assert.equal(result.actions.blocked, true);
    const added = provider.labelWrites.flatMap(
      (w) => w.patch?.labels?.add ?? [],
    );
    assert.ok(
      added.includes('agent::blocked'),
      `expected agent::blocked among ${JSON.stringify(added)}`,
    );
  });

  it('records a comment failure without losing the filing', async () => {
    const provider = stubProvider();
    provider.postComment = async () => {
      throw new Error('comment API down');
    };
    const result = await runFileCiGap({
      ...BASE,
      verdict: 'pre-existing',
      owner: 'consumer',
      ports: stubPorts(),
      provider,
    });
    assert.equal(result.decision, 'new');
    assert.equal(result.actions.commented, false);
    assert.match(result.errors.join('\n'), /comment API down/);
  });
});

describe('file-ci-gap — friction comment body', () => {
  it('states the verdict does not license a re-run', () => {
    const body = renderFrictionComment({
      verdict: 'capacity',
      digest: DIGEST,
      result: {
        decision: 'new',
        issue: { url: 'https://github.com/acme/platform/issues/11' },
        routing: {
          bucket: 'platform',
          routable: true,
          routedRepo: { owner: 'acme', repo: 'platform' },
          missingKey: null,
          deferredFrom: null,
        },
      },
    });
    assert.match(body, /does \*\*not\*\* license a re-run/);
  });

  it('surfaces an unroutable filing in the comment, not only in the issue', () => {
    const body = renderFrictionComment({
      verdict: 'capacity',
      digest: DIGEST,
      result: {
        decision: 'new',
        issue: { url: 'https://github.com/acme/product/issues/12' },
        routing: {
          bucket: 'platform',
          routable: false,
          routedRepo: { owner: 'acme', repo: 'product' },
          missingKey: 'github.followUpRepos.platform',
          deferredFrom: null,
        },
      },
    });
    assert.match(body, /unroutable/);
    assert.match(body, /github\.followUpRepos\.platform/);
  });
});
