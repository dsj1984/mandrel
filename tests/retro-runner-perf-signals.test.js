// tests/retro-runner-perf-signals.test.js
/**
 * Story #3042 / Task #3044 — retro-runner wires `classifyPerfSignals`
 * into the composed retro body. Confirms:
 *
 *   - `## Performance Signals` section lists each classified signal when
 *     the persisted epic-perf-report is present and signals trip.
 *   - `## Recommended Follow-Ons` section contains one stanza per signal,
 *     each with a Conventional-Commits-shaped title and a body that
 *     includes the `meta::framework-gap` label.
 *   - Both sections are omitted entirely when no signal trips OR when the
 *     epic-perf-report is absent (null).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { composeRetroBody } from '../.agents/scripts/lib/orchestration/retro/phases/compose-body.js';

function baseCounts(overrides = {}) {
  return {
    friction: 1,
    parked: 0,
    recuts: 0,
    hotfixes: 0,
    hitl: 0,
    interventions: 0,
    ...overrides,
  };
}

describe('retro-runner perf-signals rendering (Story #3044)', () => {
  it('renders Performance Signals + Recommended Follow-Ons when signals trip', () => {
    const epicPerfReport = {
      kind: 'epic-perf-report',
      epicId: 99,
      waveParallelism: [
        {
          waveIndex: 0,
          wallClockMs: 1000,
          summedStoryMs: 200,
          utilisation: 0.1,
          capBinding: false,
        },
        {
          waveIndex: 1,
          wallClockMs: 1000,
          summedStoryMs: 2000,
          utilisation: 1,
          capBinding: true,
        },
        {
          waveIndex: 2,
          wallClockMs: 1000,
          summedStoryMs: 2000,
          utilisation: 1,
          capBinding: true,
        },
      ],
    };

    const { body, compact } = composeRetroBody({
      epicId: 99,
      counts: baseCounts(),
      epicPerfReport,
      storyPerfSummaries: [],
      forceFull: true,
    });

    assert.equal(compact, false);
    assert.match(body, /^## Performance Signals$/m);
    assert.match(body, /^## Recommended Follow-Ons$/m);
    // low-utilisation bullet for wave 0
    assert.match(body, /low-utilisation: wave 0/);
    // cap-binding-run bullet covering waves 1-2
    assert.match(body, /cap-binding-run: waves 1.{1,3}2/);
    // Conventional-Commits-shaped title in follow-on stanza
    assert.match(body, /perf\(epic-deliver\): investigate low utilisation/);
    // meta::framework-gap label hint present
    assert.match(body, /meta::framework-gap/);
    // gh issue create paste-ready stanza present
    assert.match(body, /gh issue create --title/);
  });

  it('omits both sections when no signal trips', () => {
    const epicPerfReport = {
      kind: 'epic-perf-report',
      epicId: 99,
      waveParallelism: [
        {
          waveIndex: 0,
          wallClockMs: 1000,
          summedStoryMs: 1500,
          utilisation: 0.75,
          capBinding: false,
        },
      ],
    };

    const { body } = composeRetroBody({
      epicId: 99,
      counts: baseCounts(),
      epicPerfReport,
      storyPerfSummaries: [],
      forceFull: true,
    });

    assert.doesNotMatch(body, /## Performance Signals/);
    assert.doesNotMatch(body, /## Recommended Follow-Ons/);
  });

  it('omits both sections when epic-perf-report is absent', () => {
    const { body } = composeRetroBody({
      epicId: 99,
      counts: baseCounts(),
      epicPerfReport: null,
      storyPerfSummaries: [],
      forceFull: true,
    });

    assert.doesNotMatch(body, /## Performance Signals/);
    assert.doesNotMatch(body, /## Recommended Follow-Ons/);
  });

  it('renders one follow-on stanza per signal', () => {
    const epicPerfReport = {
      kind: 'epic-perf-report',
      epicId: 99,
      waveParallelism: [
        {
          waveIndex: 0,
          wallClockMs: 1000,
          summedStoryMs: 100,
          utilisation: 0.05,
          capBinding: false,
        },
        {
          waveIndex: 1,
          wallClockMs: 1000,
          summedStoryMs: 100,
          utilisation: 0.05,
          capBinding: false,
        },
      ],
    };
    const { body } = composeRetroBody({
      epicId: 99,
      counts: baseCounts(),
      epicPerfReport,
      storyPerfSummaries: [],
      forceFull: true,
    });
    const followOnMatches = body.match(/gh issue create --title/g) ?? [];
    assert.equal(followOnMatches.length, 2);
  });

  it('respects custom perfThresholds to suppress signals', () => {
    const epicPerfReport = {
      kind: 'epic-perf-report',
      epicId: 99,
      waveParallelism: [
        {
          waveIndex: 0,
          wallClockMs: 1000,
          summedStoryMs: 400,
          utilisation: 0.2,
          capBinding: false,
        },
      ],
    };
    const { body } = composeRetroBody({
      epicId: 99,
      counts: baseCounts(),
      epicPerfReport,
      storyPerfSummaries: [],
      perfThresholds: {
        utilisation: 0.1,
        bootstrapShare: 0.4,
        capBindingRunLength: 2,
      },
      forceFull: true,
    });
    // utilisation threshold lowered below the observed 0.2 → no signal.
    assert.doesNotMatch(body, /## Performance Signals/);
  });

  it('renders high-bootstrap-share when storyPerfSummaries carry story-init', () => {
    const epicPerfReport = {
      kind: 'epic-perf-report',
      epicId: 99,
      waveParallelism: [
        {
          waveIndex: 0,
          wallClockMs: 1000,
          summedStoryMs: 1000,
          utilisation: 0.75,
          capBinding: false,
        },
      ],
    };
    const { body } = composeRetroBody({
      epicId: 99,
      counts: baseCounts(),
      epicPerfReport,
      storyPerfSummaries: [{ phaseTimingsMs: { 'story-init': 700 } }],
      forceFull: true,
    });
    assert.match(body, /high-bootstrap-share/);
    assert.match(body, /perf\(story-init\): reduce bootstrap share/);
  });
});
