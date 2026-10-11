import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  filterRows,
  parseBound,
  renderSummaryMarkdown,
  summarize,
} from '../../../scripts/lib/agent-cost/summarize.js';

function row(overrides = {}) {
  return {
    sessionId: 's',
    agentId: null,
    agentType: 'story-worker',
    description: null,
    storyId: null,
    skill: 'mandrel-deliver',
    models: ['claude-opus-5-5'],
    efforts: ['medium'],
    primaryModel: 'claude-opus-5-5',
    primaryEffort: 'medium',
    effortChanges: 0,
    messages: 1,
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    totalTokens: 100,
    cacheCreationAfterFirstEffortChange: 0,
    startedAt: '2026-10-01T12:00:00.000Z',
    endedAt: '2026-10-01T12:01:00.000Z',
    wallMs: 60_000,
    ...overrides,
  };
}

describe('summarize', () => {
  it('groups by agentType × effort × model with count, median and p90', () => {
    const rows = [
      ...[100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((t) =>
        row({ totalTokens: t, wallMs: t * 10 }),
      ),
      row({ agentType: 'main', primaryEffort: 'high', totalTokens: 50 }),
      row({
        primaryModel: 'claude-fable-5',
        totalTokens: 7,
        effortChanges: 1,
        cacheCreationAfterFirstEffortChange: 33,
      }),
    ];

    const summary = summarize(rows);
    const worker = summary.groups.find(
      (g) =>
        g.agentType === 'story-worker' &&
        g.effort === 'medium' &&
        g.model === 'claude-opus-5-5',
    );

    assert.equal(summary.groups.length, 3);
    assert.equal(worker.count, 10);
    assert.equal(worker.totalTokens.median, 550);
    assert.equal(worker.totalTokens.p90, 900);
    assert.equal(worker.totalTokens.sum, 5500);
    assert.equal(worker.wallMs.median, 5500);
    assert.equal(worker.wallMs.p90, 9000);
    assert.equal(summary.totals.rows, 12);
    assert.equal(summary.totals.rowsWithEffortChange, 1);
    assert.equal(summary.totals.cacheCreationAfterFirstEffortChange, 33);
  });

  it('renders a markdown table naming every group', () => {
    const summary = summarize([row(), row({ agentType: 'auditor' })]);
    const md = renderSummaryMarkdown(summary, {
      projectDirs: ['/p'],
      filters: { since: '2026-09-11' },
      skippedLines: 3,
    });

    assert.match(md, /# Agent cost summary/);
    assert.match(md, /\| story-worker \| medium \| claude-opus-5-5 \| 1 \|/);
    assert.match(md, /\| auditor \|/);
    assert.match(md, /since=2026-09-11/);
    assert.match(md, /Skipped unparseable lines: 3/);
  });
});

describe('filterRows', () => {
  const rows = [
    row({ startedAt: '2026-09-01T00:00:00.000Z', skill: 'audit-security' }),
    row({ startedAt: '2026-10-01T23:00:00.000Z', agentType: 'auditor' }),
    row({ startedAt: '2026-10-05T00:00:00.000Z' }),
    row({ startedAt: null }),
  ];

  it('filters by --since and a whole-day --until', () => {
    const kept = filterRows(rows, {
      sinceMs: parseBound('2026-09-11', 'since'),
      untilMs: parseBound('2026-10-01', 'until'),
    });
    assert.deepEqual(
      kept.map((r) => r.startedAt),
      ['2026-10-01T23:00:00.000Z'],
    );
  });

  it('filters by agentType and skill', () => {
    assert.equal(filterRows(rows, { agentType: 'auditor' }).length, 1);
    assert.equal(filterRows(rows, { skill: 'audit-security' }).length, 1);
    assert.equal(filterRows(rows, {}).length, 4);
  });

  it('rejects a bound that is not a date', () => {
    assert.throws(() => parseBound('yesterday', 'since'), /--since/);
    assert.equal(parseBound(undefined, 'until'), null);
  });
});
