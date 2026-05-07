/**
 * epic-close.smoke — sanity guard for `.agents/workflows/epic-close.md`.
 *
 * Story #1046 Task #1066 added a Phase 6 step that runs
 * `node .agents/scripts/analyze-execution.js --epic [EPIC_ID]` so the
 * `<!-- structured:epic-perf-report -->` comment is upserted before the
 * retro helper composes. The smoke test pins:
 *
 *   1. The analyzer command appears exactly once in Phase 6.
 *   2. The doc states that the perf-report must exist before
 *      `epic-retro.md` begins.
 *
 * If a future edit moves or removes the analyzer step, this test fails
 * loudly so the wiring contract isn't silently dropped.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOC_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '.agents',
  'workflows',
  'epic-close.md',
);

describe('epic-close.md — Phase 6 perf-report wiring', () => {
  const body = readFileSync(DOC_PATH, 'utf8');
  // Locate the Phase 6 section.
  const phase6Match = body.match(
    /## Phase 6 — Retro[\s\S]*?(?=\n## Phase 7|\n---\n\n## Phase 7)/,
  );

  it('the doc has a Phase 6 — Retro section', () => {
    assert.ok(
      phase6Match,
      'Phase 6 — Retro section not found in epic-close.md',
    );
  });

  it('Phase 6 references the analyzer command exactly once', () => {
    const phase6 = phase6Match[0];
    const analyzerCmd =
      'node .agents/scripts/analyze-execution.js --epic [EPIC_ID]';
    const occurrences = phase6.split(analyzerCmd).length - 1;
    assert.equal(
      occurrences,
      1,
      `expected analyzer command exactly once in Phase 6, found ${occurrences}`,
    );
  });

  it('Phase 6 states the perf-report must exist before epic-retro.md begins', () => {
    const phase6 = phase6Match[0];
    assert.match(
      phase6,
      /must exist on the Epic[\s\S]*?epic-retro\.md/i,
      'expected Phase 6 to require the perf-report before epic-retro.md begins',
    );
  });
});
