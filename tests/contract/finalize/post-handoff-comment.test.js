/**
 * tests/contract/finalize/post-handoff-comment.test.js
 *
 * Contract test for `postHandoffComment` — Story #2894 / Task #2909
 * (Epic #2880).
 *
 * Asserts:
 *   1. Upsert on first call — invokes `upsertStructuredComment` with
 *      the `epic-handoff` marker on the Epic ticket.
 *   2. Idempotency — a second invocation calls `upsertStructuredComment`
 *      with the same marker. (The real upsert path diffs by marker and
 *      edits in place; we assert that the marker is stable across
 *      invocations rather than re-implementing the diff here.)
 *   3. Body rendering — the rendered body carries the PR number, the PR
 *      URL when supplied, and a JSON fence with the canonical
 *      `epic-handoff` payload shape.
 *   4. Input validation — bad `epicId` / `prNumber` / missing provider
 *      throw TypeError.
 */

import { strict as assert } from 'node:assert';
import fsp from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { describe, it } from 'node:test';

import {
  EPIC_HANDOFF_MARKER,
  extractRunTraceDigest,
  loadRunTraceFromDisk,
  postHandoffComment,
  renderHandoffBody,
  renderRunTraceSection,
} from '../../../.agents/scripts/lib/orchestration/finalize/post-handoff-comment.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

/**
 * Build a small, valid NDJSON ledger string with two phases so the
 * TraceLogger Summary projection has phase durations to roll up and one
 * failed terminal to exercise the failed-count line.
 */
function sampleLedger() {
  const recs = [
    {
      kind: 'emitted',
      seqId: 1,
      event: 'epic.snapshot.start',
      ts: '2026-06-05T10:00:00.000Z',
      payload: { epicId: 42 },
    },
    {
      kind: 'completed',
      seqId: 1,
      event: 'epic.snapshot.start',
      ts: '2026-06-05T10:00:02.000Z',
    },
    {
      kind: 'emitted',
      seqId: 2,
      event: 'wave.start',
      ts: '2026-06-05T10:00:05.000Z',
      payload: { waveIndex: 0 },
    },
    {
      kind: 'failed',
      seqId: 2,
      event: 'wave.start',
      ts: '2026-06-05T10:00:09.000Z',
    },
  ];
  return `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`;
}

