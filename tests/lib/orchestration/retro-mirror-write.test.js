/**
 * Unit tests for the local retro markdown mirror write performed by
 * `runRetro` after it posts to GitHub.
 *
 * Story #2089 (Epic #2001) — `runRetro` resolves the canonical mirror
 * path via `epicRetroMirrorPath` and writes the same body it posted to
 * GitHub to that path. GitHub remains SSOT; a local write failure logs
 * a warn and does not fail the phase.
 *
 * Coverage:
 *   - Happy path: after a successful `runRetro`, `writeFileSync` is
 *     called with the path returned by `epicRetroMirrorPath` and the
 *     exact body posted to GitHub via `upsertFn`.
 *   - Failure path: when `writeFileSync` throws, `runRetro` resolves
 *     (does not throw), logs a warning, and still reports the GitHub
 *     post as successful.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { epicRetroMirrorPath } from '../../../.agents/scripts/lib/config/temp-paths.js';
import { runRetro } from '../../../.agents/scripts/lib/orchestration/retro-runner.js';

/**
 * Fake provider with the minimum surface `runRetro` needs:
 *   - sub-issue topology with one Story + one Task so the compact path
 *     triggers (zero friction everywhere).
 *   - `getTicket` returns the Epic title.
 *   - No comment plumbing required for the mirror coverage; the runner
 *     reads structured comments via `getTicketComments` but the empty
 *     default response yields a clean manifest.
 */
function makeProvider(epicId, storyId, taskId) {
  const subIssuesByParent = new Map([
    [
      epicId,
      [{ id: storyId, number: storyId, labels: ['type::story'], body: '' }],
    ],
    [storyId, [{ id: taskId, number: taskId, labels: ['type::task'] }]],
  ]);
  return {
    async getSubIssues(id) {
      return subIssuesByParent.get(id) ?? [];
    },
    async getTicketComments() {
      return [];
    },
    async getTicket(id) {
      if (id === epicId) return { id: epicId, title: 'Mirror Test Epic' };
      return null;
    },
  };
}

test('runRetro: writes local mirror with the same body it posts to GitHub', async () => {
  const epicId = 4242;
  const storyId = 4243;
  const taskId = 4244;
  const provider = makeProvider(epicId, storyId, taskId);

  let postedBody = null;
  let postedCommentId = 99;
  const upsertFn = async (_provider, _ticketId, _type, body) => {
    postedBody = body;
    return { commentId: postedCommentId };
  };

  const writeCalls = [];
  const mkdirCalls = [];
  const fsImpl = {
    writeFileSync: (target, content, encoding) => {
      writeCalls.push({ target, content, encoding });
    },
    mkdirSync: (dir, opts) => {
      mkdirCalls.push({ dir, opts });
    },
  };

  const warnLines = [];
  const logger = {
    info() {},
    warn(msg) {
      warnLines.push(msg);
    },
  };

  const result = await runRetro({
    epicId,
    provider,
    logger,
    timestamp: '2026-05-16T00:00:00.000Z',
    upsertFn,
    fsImpl,
  });

  assert.equal(result.posted, true);
  assert.equal(result.compact, true);
  assert.ok(postedBody, 'expected GitHub upsert to receive a body');

  // The mirror write must be invoked exactly once with the canonical
  // epicRetroMirrorPath and the same body that was posted to GitHub.
  assert.equal(writeCalls.length, 1, 'expected exactly one writeFileSync call');
  const expectedRel = epicRetroMirrorPath(epicId);
  const writeCall = writeCalls[0];
  assert.ok(
    writeCall.target === expectedRel ||
      writeCall.target.endsWith(expectedRel) ||
      writeCall.target.endsWith(expectedRel.split(path.sep).join('/')),
    `writeFileSync target ${writeCall.target} should match epicRetroMirrorPath(${epicId}) (${expectedRel})`,
  );
  assert.equal(writeCall.content, postedBody);
  assert.equal(writeCall.encoding, 'utf8');

  // mkdir must precede the write so the per-Epic temp dir exists.
  assert.equal(mkdirCalls.length, 1, 'expected exactly one mkdirSync call');
  assert.equal(mkdirCalls[0].opts?.recursive, true);

  // Happy path emits no warn.
  assert.equal(
    warnLines.length,
    0,
    `unexpected warn lines: ${warnLines.join('\n')}`,
  );
});

test('runRetro: warns and resolves normally when writeFileSync throws', async () => {
  const epicId = 4252;
  const storyId = 4253;
  const taskId = 4254;
  const provider = makeProvider(epicId, storyId, taskId);

  const upsertFn = async () => ({ commentId: 1 });

  const fsImpl = {
    writeFileSync: () => {
      throw new Error('disk full (simulated)');
    },
    mkdirSync: () => {},
  };

  const warnLines = [];
  const logger = {
    info() {},
    warn(msg) {
      warnLines.push(msg);
    },
  };

  const result = await runRetro({
    epicId,
    provider,
    logger,
    timestamp: '2026-05-16T01:00:00.000Z',
    upsertFn,
    fsImpl,
  });

  // The GitHub upsert is the SSOT — it succeeded, so runRetro reports posted.
  assert.equal(result.posted, true);
  // A warn line must mention the mirror failure so operators can spot it.
  assert.ok(
    warnLines.some((line) => /mirror|retro\.md|disk full/i.test(line)),
    `expected a warn line about the mirror failure, got: ${warnLines.join('\n') || '<none>'}`,
  );
});
