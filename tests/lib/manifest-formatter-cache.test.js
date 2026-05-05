import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __resetManifestFormatterCache,
  formatManifestMarkdown,
} from '../../.agents/scripts/lib/presentation/manifest-formatter.js';

function buildLargeManifest(storyCount = 50) {
  const storyManifest = [];
  for (let i = 0; i < storyCount; i++) {
    storyManifest.push({
      storyId: 1000 + i,
      storySlug: `story-${i}`,
      storyTitle: `Story ${i}`,
      type: 'story',
      earliestWave: i % 5,
      branchName: `story-${1000 + i}`,
      tasks: [
        {
          taskId: 2000 + i * 2,
          taskSlug: `t-${i}-a`,
          status: 'agent::done',
        },
        {
          taskId: 2001 + i * 2,
          taskSlug: `t-${i}-b`,
          status: 'agent::ready',
          dependencies: [2000 + i * 2],
        },
      ],
    });
  }
  return {
    epicId: 999,
    epicTitle: 'Perf Benchmark Epic',
    dryRun: false,
    generatedAt: '2026-04-24T00:00:00.000Z',
    summary: {
      totalTasks: storyCount * 2,
      doneTasks: storyCount,
      progressPercent: 50,
      dispatched: storyCount,
      totalWaves: 5,
    },
    storyManifest,
  };
}

test('formatManifestMarkdown returns cached string on identical input', () => {
  __resetManifestFormatterCache();
  const manifest = buildLargeManifest(10);
  const first = formatManifestMarkdown(manifest);
  const second = formatManifestMarkdown(manifest);
  assert.equal(first, second);
  // Reference equality — a cache hit returns the same string instance.
  assert.ok(
    Object.is(first, second),
    'expected cache hit to return same instance',
  );
});

test('formatManifestMarkdown re-renders when input changes', () => {
  __resetManifestFormatterCache();
  const a = buildLargeManifest(5);
  const b = buildLargeManifest(5);
  b.summary.doneTasks = a.summary.doneTasks + 1;
  const first = formatManifestMarkdown(a);
  const second = formatManifestMarkdown(b);
  assert.notEqual(first, second);
});

test('formatManifestMarkdown: cache hit is ≥10× faster than cold render (50-story plan)', () => {
  __resetManifestFormatterCache();
  const manifest = buildLargeManifest(50);

  // Cold render — measure the longest of a small sample to reduce jitter.
  let coldNs = 0n;
  for (let i = 0; i < 5; i++) {
    __resetManifestFormatterCache();
    const start = process.hrtime.bigint();
    formatManifestMarkdown(manifest);
    const elapsed = process.hrtime.bigint() - start;
    if (elapsed > coldNs) coldNs = elapsed;
  }

  // Prime cache, then measure many hits.
  formatManifestMarkdown(manifest);
  const iters = 1000;
  const hotStart = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) {
    formatManifestMarkdown(manifest);
  }
  const hotTotalNs = process.hrtime.bigint() - hotStart;
  const hotAvgNs = Number(hotTotalNs) / iters;

  const coldNsNum = Number(coldNs);
  const ratio = coldNsNum / Math.max(hotAvgNs, 1);

  assert.ok(
    ratio >= 10,
    `expected ≥10× speedup on cache hit; cold=${coldNsNum.toFixed(0)}ns, hot_avg=${hotAvgNs.toFixed(0)}ns, ratio=${ratio.toFixed(1)}x`,
  );
});
