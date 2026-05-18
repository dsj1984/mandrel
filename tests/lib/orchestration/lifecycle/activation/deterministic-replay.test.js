// tests/lib/orchestration/lifecycle/activation/deterministic-replay.test.js
/**
 * Deterministic-replay regression test for the activation suite
 * (Story #2343 / Task #2346, Epic #2306).
 *
 * Drives two consecutive runs against `clean-sprint.fixture.js`,
 * normalizes wall-clock `ts` (and the seqId field, which is reassigned
 * per-run by the bus), and asserts the resulting NDJSON ledger and
 * the rendered `lifecycle.md` companion are byte-identical across the
 * two runs.
 *
 * This pins AC-12 from Epic #2172 (and its inherited AC-2 ancestry):
 * "same inputs → byte-identical lifecycle artifacts modulo
 * wall-clock". A regression here surfaces a non-deterministic listener
 * — typically a map iteration order leak or a clock-derived suffix
 * that escaped the test clock — before it pollutes operator-facing
 * artifacts.
 *
 * The byte-identity gates:
 *
 *   1. `lifecycle.ndjson` — the projected record stream (every record
 *      stripped of `ts` and `seqId` via the `projectRecord` helper
 *      already used by `lifecycle-diff diff`) must serialize to the
 *      same JSON. This is the canonical artifact; resume semantics
 *      depend on it.
 *
 *   2. `lifecycle.md` — the rendered companion (after stripping the
 *      per-event `HH:MM:SS` prefix and the `(NNNms)` duration suffix
 *      that depend on wall-clock) must be character-for-character
 *      identical. The companion is what operators read; drift here
 *      would mean a re-run looks "different" even though the
 *      underlying ledger is the same.
 *
 * Cross-references AC-12 / AC-2 in Tech Spec #2189 § Repeatability
 * Acceptance Criteria.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  parseLedgerText,
  projectRecord,
} from '../../../../../.agents/scripts/lifecycle-diff.js';
import { buildCleanSprintFixture } from './fixtures/clean-sprint.fixture.js';

/**
 * Serialize a parsed ledger to its byte-identity projection. The
 * `projectRecord` helper strips `ts` and `seqId` from every record;
 * the resulting string is what we compare across runs.
 */
function projectLedger(text) {
  const records = parseLedgerText(text);
  return records.map((r) => JSON.stringify(projectRecord(r))).join('\n');
}

/**
 * Normalize the rendered `lifecycle.md` companion for byte-identity.
 * The renderer (see `lifecycle/trace-logger.js#render`) prefixes every
 * per-event line with `HH:MM:SS` (UTC) and may append a
 * `(NNNms)` duration computed from the wall-clock gap between
 * `emitted` and `completed`. Both vary across runs; normalize them
 * to constants.
 */
function normalizeCompanion(text) {
  return (
    String(text || '')
      // 24-hour clock prefix at the start of a per-event line.
      .replace(/^\d{2}:\d{2}:\d{2}\b/gm, 'HH:MM:SS')
      // `(NNNms)` duration suffix anywhere on a line; `(pending)` is
      // already deterministic, so we leave that alone.
      .replace(/\(\d+ms\)/g, '(NNNms)')
      // Phase-durations section under `## Summary` (e.g. `  - Close-tail:
      // 4ms`). Stamp the duration to a constant so a millisecond shift
      // between runs does not break byte-identity.
      .replace(/^(\s*-\s+[^:]+:\s+)\d+ms$/gm, '$1NNNms')
  );
}

/**
 * Drive one complete clean-sprint run and return the two normalized
 * artifacts (ledger projection + companion). The fixture handles
 * temp-directory lifecycle; the caller invokes `cleanup()` after the
 * artifacts are captured.
 */
async function captureCleanSprintArtifacts() {
  const fixture = buildCleanSprintFixture();
  try {
    await fixture.bus.emit('epic.close.end', { epicId: fixture.epicId });
    const ledgerText = readFileSync(fixture.ledgerPath, 'utf8');
    const companionText = readFileSync(fixture.companionPath, 'utf8');
    return {
      ledger: projectLedger(ledgerText),
      companion: normalizeCompanion(companionText),
      raw: { ledger: ledgerText, companion: companionText },
    };
  } finally {
    fixture.cleanup();
  }
}

describe('deterministic replay — clean-sprint produces byte-identical artifacts across two runs', () => {
  it('lifecycle.ndjson is byte-identical (modulo ts/seqId) across two consecutive runs', async () => {
    const a = await captureCleanSprintArtifacts();
    const b = await captureCleanSprintArtifacts();
    assert.equal(
      a.ledger,
      b.ledger,
      'two consecutive runs of the clean-sprint fixture MUST produce byte-identical lifecycle.ndjson projections (ts and seqId excluded). A diff here means a non-deterministic listener has been introduced.',
    );
  });

  it('lifecycle.md companion is byte-identical (modulo clock prefixes and ms durations) across two consecutive runs', async () => {
    const a = await captureCleanSprintArtifacts();
    const b = await captureCleanSprintArtifacts();
    assert.equal(
      a.companion,
      b.companion,
      'two consecutive runs of the clean-sprint fixture MUST produce byte-identical lifecycle.md companions after normalizing HH:MM:SS prefixes and (NNNms) durations. A diff here means the renderer or an upstream emit is leaking non-deterministic content.',
    );
  });

  it('captured artifacts are non-empty — guards against the "two empty files are equal" failure mode', async () => {
    const a = await captureCleanSprintArtifacts();
    assert.ok(
      a.raw.ledger.length > 0,
      'lifecycle.ndjson must be non-empty after a clean-sprint run',
    );
    assert.ok(
      a.raw.companion.length > 0,
      'lifecycle.md must be non-empty after a clean-sprint run',
    );
    // Cross-check: the canonical terminal event must appear in both
    // artifacts. If a renderer regression dropped events, this catches
    // it even when the diff itself would pass.
    assert.match(
      a.raw.ledger,
      /"event":"epic\.complete"/,
      'lifecycle.ndjson must record epic.complete',
    );
    assert.match(
      a.raw.companion,
      /epic\.complete/,
      'lifecycle.md must mention epic.complete',
    );
  });
});
