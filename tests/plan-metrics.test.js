/**
 * plan-metrics.test.js — unit coverage for the #4474 PR1 plan-invocation
 * ledger: path routing, append + rotation, malformed-line tolerance on
 * read, the roll-up summary, and a snapshot of the rendered summary line.
 *
 * Story #4712: the append tail (path resolution, rotation, the append
 * itself) lives in the shared `lib/observability/metrics-ledger.js`
 * module; the plan-domain appenders here route through it. The rotation
 * behavior is tested once and exercised via every entry point, and a
 * structural assertion pins the tail to exactly one implementation.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  appendFindingsYield,
  MAX_LEDGER_BYTES,
  PLAN_METRICS_BASENAME,
  PLAN_METRICS_SCHEMA_VERSION,
  planMetricsPath,
} from '../.agents/scripts/lib/observability/metrics-ledger.js';
import {
  appendCriticSkip,
  appendPlanMetric,
  PLAN_METRICS_KIND_CRITIC_SKIP,
  readPlanMetrics,
  recordPlanInvocation,
  renderPlanMetricsSummaryLine,
  summarizePlanMetrics,
} from '../.agents/scripts/lib/orchestration/plan-metrics.js';

let workRoot;
let config;

beforeEach(() => {
  workRoot = mkdtempSync(path.join(tmpdir(), 'plan-metrics-'));
  // Absolute tempRoot is honoured verbatim by temp-paths, so the ledger
  // lands inside the per-test sandbox with no git anchoring involved.
  config = { project: { paths: { tempRoot: workRoot } } };
});

afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

describe('planMetricsPath', () => {
  it('routes an Epic-scoped ledger under temp/run-<id>/', () => {
    assert.equal(
      planMetricsPath(4474, config),
      path.join(workRoot, 'run-4474', PLAN_METRICS_BASENAME),
    );
  });

  it('routes epicId=null to the standalone stream', () => {
    assert.equal(
      planMetricsPath(null, config),
      path.join(workRoot, 'standalone', PLAN_METRICS_BASENAME),
    );
  });
});

describe('appendPlanMetric', () => {
  const entry = (over = {}) => ({
    cli: 'epic-plan-spec',
    mode: 'emit-context',
    epicId: 4474,
    startedAt: '2026-07-12T10:00:00.000Z',
    endedAt: '2026-07-12T10:00:05.000Z',
    ok: true,
    ...over,
  });

  it('creates the directory lazily and appends one JSON line per call', async () => {
    assert.equal(await appendPlanMetric(entry(), config), true);
    assert.equal(await appendPlanMetric(entry({ ok: false }), config), true);

    const raw = await fs.readFile(planMetricsPath(4474, config), 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.v, PLAN_METRICS_SCHEMA_VERSION);
    assert.equal(first.cli, 'epic-plan-spec');
    assert.equal(first.mode, 'emit-context');
    assert.equal(first.epicId, 4474);
    assert.equal(first.ok, true);
    assert.equal(first.durationMs, 5000); // derived from the timestamps
    assert.equal(JSON.parse(lines[1]).ok, false);
  });

  it('returns false (never throws) on an invalid entry', async () => {
    assert.equal(await appendPlanMetric(null, config), false);
    assert.equal(await appendPlanMetric(entry({ cli: '' }), config), false);
    assert.equal(await appendPlanMetric(entry({ mode: '' }), config), false);
  });

  it('appendCriticSkip writes the additive critic-skip record shape (PR6)', async () => {
    assert.equal(
      await appendCriticSkip(
        {
          critic: 'consolidation',
          reasons: ['draft matches Delivery Slicing 1:1'],
          cli: 'plan-critics',
          epicId: 4474,
        },
        config,
      ),
      true,
    );
    const { entries } = await readPlanMetrics(4474, config);
    assert.equal(entries.length, 1);
    const record = entries[0];
    assert.equal(record.v, PLAN_METRICS_SCHEMA_VERSION);
    assert.equal(record.kind, PLAN_METRICS_KIND_CRITIC_SKIP);
    assert.equal(record.cli, 'plan-critics');
    assert.equal(record.critic, 'consolidation');
    assert.deepEqual(record.reasons, ['draft matches Delivery Slicing 1:1']);
    assert.equal(record.epicId, 4474);
    assert.ok(typeof record.at === 'string' && record.at.length > 0);
  });

  it('appendCriticSkip routes epicId:null to the standalone stream and never throws', async () => {
    assert.equal(
      await appendCriticSkip(
        {
          critic: 'reachability',
          reasons: ['unconfigured'],
          cli: 'plan-persist',
        },
        config,
      ),
      true,
    );
    const { entries } = await readPlanMetrics(null, config);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].epicId, null);
    // Invalid entries degrade to false, never a throw.
    assert.equal(await appendCriticSkip(null, config), false);
    assert.equal(
      await appendCriticSkip({ critic: '', cli: 'x' }, config),
      false,
    );
    assert.equal(
      await appendCriticSkip({ critic: 'x', cli: '' }, config),
      false,
    );
  });

  it('rotates the ledger to <name>.1 when the byte cap would be exceeded', async () => {
    assert.ok(MAX_LEDGER_BYTES > 0);
    const filePath = planMetricsPath(4474, config);
    await appendPlanMetric(entry(), config, { maxBytes: 64 });
    // First append fits (empty file). The second would exceed 64 bytes,
    // so the existing ledger rolls over and the append starts fresh.
    await appendPlanMetric(entry({ mode: 'persist' }), config, {
      maxBytes: 64,
    });

    const rotated = await fs.readFile(`${filePath}.1`, 'utf8');
    assert.equal(JSON.parse(rotated.trim()).mode, 'emit-context');
    const active = await fs.readFile(filePath, 'utf8');
    const activeLines = active.trim().split('\n');
    assert.equal(activeLines.length, 1);
    assert.equal(JSON.parse(activeLines[0]).mode, 'persist');
  });
});

describe('single ledger-append implementation (Story #4712)', () => {
  const moduleSource = (relPath) =>
    readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8');

  it('the open→append→rotate tail exists only in metrics-ledger.js', () => {
    const ledger = moduleSource(
      '../.agents/scripts/lib/observability/metrics-ledger.js',
    );
    const planMetrics = moduleSource(
      '../.agents/scripts/lib/orchestration/plan-metrics.js',
    );
    // Exactly one append and one rotation rename, both in the shared module.
    assert.equal(ledger.split('fs.appendFile(').length - 1, 1);
    assert.equal(ledger.split('fs.rename(').length - 1, 1);
    // The plan-domain module owns no append tail of its own.
    assert.equal(planMetrics.includes('fs.appendFile('), false);
    assert.equal(planMetrics.includes('fs.rename('), false);
    assert.equal(planMetrics.includes('fs.mkdir('), false);
  });

  it('rotation fires identically through every appender entry point', async () => {
    const seedAndAssertRotation = async (append) => {
      const filePath = planMetricsPath(4712, config);
      // Seed the active generation past the tiny cap, then append.
      assert.equal(
        await appendPlanMetric(
          {
            cli: 'epic-plan-spec',
            mode: 'emit-context',
            epicId: 4712,
            startedAt: '2026-07-23T10:00:00.000Z',
            endedAt: '2026-07-23T10:00:01.000Z',
            ok: true,
          },
          config,
          { maxBytes: 64 },
        ),
        true,
      );
      assert.equal(await append(), true);
      const rotated = await fs.readFile(`${filePath}.1`, 'utf8');
      assert.equal(JSON.parse(rotated.trim()).cli, 'epic-plan-spec');
      const active = await fs.readFile(filePath, 'utf8');
      assert.equal(active.trim().split('\n').length, 1);
      await fs.rm(path.dirname(filePath), { recursive: true, force: true });
    };

    await seedAndAssertRotation(() =>
      appendCriticSkip(
        {
          critic: 'pre-mortem',
          reasons: ['x'],
          cli: 'plan-critics',
          epicId: 4712,
        },
        config,
        { maxBytes: 64 },
      ),
    );
    await seedAndAssertRotation(() =>
      appendFindingsYield(
        {
          storyId: 4712,
          epicId: 4712,
          lenses: [{ lens: 'audit-clean-code', findings: 0 }],
        },
        config,
        { maxBytes: 64 },
      ),
    );
  });
});

describe('recordPlanInvocation', () => {
  it('stamps ok:true around a successful invocation and returns its result', async () => {
    const result = await recordPlanInvocation(
      { cli: 'epic-plan-decompose', mode: 'persist', epicId: 7, config },
      async () => 'the-result',
    );
    assert.equal(result, 'the-result');
    const { entries } = await readPlanMetrics(7, config);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].ok, true);
    assert.equal(entries[0].cli, 'epic-plan-decompose');
    assert.equal(entries[0].mode, 'persist');
    assert.ok(entries[0].startedAt <= entries[0].endedAt);
  });

  it('stamps ok:false and re-throws the original error on failure', async () => {
    await assert.rejects(
      recordPlanInvocation(
        { cli: 'story-plan', mode: 'emit-context', epicId: null, config },
        async () => {
          throw new Error('authoring exploded');
        },
      ),
      /authoring exploded/,
    );
    const { entries } = await readPlanMetrics(null, config);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].ok, false);
    assert.equal(entries[0].epicId, null);
  });
});

describe('readPlanMetrics', () => {
  it('returns missing:true for an absent ledger', async () => {
    const result = await readPlanMetrics(999_001, config);
    assert.deepEqual(result, { entries: [], malformedLines: 0, missing: true });
  });

  it('skips malformed lines and counts them instead of throwing', async () => {
    const filePath = planMetricsPath(42, config);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const good = JSON.stringify({
      v: 1,
      cli: 'epic-plan-spec',
      mode: 'persist',
      epicId: 42,
      startedAt: '2026-07-12T10:00:00.000Z',
      endedAt: '2026-07-12T10:00:01.000Z',
      durationMs: 1000,
      ok: true,
    });
    await fs.writeFile(
      filePath,
      `${good}\n{"torn write\n\n42\n${good}\n`,
      'utf8',
    );

    const result = await readPlanMetrics(42, config);
    assert.equal(result.missing, false);
    assert.equal(result.entries.length, 2);
    assert.equal(result.malformedLines, 2); // torn JSON + bare number
  });
});

describe('summarizePlanMetrics', () => {
  const ledger = () => ({
    malformedLines: 1,
    entries: [
      {
        cli: 'epic-plan-spec',
        mode: 'emit-context',
        startedAt: '2026-07-12T10:00:00.000Z',
        endedAt: '2026-07-12T10:01:00.000Z',
        durationMs: 60_000,
        ok: true,
      },
      {
        cli: 'epic-plan-spec',
        mode: 'persist',
        startedAt: '2026-07-12T10:05:00.000Z',
        endedAt: '2026-07-12T10:06:00.000Z',
        durationMs: 60_000,
        ok: true,
      },
      {
        cli: 'epic-plan-decompose',
        mode: 'persist',
        startedAt: '2026-07-12T10:10:00.000Z',
        endedAt: '2026-07-12T10:12:03.000Z',
        durationMs: 123_000,
        ok: false,
      },
    ],
  });

  it('scopes the roll-up to one plan run via opts.since (Story #4541)', () => {
    // The Epic-less ledger at temp/standalone/ is shared by every plan the
    // repo has ever run, so an unfiltered roll-up reported lifetime totals
    // under a line the reader takes to describe the invocation in front of
    // them.
    const withSkip = ledger();
    withSkip.entries.push({
      kind: PLAN_METRICS_KIND_CRITIC_SKIP,
      cli: 'plan-persist',
      critic: 'pre-mortem',
      reasons: ['low risk'],
      at: '2026-07-12T10:11:00.000Z',
    });

    const scoped = summarizePlanMetrics(withSkip, {
      since: '2026-07-12T10:10:00.000Z',
    });
    // Only the third invocation (10:10) and the critic skip (10:11) are in
    // scope; the two earlier invocations belong to previous plan runs.
    assert.equal(scoped.invocations, 1);
    assert.deepEqual(scoped.byCli, { 'epic-plan-decompose': 1 });
    assert.equal(scoped.criticSkips, 1);
    assert.equal(scoped.firstStartedAt, '2026-07-12T10:10:00.000Z');
  });

  it('returns null when `since` excludes every record', () => {
    assert.equal(
      summarizePlanMetrics(ledger(), { since: '2027-01-01T00:00:00.000Z' }),
      null,
    );
  });

  it('summarizes the whole ledger when `since` is omitted', () => {
    assert.equal(summarizePlanMetrics(ledger()).invocations, 3);
  });

  it('returns null when there is nothing to summarize', () => {
    assert.equal(summarizePlanMetrics(null), null);
    assert.equal(summarizePlanMetrics({ entries: [] }), null);
  });

  it('rolls up counts, failures, span, and malformed-line count', () => {
    const summary = summarizePlanMetrics(ledger());
    assert.deepEqual(summary, {
      invocations: 3,
      failures: 1,
      byCli: { 'epic-plan-spec': 2, 'epic-plan-decompose': 1 },
      byMode: { 'emit-context': 1, persist: 2 },
      criticSkips: 0,
      criticSkipsByCritic: {},
      firstStartedAt: '2026-07-12T10:00:00.000Z',
      lastEndedAt: '2026-07-12T10:12:03.000Z',
      spanMs: 723_000,
      totalDurationMs: 243_000,
      malformedLines: 1,
    });
  });

  it('counts critic-skip records separately from invocations (PR6)', () => {
    const withSkips = ledger();
    withSkips.entries.push(
      {
        v: 1,
        kind: PLAN_METRICS_KIND_CRITIC_SKIP,
        cli: 'plan-critics',
        critic: 'pre-mortem',
        reasons: ['low risk, small plan'],
        epicId: 4474,
        at: '2026-07-12T10:13:00.000Z',
      },
      {
        v: 1,
        kind: PLAN_METRICS_KIND_CRITIC_SKIP,
        cli: 'plan-persist',
        critic: 'reachability',
        reasons: ['No planning.navigation.routeGlobs configured — skipped.'],
        epicId: 4474,
        at: '2026-07-12T10:14:00.000Z',
      },
    );
    const summary = summarizePlanMetrics(withSkips);
    assert.equal(summary.invocations, 3, 'skips never inflate invocations');
    assert.equal(summary.criticSkips, 2);
    assert.deepEqual(summary.criticSkipsByCritic, {
      'pre-mortem': 1,
      reachability: 1,
    });
    assert.match(
      renderPlanMetricsSummaryLine(summary),
      /2 critic skip\(s\) logged \(pre-mortem ×1, reachability ×1\)/,
    );
  });

  it('renderPlanMetricsSummaryLine snapshot', () => {
    const summary = summarizePlanMetrics(ledger());
    assert.equal(
      renderPlanMetricsSummaryLine(summary),
      'plan-metrics: 3 invocation(s) (1 failed) across epic-plan-spec ×2, ' +
        'epic-plan-decompose ×1 — span 12m 3s; 1 malformed line(s) skipped',
    );
  });

  it('renderPlanMetricsSummaryLine handles the empty ledger', () => {
    assert.equal(
      renderPlanMetricsSummaryLine(null),
      'plan-metrics: no invocations recorded',
    );
  });

  it('renderPlanMetricsSummaryLine formats a clean sub-minute run', () => {
    const summary = summarizePlanMetrics({
      entries: [
        {
          cli: 'story-plan',
          mode: 'emit-context',
          startedAt: '2026-07-12T10:00:00.000Z',
          endedAt: '2026-07-12T10:00:45.000Z',
          durationMs: 45_000,
          ok: true,
        },
      ],
    });
    assert.equal(
      renderPlanMetricsSummaryLine(summary),
      'plan-metrics: 1 invocation(s) across story-plan ×1 — span 45s',
    );
  });
});
