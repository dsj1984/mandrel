/**
 * Unit tests for `standalone-feedback-rollup.js` (Epic #4406 / Story #4416).
 *
 * The rollup scans the **standalone** signals streams for a delivered
 * Story set (`temp/standalone/stories/story-<sid>/signals.ndjson`) and
 * aggregates `friction` records by top-level `category`. These tests
 * prove:
 *   - reader/writer path agreement — a record written via
 *     `appendSignal({ epicId: null, storyId })` is found and aggregated by
 *     the rollup (both sides resolve the path through the temp-paths
 *     helpers, never a hand-built string);
 *   - top-level `category` bucketing (Epic #4406 canonical envelope);
 *   - graceful degradation — missing / empty streams contribute nothing
 *     and the rollup still returns an empty-but-valid summary;
 *   - `--stories` argument parsing (comma-split, de-dupe, validation).
 *
 * Each test threads an isolated `os.tmpdir()` workspace through the
 * writer + rollup `config.project.paths.tempRoot` so we never touch the
 * repo's real `temp/` tree. An absolute tempRoot is honoured verbatim by
 * `anchorTempRoot`, so no git anchoring interferes.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { appendSignal } from '../.agents/scripts/lib/observability/signals-writer.js';
import {
  buildRollup,
  parseArguments,
} from '../.agents/scripts/standalone-feedback-rollup.js';

let workRoot;
let cfg;

beforeEach(() => {
  workRoot = mkdtempSync(path.join(tmpdir(), 'standalone-rollup-'));
  cfg = { project: { paths: { tempRoot: workRoot } } };
});

afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

// Canonical standalone friction record (Epic #4406). `epicId: null` marks
// the standalone (no-parent-Epic) stream; the writer validates against
// `signal-event.schema.json`, which requires `kind` + `ts` and permits a
// null `epicId`.
const mkFriction = (storyId, category, overrides = {}) => ({
  kind: 'friction',
  ts: '2026-07-11T00:00:00.000Z',
  epicId: null,
  storyId,
  category,
  emitter: { tool: 'test' },
  ...overrides,
});

describe('standalone-feedback-rollup — parseArguments', () => {
  it('parses a single comma-separated --stories value', () => {
    assert.deepEqual(
      parseArguments(['--stories', '101,102,103']).stories,
      [101, 102, 103],
    );
  });

  it('accepts repeated --stories flags and de-dupes preserving order', () => {
    assert.deepEqual(
      parseArguments(['--stories', '101,102', '--stories', '102,103']).stories,
      [101, 102, 103],
    );
  });

  it('throws on a non-positive-integer token', () => {
    assert.throws(() => parseArguments(['--stories', '101,abc']), /positive/);
    assert.throws(() => parseArguments(['--stories', '0']), /positive/);
    assert.throws(() => parseArguments(['--stories', '-5']), /positive/);
  });

  it('throws when no stories are supplied', () => {
    assert.throws(() => parseArguments([]), /Usage/);
    assert.throws(() => parseArguments(['--stories', '']), /Usage/);
  });
});

describe('standalone-feedback-rollup — reader/writer path agreement', () => {
  it('finds and aggregates a friction record written via appendSignal({ epicId: null })', async () => {
    const storyId = 4416;
    const ok = await appendSignal({
      epicId: null,
      storyId,
      signal: mkFriction(storyId, 'Execution Error'),
      config: cfg,
    });
    assert.equal(ok, true, 'writer must report success');

    // Sanity: the writer landed the file under the standalone tree, proving
    // both sides resolve the same temp-paths location.
    const standalonePath = path.join(
      workRoot,
      'standalone',
      'stories',
      `story-${storyId}`,
      'signals.ndjson',
    );
    await assert.doesNotReject(fs.access(standalonePath));

    const summary = await buildRollup([storyId], cfg);
    assert.equal(summary.kind, 'standalone-feedback-rollup');
    assert.equal(summary.totalFriction, 1);
    assert.deepEqual(summary.byCategory, { 'Execution Error': 1 });
    assert.deepEqual(summary.perStory[storyId], {
      friction: 1,
      missing: false,
    });
  });

  it('aggregates friction across multiple stories and categories', async () => {
    await appendSignal({
      epicId: null,
      storyId: 201,
      signal: mkFriction(201, 'Execution Error'),
      config: cfg,
    });
    await appendSignal({
      epicId: null,
      storyId: 201,
      signal: mkFriction(201, 'Tool Limitation'),
      config: cfg,
    });
    await appendSignal({
      epicId: null,
      storyId: 202,
      signal: mkFriction(202, 'Execution Error'),
      config: cfg,
    });

    const summary = await buildRollup([201, 202], cfg);
    assert.equal(summary.totalFriction, 3);
    assert.deepEqual(summary.byCategory, {
      'Execution Error': 2,
      'Tool Limitation': 1,
    });
    assert.equal(summary.perStory[201].friction, 2);
    assert.equal(summary.perStory[202].friction, 1);
  });

  it('buckets a friction record with no category under Unknown and ignores non-friction kinds', async () => {
    await appendSignal({
      epicId: null,
      storyId: 301,
      signal: {
        kind: 'friction',
        ts: '2026-07-11T00:00:00.000Z',
        epicId: null,
        storyId: 301,
      },
      config: cfg,
    });
    // A non-friction signal must not be counted.
    await appendSignal({
      epicId: null,
      storyId: 301,
      signal: {
        kind: 'state-transition',
        ts: '2026-07-11T00:00:00.000Z',
        epicId: null,
        storyId: 301,
      },
      config: cfg,
    });

    const summary = await buildRollup([301], cfg);
    assert.equal(summary.totalFriction, 1);
    assert.deepEqual(summary.byCategory, { Unknown: 1 });
  });
});

describe('standalone-feedback-rollup — graceful degradation', () => {
  it('returns an empty summary for a missing stream and marks it missing (never throws)', async () => {
    const summary = await buildRollup([999], cfg);
    assert.equal(summary.totalFriction, 0);
    assert.deepEqual(summary.byCategory, {});
    assert.deepEqual(summary.perStory[999], { friction: 0, missing: true });
  });

  it('degrades to empty across a mix of present and absent streams', async () => {
    await appendSignal({
      epicId: null,
      storyId: 401,
      signal: mkFriction(401, 'Missing Skill'),
      config: cfg,
    });

    const summary = await buildRollup([401, 402], cfg);
    assert.equal(summary.totalFriction, 1);
    assert.deepEqual(summary.byCategory, { 'Missing Skill': 1 });
    assert.equal(summary.perStory[401].missing, false);
    assert.equal(summary.perStory[402].missing, true);
    assert.equal(summary.perStory[402].friction, 0);
  });
});
