import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  renderPlanMetricsSummaryLine,
  summarizePlanMetrics,
} from '../../../.agents/scripts/lib/orchestration/plan-metrics.js';

describe('summarizePlanMetrics stages', () => {
  it('keeps the widest span across out-of-order invocations', () => {
    const summary = summarizePlanMetrics({
      entries: [
        {
          cli: 'a',
          startedAt: '2026-01-01T00:00:05.000Z',
          endedAt: '2026-01-01T00:00:06.000Z',
          ok: true,
        },
        {
          cli: 'a',
          startedAt: '2026-01-01T00:00:01.000Z',
          endedAt: '2026-01-01T00:00:03.000Z',
          ok: true,
        },
        { cli: 'b', ok: false },
      ],
    });
    assert.equal(summary.firstStartedAt, '2026-01-01T00:00:01.000Z');
    assert.equal(summary.lastEndedAt, '2026-01-01T00:00:06.000Z');
    assert.equal(summary.spanMs, 5000);
    assert.equal(summary.failures, 1);
    assert.deepEqual(summary.byCli, { a: 2, b: 1 });
    assert.deepEqual(summary.byMode, {});
    assert.equal(summary.totalDurationMs, 0);
    assert.equal(summary.malformedLines, 0);
  });

  it('reports a null span when the stamps do not parse', () => {
    const summary = summarizePlanMetrics({
      entries: [{ cli: 'a', startedAt: 'x', endedAt: 'y', ok: true }],
    });
    assert.equal(summary.spanMs, null);
    assert.match(renderPlanMetricsSummaryLine(summary), /span n\/a/);
  });

  it('counts a critic skip that names no critic', () => {
    const summary = summarizePlanMetrics({
      entries: [{ kind: 'critic-skip', cli: 'c', at: '2026-01-01T00:00:00Z' }],
    });
    assert.equal(summary.criticSkips, 1);
    assert.deepEqual(summary.criticSkipsByCritic, {});
    assert.equal(summary.invocations, 0);
    assert.equal(summary.spanMs, null);
  });

  it('drops records without a timestamp when scoped by since', () => {
    const summary = summarizePlanMetrics(
      { entries: [{ cli: 'a', ok: true }] },
      { since: '2026-01-01T00:00:00Z' },
    );
    assert.equal(summary, null);
  });
});