describe('renderHandoffBody', () => {
  it('renders the PR number, the URL, and a JSON fence', () => {
    const body = renderHandoffBody({
      epicId: 2880,
      prNumber: 99,
      prUrl: 'https://github.com/o/r/pull/99',
    });
    assert.match(body, /Epic handoff/);
    assert.match(body, /Epic: #2880/);
    assert.match(body, /#99/);
    assert.match(body, /https:\/\/github\.com\/o\/r\/pull\/99/);
    assert.match(body, /```json/);
    assert.match(body, /"kind": "epic-handoff"/);
  });

  it('omits the URL link form when prUrl is absent', () => {
    const body = renderHandoffBody({ epicId: 1, prNumber: 7 });
    assert.match(body, /Pull request: #7$/m);
    assert.doesNotMatch(body, /\(http/);
  });

  it('embeds the Run trace digest section when a runTrace envelope is supplied', () => {
    const runTrace = renderRunTraceSection({
      digest: '- Events: 2\n- Completed: 1\n- Failed: 1',
      relativePath: 'temp/epic-42/lifecycle.md',
      truncated: false,
    });
    const body = renderHandoffBody({
      epicId: 42,
      prNumber: 9,
      runTrace: {
        digest: '- Events: 2\n- Completed: 1\n- Failed: 1',
        relativePath: 'temp/epic-42/lifecycle.md',
        truncated: false,
      },
    });
    assert.ok(runTrace.length > 0);
    assert.match(body, /## Run trace/);
    assert.match(body, /- Events: 2/);
    assert.match(body, /- Failed: 1/);
  });

  it('omits the Run trace section when no runTrace envelope is supplied', () => {
    const body = renderHandoffBody({ epicId: 42, prNumber: 9 });
    assert.doesNotMatch(body, /## Run trace/);
  });
});

describe('renderRunTraceSection', () => {
  it('returns empty string for null / malformed envelope', () => {
    assert.equal(renderRunTraceSection(null), '');
    assert.equal(renderRunTraceSection(undefined), '');
    assert.equal(renderRunTraceSection({}), '');
    assert.equal(renderRunTraceSection({ digest: 42 }), '');
  });

  it('renders the heading, the digest body, and the lifecycle.md link', () => {
    const section = renderRunTraceSection({
      digest: '- Events: 5\n- Completed: 4\n- Failed: 1',
      relativePath: 'temp/epic-7/lifecycle.md',
      truncated: false,
    });
    assert.match(section, /## Run trace/);
    assert.match(section, /- Events: 5/);
    assert.match(
      section,
      /\[`temp\/epic-7\/lifecycle\.md`\]\(temp\/epic-7\/lifecycle\.md\)/,
    );
    assert.doesNotMatch(section, /truncated/i);
  });

  it('emits a truncation note when truncated is true', () => {
    const section = renderRunTraceSection({
      digest: '- Events: 9999',
      relativePath: 'temp/epic-7/lifecycle.md',
      truncated: true,
    });
    assert.match(section, /truncated/i);
    // The relative-path link to the full lifecycle.md is retained.
    assert.match(section, /lifecycle\.md/);
  });
});

describe('extractRunTraceDigest', () => {
  it('projects the Summary block from a valid ledger string', () => {
    const out = extractRunTraceDigest({
      ledgerText: sampleLedger(),
      epicId: 42,
      relativePath: 'temp/epic-42/lifecycle.md',
    });
    assert.ok(out, 'expected a digest envelope');
    assert.equal(out.truncated, false);
    assert.equal(out.relativePath, 'temp/epic-42/lifecycle.md');
    // The digest carries the Summary rollup, not the per-event trace.
    assert.match(out.digest, /Events: 2/);
    assert.match(out.digest, /Completed: 1/);
    assert.match(out.digest, /Failed: 1/);
    assert.match(out.digest, /Phase durations:/);
    // The full per-event trace lines (HH:MM:SS event.name) are NOT carried.
    assert.doesNotMatch(out.digest, /epic\.snapshot\.start/);
  });

  it('returns null for an empty ledger (no emitted records)', () => {
    assert.equal(
      extractRunTraceDigest({
        ledgerText: '',
        epicId: 1,
        relativePath: 'temp/epic-1/lifecycle.md',
      }),
      null,
    );
  });

  it('returns null for a malformed ledger rather than throwing', () => {
    assert.equal(
      extractRunTraceDigest({
        ledgerText: '{not json}\n',
        epicId: 1,
        relativePath: 'temp/epic-1/lifecycle.md',
      }),
      null,
    );
  });

  it('truncates and flags when the projected digest exceeds the byte budget', () => {
    const out = extractRunTraceDigest({
      ledgerText: sampleLedger(),
      epicId: 42,
      relativePath: 'temp/epic-42/lifecycle.md',
      maxBytes: 20,
    });
    assert.ok(out);
    assert.equal(out.truncated, true);
    assert.ok(
      Buffer.byteLength(out.digest, 'utf8') <= 20,
      'truncated digest must fit the byte budget',
    );
  });
});

describe('loadRunTraceFromDisk', () => {
  it('returns null when the ledger file is absent', async () => {
    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'runtrace-'));
    try {
      const out = await loadRunTraceFromDisk({
        epicId: 999999,
        config: { project: { paths: { tempRoot: dir } } },
        cwd: dir,
      });
      assert.equal(out, null);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a non-positive epicId', async () => {
    assert.equal(await loadRunTraceFromDisk({ epicId: 0 }), null);
    assert.equal(await loadRunTraceFromDisk({ epicId: -1 }), null);
  });

  it('projects the digest from an on-disk ledger', async () => {
    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'runtrace-'));
    try {
      const epicDir = nodePath.join(dir, 'epic-77');
      await fsp.mkdir(epicDir, { recursive: true });
      await fsp.writeFile(
        nodePath.join(epicDir, 'lifecycle.ndjson'),
        sampleLedger(),
        'utf8',
      );
      const out = await loadRunTraceFromDisk({
        epicId: 77,
        config: { project: { paths: { tempRoot: dir } } },
        cwd: dir,
      });
      assert.ok(out, 'expected a digest envelope');
      assert.match(out.digest, /Events: 2/);
      assert.equal(out.relativePath, 'epic-77/lifecycle.md');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('postHandoffComment', () => {
  it('upserts the epic-handoff marker on the Epic on first call', async () => {
    const calls = [];
    const upsertFn = async (_provider, ticketId, type, body) => {
      calls.push({ ticketId, type, body });
      return { commentId: 12345 };
    };
    const result = await postHandoffComment({
      epicId: 2880,
      prNumber: 99,
      prUrl: 'https://github.com/o/r/pull/99',
      provider: { sentinel: true },
      upsertStructuredCommentFn: upsertFn,
      logger: quietLogger(),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ticketId, 2880);
    assert.equal(calls[0].type, EPIC_HANDOFF_MARKER);
    assert.match(calls[0].body, /#99/);
    assert.deepEqual(result, {
      marker: EPIC_HANDOFF_MARKER,
      commentId: 12345,
    });
  });

  it('is idempotent: re-invocation upserts with the same marker (no duplicates)', async () => {
    const calls = [];
    const upsertFn = async (_provider, ticketId, type, body) => {
      calls.push({ ticketId, type, body });
      return { commentId: 12345 };
    };
    const opts = {
      epicId: 2880,
      prNumber: 99,
      prUrl: 'https://github.com/o/r/pull/99',
      provider: { sentinel: true },
      upsertStructuredCommentFn: upsertFn,
      logger: quietLogger(),
    };
    await postHandoffComment(opts);
    await postHandoffComment(opts);
    assert.equal(calls.length, 2);
    // Same marker → real upsertStructuredComment would edit in place.
    assert.equal(calls[0].type, EPIC_HANDOFF_MARKER);
    assert.equal(calls[1].type, EPIC_HANDOFF_MARKER);
    // And the body is byte-stable so the marker dedup short-circuits.
    assert.equal(calls[0].body, calls[1].body);
  });

  it('propagates upsert failures', async () => {
    await assert.rejects(
      () =>
        postHandoffComment({
          epicId: 1,
          prNumber: 1,
          provider: { sentinel: true },
          upsertStructuredCommentFn: async () => {
            throw new Error('rate-limited');
          },
          logger: quietLogger(),
        }),
      /rate-limited/,
    );
  });

  it('throws on invalid epicId / prNumber / missing provider', async () => {
    await assert.rejects(
      () =>
        postHandoffComment({
          epicId: 0,
          prNumber: 1,
          provider: {},
        }),
      /epicId/,
    );
    await assert.rejects(
      () =>
        postHandoffComment({
          epicId: 1,
          prNumber: 0,
          provider: {},
        }),
      /prNumber/,
    );
    await assert.rejects(
      () =>
        postHandoffComment({
          epicId: 1,
          prNumber: 1,
          provider: null,
        }),
      /provider/,
    );
  });
});
