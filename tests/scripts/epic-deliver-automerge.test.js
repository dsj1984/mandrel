// tests/scripts/epic-deliver-automerge.test.js
/**
 * Unit tests for the thin-shim `epic-deliver-automerge.js`
 * (Story #2256 / Task #2262 / Epic #2172).
 *
 * Pre-Wave-7 the CLI armed `gh pr merge --auto` directly. Wave 7
 * collapsed that responsibility into the `AutomergeArmer` lifecycle
 * listener; this CLI is now a telemetry shim that emits
 * `epic.automerge.start` and exits. The legacy `buildGhMergeArgs`
 * helper has been deleted because the literal `gh pr merge` is now
 * confined to `lib/orchestration/lifecycle/listeners/automerge-armer.js`
 * (the merge-lockout lint rule's sole allow-list entry).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildPrUrl,
  classifyAutomergeInvocation,
  parseAutomergeArgs,
  runEpicDeliverAutomerge,
} from '../../.agents/scripts/epic-deliver-automerge.js';
import { Bus } from '../../.agents/scripts/lib/orchestration/lifecycle/bus.js';

describe('classifyAutomergeInvocation', () => {
  it('returns help when --help is set', () => {
    assert.deepEqual(classifyAutomergeInvocation({ help: true }), {
      kind: 'help',
    });
  });
  it('returns usage-error when --epic or --pr is missing', () => {
    const r = classifyAutomergeInvocation({
      help: false,
      epicId: null,
      prNumber: 7,
    });
    assert.equal(r.kind, 'usage-error');
    assert.ok(r.messages.some((m) => /required/.test(m)));
  });
  it('returns run intent when all required args present', () => {
    const r = classifyAutomergeInvocation({
      help: false,
      epicId: 1,
      prNumber: 2,
    });
    assert.deepEqual(r, {
      kind: 'run',
      epicId: 1,
      prNumber: 2,
    });
  });
});

describe('parseAutomergeArgs', () => {
  it('parses --epic / --pr', () => {
    const out = parseAutomergeArgs(['--epic', '1178', '--pr', '1272']);
    assert.deepEqual(out, {
      epicId: 1178,
      prNumber: 1272,
      help: false,
    });
  });

  it('rejects bad ids', () => {
    assert.equal(parseAutomergeArgs(['--epic', '0', '--pr', '0']).epicId, null);
    assert.equal(
      parseAutomergeArgs(['--epic', '0', '--pr', '0']).prNumber,
      null,
    );
  });
});

describe('buildPrUrl', () => {
  it('builds a non-empty URI string for schema validation', () => {
    const url = buildPrUrl(1272);
    assert.match(url, /^https:\/\//);
    assert.match(url, /1272/);
  });
});

describe('runEpicDeliverAutomerge (thin shim)', () => {
  it('emits epic.automerge.start onto the supplied bus and returns the seqId', async () => {
    const bus = new Bus();
    const emits = [];
    bus.on('epic.automerge.start', async (ctx) =>
      emits.push({ event: ctx.event, payload: ctx.payload }),
    );
    const out = await runEpicDeliverAutomerge({
      epicId: 1178,
      prNumber: 1272,
      bus,
      loggerImpl: { info: () => {} },
    });
    assert.equal(emits.length, 1);
    assert.equal(emits[0].event, 'epic.automerge.start');
    assert.match(emits[0].payload.prUrl, /1272/);
    assert.equal(out.epicId, 1178);
    assert.equal(out.prNumber, 1272);
    assert.equal(typeof out.seqId, 'number');
  });

  it('rejects invalid arguments', async () => {
    await assert.rejects(
      () => runEpicDeliverAutomerge({ epicId: 0, prNumber: 1 }),
      /epicId must be a positive integer/,
    );
    await assert.rejects(
      () => runEpicDeliverAutomerge({ epicId: 1, prNumber: 0 }),
      /prNumber must be a positive integer/,
    );
  });
});
