/**
 * Sibling test for progress-reporter/signals.js — exercises the
 * structured-comment parsers and phase-timings aggregator directly so
 * the aggregator surface is locked in independently of the parent
 * ProgressReporter class. Story #1847.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  aggregatePhaseTimings,
  EPIC_RUN_PROGRESS_TYPE,
  parsePhaseTimingsComment,
  parseStoryRunProgressComment,
  PHASE_ORDER,
  PHASE_TIMINGS_TYPE,
  PHASE_TO_STATE,
  phaseToState,
  renderPhaseTimingsSection,
  STATE_EMOJI,
  STORY_RUN_PROGRESS_TYPE,
} from '../../../.agents/scripts/lib/orchestration/epic-runner/progress-reporter/signals.js';

describe('progress-reporter/signals', () => {
  describe('constants', () => {
    it('exposes the structured-comment kind taxonomy', () => {
      assert.equal(EPIC_RUN_PROGRESS_TYPE, 'epic-run-progress');
      assert.equal(PHASE_TIMINGS_TYPE, 'phase-timings');
      assert.equal(STORY_RUN_PROGRESS_TYPE, 'story-run-progress');
    });

    it('exposes the canonical phase ordering used by the table renderer', () => {
      assert.ok(Array.isArray(PHASE_ORDER));
      assert.ok(PHASE_ORDER.includes('install'));
      assert.ok(PHASE_ORDER.includes('test'));
    });

    it('exposes the state→emoji lookup', () => {
      assert.equal(STATE_EMOJI.done, '✅');
      assert.equal(STATE_EMOJI.blocked, '🚧');
      assert.equal(STATE_EMOJI.unknown, '❓');
    });

    it('exposes the phase→state lookup', () => {
      assert.equal(PHASE_TO_STATE.done, 'done');
      assert.equal(PHASE_TO_STATE.implementing, 'in-flight');
      assert.equal(PHASE_TO_STATE.init, 'queued');
    });
  });

  describe('phaseToState', () => {
    it('maps known phases to their high-level state', () => {
      assert.equal(phaseToState('done'), 'done');
      assert.equal(phaseToState('implementing'), 'in-flight');
      assert.equal(phaseToState('init'), 'queued');
      assert.equal(phaseToState('blocked'), 'blocked');
    });

    it('returns "unknown" for unrecognized phases', () => {
      assert.equal(phaseToState('garbage'), 'unknown');
      assert.equal(phaseToState(undefined), 'unknown');
      assert.equal(phaseToState(null), 'unknown');
    });
  });

  describe('parseStoryRunProgressComment', () => {
    it('parses a fenced-JSON story-run-progress body', () => {
      const body = [
        '<!-- structured-comment:story-run-progress -->',
        '',
        '```json',
        JSON.stringify({
          kind: 'story-run-progress',
          storyId: 101,
          phase: 'implementing',
          tasks: [
            { id: 1, state: 'done' },
            { id: 2, state: 'executing' },
            { id: 3, state: 'pending' },
          ],
          title: 'Test Story',
        }),
        '```',
      ].join('\n');

      const parsed = parseStoryRunProgressComment({ body });
      assert.equal(parsed.storyId, 101);
      assert.equal(parsed.phase, 'implementing');
      assert.equal(parsed.state, 'in-flight');
      assert.equal(parsed.tasksTotal, 3);
      assert.equal(parsed.tasksDone, 1);
      assert.equal(parsed.title, 'Test Story');
    });

    it('returns null for a malformed body', () => {
      assert.equal(
        parseStoryRunProgressComment({ body: 'not a fenced block' }),
        null,
      );
      assert.equal(parseStoryRunProgressComment(null), null);
    });
  });

  describe('parsePhaseTimingsComment', () => {
    it('parses a fenced-JSON phase-timings body', () => {
      const body = [
        '<!-- structured-comment:phase-timings -->',
        '',
        '```json',
        JSON.stringify({
          kind: 'phase-timings',
          storyId: 200,
          totalMs: 5000,
          phases: [
            { name: 'install', elapsedMs: 1000 },
            { name: 'test', elapsedMs: 4000 },
          ],
        }),
        '```',
      ].join('\n');

      const parsed = parsePhaseTimingsComment({ body });
      assert.equal(parsed.storyId, 200);
      assert.equal(parsed.totalMs, 5000);
      assert.equal(parsed.phases.length, 2);
      assert.equal(parsed.phases[0].name, 'install');
    });

    it('returns null when phases is missing or malformed', () => {
      assert.equal(parsePhaseTimingsComment(null), null);
      assert.equal(parsePhaseTimingsComment({ body: 'not fenced' }), null);
    });
  });

  describe('aggregatePhaseTimings', () => {
    it('aggregates per-phase median/p95/n across summaries', () => {
      const summaries = [
        {
          storyId: 1,
          totalMs: 100,
          phases: [
            { name: 'install', elapsedMs: 100 },
            { name: 'test', elapsedMs: 50 },
          ],
        },
        {
          storyId: 2,
          totalMs: 200,
          phases: [
            { name: 'install', elapsedMs: 200 },
            { name: 'test', elapsedMs: 100 },
          ],
        },
        {
          storyId: 3,
          totalMs: 300,
          phases: [
            { name: 'install', elapsedMs: 300 },
            { name: 'test', elapsedMs: 150 },
          ],
        },
      ];
      const rows = aggregatePhaseTimings(summaries);
      const install = rows.find((r) => r.name === 'install');
      assert.equal(install.n, 3);
      assert.equal(install.median, 200);
      assert.equal(install.p95, 300);
    });

    it('orders rows by PHASE_ORDER and appends unknown phases at tail', () => {
      const rows = aggregatePhaseTimings([
        {
          storyId: 1,
          totalMs: 0,
          phases: [
            { name: 'novel-phase', elapsedMs: 1 },
            { name: 'install', elapsedMs: 1 },
            { name: 'lint', elapsedMs: 1 },
          ],
        },
      ]);
      const names = rows.map((r) => r.name);
      assert.deepEqual(names, ['install', 'lint', 'novel-phase']);
    });

    it('handles empty input', () => {
      assert.deepEqual(aggregatePhaseTimings([]), []);
      assert.deepEqual(aggregatePhaseTimings([{ phases: [] }]), []);
    });
  });

  describe('renderPhaseTimingsSection', () => {
    it('renders a markdown table for non-empty summaries', () => {
      const out = renderPhaseTimingsSection([
        {
          storyId: 1,
          totalMs: 100,
          phases: [{ name: 'install', elapsedMs: 100 }],
        },
      ]);
      assert.ok(out.includes('Phase timings'));
      assert.ok(out.includes('install'));
    });

    it('returns null for empty input', () => {
      assert.equal(renderPhaseTimingsSection([]), null);
      assert.equal(renderPhaseTimingsSection(null), null);
    });
  });
});
