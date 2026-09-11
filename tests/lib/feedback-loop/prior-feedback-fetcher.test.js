/**
 * tests/lib/feedback-loop/prior-feedback-fetcher.test.js — Story #2554
 *
 * Unit tests for `fetchPriorFeedback`. The gh CLI is stubbed via the
 * `spawnImpl` test seam; no real network or process spawn occurs.
 */

import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { fetchPriorFeedback } from '../../../.agents/scripts/lib/feedback-loop/prior-feedback-fetcher.js';

/**
 * Build a `spawnImpl` stub. The `responder` callback receives the args array
 * for each invocation and MUST return `{ stdout, stderr, code }` or throw to
 * simulate a synchronous spawn failure (e.g. ENOENT).
 */
function makeSpawnStub(responder) {
  return function spawnImpl(_cmd, args) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    const result = responder(args);

    queueMicrotask(() => {
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
      child.emit('close', result.code);
    });

    return child;
  };
}

/**
 * Look up the value passed to a given flag in a gh-style args array.
 * Returns `null` if the flag is absent.
 */
function flagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

describe('fetchPriorFeedback', () => {
  it('returns open issues for both meta labels in the canonical envelope shape', async () => {
    const responder = (args) => {
      const label = flagValue(args, '--label');
      if (label === 'meta::framework-gap') {
        return {
          stdout: JSON.stringify([
            {
              number: 100,
              title: 'A framework gap',
              url: 'https://github.com/o/r/issues/100',
              labels: [{ name: 'meta::framework-gap' }],
            },
          ]),
          stderr: '',
          code: 0,
        };
      }
      if (label === 'meta::consumer-improvement') {
        return {
          stdout: JSON.stringify([
            {
              number: 200,
              title: 'A consumer improvement',
              url: 'https://github.com/o/r/issues/200',
              labels: [{ name: 'meta::consumer-improvement' }],
            },
          ]),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '[]', stderr: '', code: 0 };
    };

    const result = await fetchPriorFeedback({
      owner: 'o',
      repo: 'r',
      spawnImpl: makeSpawnStub(responder),
    });

    assert.equal(result.errors.length, 0);
    assert.equal(result.frameworkGaps.length, 1);
    assert.equal(result.frameworkGaps[0].number, 100);
    assert.equal(result.frameworkGaps[0].title, 'A framework gap');
    assert.equal(result.consumerImprovements.length, 1);
    assert.equal(result.consumerImprovements[0].number, 200);
    assert.ok(
      typeof result.fetchedAt === 'string' && result.fetchedAt.length > 0,
      'fetchedAt must be a non-empty ISO timestamp',
    );
    // Confirm it parses as a valid ISO date.
    assert.ok(
      !Number.isNaN(new Date(result.fetchedAt).getTime()),
      'fetchedAt must be a valid ISO timestamp',
    );
  });

  it('passes --state open and --label to gh issue list', async () => {
    const seen = [];
    const responder = (args) => {
      seen.push(args.slice());
      return { stdout: '[]', stderr: '', code: 0 };
    };

    await fetchPriorFeedback({
      owner: 'o',
      repo: 'r',
      spawnImpl: makeSpawnStub(responder),
    });

    // One invocation per ownership bucket (Story #5300 added the third).
    assert.equal(seen.length, 3, 'expected one gh invocation per meta label');
    assert.deepEqual(seen.map((args) => flagValue(args, '--label')).sort(), [
      'meta::consumer-improvement',
      'meta::framework-gap',
      'meta::platform-gap',
    ]);
    for (const args of seen) {
      assert.equal(flagValue(args, '--state'), 'open');
      assert.equal(flagValue(args, '--repo'), 'o/r');
      // `body` is fetched so the CI-gap intake marker is visible; the body
      // itself is not carried onto the planner envelope.
      assert.equal(flagValue(args, '--json'), 'number,title,labels,url,body');
    }
  });

  it('dedupes issues that carry both meta labels (frameworkGaps wins)', async () => {
    const dualLabeled = {
      number: 42,
      title: 'Dual-labeled issue',
      url: 'https://github.com/o/r/issues/42',
      labels: [
        { name: 'meta::framework-gap' },
        { name: 'meta::consumer-improvement' },
      ],
    };
    const responder = (args) => {
      const label = flagValue(args, '--label');
      // gh's `--label` filter is OR-implicit for a single value, but a
      // dual-labeled issue is returned by both `--label` queries — this is
      // exactly the duplication the fetcher must collapse.
      if (label === 'meta::framework-gap') {
        return {
          stdout: JSON.stringify([dualLabeled]),
          stderr: '',
          code: 0,
        };
      }
      if (label === 'meta::consumer-improvement') {
        return {
          stdout: JSON.stringify([
            dualLabeled,
            {
              number: 99,
              title: 'Pure consumer improvement',
              url: '',
              labels: [{ name: 'meta::consumer-improvement' }],
            },
          ]),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '[]', stderr: '', code: 0 };
    };

    const result = await fetchPriorFeedback({
      owner: 'o',
      repo: 'r',
      spawnImpl: makeSpawnStub(responder),
    });

    assert.equal(result.errors.length, 0);
    assert.equal(result.frameworkGaps.length, 1);
    assert.equal(result.frameworkGaps[0].number, 42);
    assert.equal(result.consumerImprovements.length, 1);
    assert.equal(
      result.consumerImprovements[0].number,
      99,
      'dual-labeled issue must not appear in consumerImprovements',
    );
  });

  it('captures gh non-zero exits in errors[] without throwing', async () => {
    const responder = (args) => {
      const label = flagValue(args, '--label');
      if (label === 'meta::framework-gap') {
        return {
          stdout: '',
          stderr: 'HTTP 404: could not resolve to a Repository',
          code: 1,
        };
      }
      return { stdout: '[]', stderr: '', code: 0 };
    };

    const result = await fetchPriorFeedback({
      owner: 'o',
      repo: 'missing',
      spawnImpl: makeSpawnStub(responder),
    });

    assert.equal(result.frameworkGaps.length, 0);
    assert.equal(result.consumerImprovements.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /meta::framework-gap/);
    assert.match(result.errors[0], /exited with code 1/);
  });

  it('captures missing gh binary (ENOENT) in errors[] without throwing', async () => {
    const spawnImpl = () => {
      const err = new Error('spawn gh ENOENT');
      err.code = 'ENOENT';
      throw err;
    };

    const result = await fetchPriorFeedback({
      owner: 'o',
      repo: 'r',
      spawnImpl,
    });

    assert.equal(result.frameworkGaps.length, 0);
    assert.equal(result.consumerImprovements.length, 0);
    // One error per label invocation.
    assert.equal(result.errors.length, 3);
    for (const msg of result.errors) {
      assert.match(msg, /gh CLI not found/);
    }
  });

  it('captures malformed JSON in errors[] without throwing', async () => {
    const responder = () => ({
      stdout: 'not-json-at-all',
      stderr: '',
      code: 0,
    });

    const result = await fetchPriorFeedback({
      owner: 'o',
      repo: 'r',
      spawnImpl: makeSpawnStub(responder),
    });

    assert.equal(result.frameworkGaps.length, 0);
    assert.equal(result.consumerImprovements.length, 0);
    assert.equal(result.platformGaps.length, 0);
    assert.equal(result.errors.length, 3);
    for (const msg of result.errors) {
      assert.match(msg, /Failed to parse gh issue list JSON/);
    }
  });

  it('returns platform gaps and flags CI-gap intake issues (Story #5300)', async () => {
    // The graduation surface: `/mandrel-plan` offers an intake filing a
    // `/mandrel-plan <id>` rewrite, so the flag has to survive the fetch.
    const responder = (args) => {
      const label = flagValue(args, '--label');
      if (label === 'meta::platform-gap') {
        return {
          stdout: JSON.stringify([
            {
              number: 2587,
              title: 'CI gap (capacity): runner host saturated',
              url: 'https://github.com/o/r/issues/2587',
              labels: [
                { name: 'meta::platform-gap' },
                { name: 'friction::capacity' },
              ],
              body: '<!-- ci-gap-intake: v1 -->\n\n## Signature\n…',
            },
          ]),
          stderr: '',
          code: 0,
        };
      }
      if (label === 'meta::framework-gap') {
        return {
          stdout: JSON.stringify([
            {
              number: 100,
              title: 'A hand-written framework report',
              url: 'https://github.com/o/r/issues/100',
              labels: [{ name: 'meta::framework-gap' }],
              body: 'Someone wrote this by hand.',
            },
          ]),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '[]', stderr: '', code: 0 };
    };

    const result = await fetchPriorFeedback({
      owner: 'o',
      repo: 'r',
      spawnImpl: makeSpawnStub(responder),
    });

    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    assert.equal(result.platformGaps.length, 1);
    assert.equal(result.platformGaps[0].number, 2587);
    assert.equal(result.platformGaps[0].intake, true);
    // The body is the marker's carrier, not planner payload.
    assert.equal(result.platformGaps[0].body, undefined);
    // A hand-written report is NOT an intake filing — nothing to graduate.
    assert.equal(result.frameworkGaps[0].intake, false);
    // The verdict label still feeds recurrence counting.
    assert.ok(
      result.recurringDefectClasses.some((c) => c.class === 'capacity'),
      'a friction::capacity intake must reach recurringDefectClasses',
    );
  });

  it('rejects missing owner/repo by populating errors[] (no throw, no spawn)', async () => {
    let spawnCalled = false;
    const spawnImpl = () => {
      spawnCalled = true;
      return new EventEmitter();
    };

    const result = await fetchPriorFeedback({ spawnImpl });

    assert.equal(spawnCalled, false, 'must not spawn gh when args are missing');
    assert.equal(result.errors.length, 2);
    assert.match(result.errors[0], /owner/);
    assert.match(result.errors[1], /repo/);
    assert.equal(result.frameworkGaps.length, 0);
    assert.equal(result.consumerImprovements.length, 0);
  });
});
