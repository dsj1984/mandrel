import assert from 'node:assert';
import { test } from 'node:test';
import {
  renderManifestMarkdown,
  renderStoryManifestMarkdown,
} from '../.agents/scripts/lib/presentation/manifest-renderer.js';

// ---------------------------------------------------------------------------
// Shared Fixtures
// ---------------------------------------------------------------------------

function makeTask(id, status = 'agent::ready', title = `Task ${id}`) {
  return {
    taskId: id,
    taskSlug: title.toLowerCase().replace(/\s/g, '-'),
    status,
    dependencies: [],
  };
}

function makeStory(storyId, tasks = [], wave = 0) {
  return {
    storyId,
    storyTitle: `Story ${storyId}`,
    storySlug: `story-${storyId}`,
    type: 'story',
    branchName: `story-${storyId}`,
    earliestWave: wave,
    tasks,
  };
}

function makeFeature(featureId, tasks = []) {
  return {
    storyId: featureId,
    storyTitle: `Feature ${featureId}`,
    storySlug: `feature-${featureId}`,
    type: 'feature',
    branchName: `feature-${featureId}`,
    earliestWave: -1,
    tasks,
  };
}

function makeBaseManifest(overrides = {}) {
  return {
    epicId: 100,
    epicTitle: 'Test Epic Title',
    generatedAt: '2026-01-01T00:00:00.000Z',
    dryRun: false,
    summary: {
      totalTasks: 0,
      doneTasks: 0,
      progressPercent: 0,
      totalWaves: 0,
      dispatched: 0,
    },
    storyManifest: [],
    waves: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// renderManifestMarkdown
// ---------------------------------------------------------------------------

test('renderManifestMarkdown', async (t) => {
  await t.test('renders epic header with correct ID and title', () => {
    const manifest = makeBaseManifest();
    const output = renderManifestMarkdown(manifest);
    assert.match(output, /Dispatch Manifest — Epic #100/);
    assert.match(output, /Test Epic Title/);
  });

  await t.test('includes agent operating procedures', () => {
    const manifest = makeBaseManifest();
    const output = renderManifestMarkdown(manifest);
    assert.match(output, /Agent Operating Procedures/);
    assert.match(output, /\/epic-deliver/);
  });

  await t.test('renders 0% progress bar when no tasks done', () => {
    const manifest = makeBaseManifest({
      summary: {
        totalTasks: 4,
        doneTasks: 0,
        progressPercent: 0,
        totalWaves: 1,
        dispatched: 0,
      },
    });
    const output = renderManifestMarkdown(manifest);
    assert.match(output, /0%/);
    assert.match(output, /0\/4 tasks/);
    // Should use construction emoji for 0%
    assert.match(output, /🏗️/);
  });

  await t.test('renders 100% progress bar and celebration emoji', () => {
    const manifest = makeBaseManifest({
      summary: {
        totalTasks: 4,
        doneTasks: 4,
        progressPercent: 100,
        totalWaves: 1,
        dispatched: 4,
      },
    });
    const output = renderManifestMarkdown(manifest);
    assert.match(output, /100%/);
    assert.match(output, /🎉/);
  });

  await t.test('renders fire emoji for 50%+ progress', () => {
    const manifest = makeBaseManifest({
      summary: {
        totalTasks: 4,
        doneTasks: 2,
        progressPercent: 50,
        totalWaves: 1,
        dispatched: 2,
      },
    });
    const output = renderManifestMarkdown(manifest);
    assert.match(output, /🔥/);
  });

  await t.test('renders wave summary table for stories', () => {
    const tasks = [makeTask(1, 'agent::done'), makeTask(2, 'agent::ready')];
    const story = makeStory(10, tasks, 0);
    const manifest = makeBaseManifest({
      summary: {
        totalTasks: 2,
        doneTasks: 1,
        progressPercent: 50,
        totalWaves: 1,
        dispatched: 0,
      },
      storyManifest: [story],
    });
    const output = renderManifestMarkdown(manifest);
    assert.match(output, /Wave Summary/);
    assert.match(output, /Wave 0/);
  });

  await t.test('marks wave as Ready when wave 0', () => {
    const tasks = [makeTask(1, 'agent::ready')];
    const story = makeStory(10, tasks, 0);
    const manifest = makeBaseManifest({ storyManifest: [story] });
    const output = renderManifestMarkdown(manifest);
    assert.match(output, /🚀 Ready/);
  });

  await t.test('marks wave as Done when all tasks are done', () => {
    const tasks = [makeTask(1, 'agent::done')];
    const story = makeStory(10, tasks, 0);
    const manifest = makeBaseManifest({
      summary: {
        totalTasks: 1,
        doneTasks: 1,
        progressPercent: 100,
        totalWaves: 1,
        dispatched: 0,
      },
      storyManifest: [story],
    });
    const output = renderManifestMarkdown(manifest);
    assert.match(output, /✅ Done/);
  });

  await t.test('marks wave as Blocked when prior wave incomplete', () => {
    const tasks0 = [makeTask(1, 'agent::ready')];
    const tasks1 = [makeTask(2, 'agent::ready')];
    const story0 = makeStory(10, tasks0, 0);
    const story1 = makeStory(11, tasks1, 1);
    const manifest = makeBaseManifest({ storyManifest: [story0, story1] });
    const output = renderManifestMarkdown(manifest);
    assert.match(output, /⏳ Blocked/);
  });

  await t.test('renders nested per-wave H2 with story checkbox tasks', () => {
    const tasks = [makeTask(1, 'agent::ready')];
    const story = makeStory(10, tasks, 0);
    const manifest = makeBaseManifest({ storyManifest: [story] });
    const output = renderManifestMarkdown(manifest);
    // Legacy "## Execution Plan" was retired in Story #1194 Task #1212.
    assert.doesNotMatch(output, /## Execution Plan/);
    assert.match(output, /^## .* Wave 0/m); // per-wave H2
    assert.match(output, /^### .* #10/m); // per-Story H3 with id
    assert.match(output, /- \[ \] #1 — task-1/); // checkbox task line
  });

  await t.test('renders completed story with checkmark', () => {
    const tasks = [makeTask(1, 'agent::done')];
    const story = makeStory(10, tasks, 0);
    const manifest = makeBaseManifest({ storyManifest: [story] });
    const output = renderManifestMarkdown(manifest);
    assert.match(output, /✅/);
  });

  await t.test('excludes features from execution plan waves', () => {
    const feature = makeFeature(50, [makeTask(1)]);
    const story = makeStory(10, [makeTask(2)], 0);
    const manifest = makeBaseManifest({ storyManifest: [feature, story] });
    const output = renderManifestMarkdown(manifest);
    // Feature should be in a separate section, not in wave execution
    assert.match(output, /Feature Containers/);
    assert.match(output, /#50/);
    // Wave 0 should only contain the story
    assert.match(output, /Wave 0/);
  });

  await t.test('renders feature containers section', () => {
    const feature = makeFeature(50, [makeTask(1), makeTask(2)]);
    const manifest = makeBaseManifest({ storyManifest: [feature] });
    const output = renderManifestMarkdown(manifest);
    assert.match(output, /Feature Containers/);
    assert.match(output, /not directly executable/);
    assert.match(output, /#50/);
  });

  await t.test(
    'does not render Feature Containers section when no features',
    () => {
      const story = makeStory(10, [makeTask(1)], 0);
      const manifest = makeBaseManifest({ storyManifest: [story] });
      const output = renderManifestMarkdown(manifest);
      assert.doesNotMatch(output, /Feature Containers/);
    },
  );

  await t.test('renders multiple waves in correct order', () => {
    const s0 = makeStory(10, [makeTask(1, 'agent::done')], 0);
    const s1 = makeStory(11, [makeTask(2, 'agent::ready')], 1);
    const manifest = makeBaseManifest({ storyManifest: [s1, s0] }); // intentionally reversed
    const output = renderManifestMarkdown(manifest);
    const wave0Pos = output.indexOf('Wave 0');
    const wave1Pos = output.indexOf('Wave 1');
    assert.ok(wave0Pos < wave1Pos, 'Wave 0 should appear before Wave 1');
  });

  await t.test('returns a string', () => {
    const manifest = makeBaseManifest();
    const output = renderManifestMarkdown(manifest);
    assert.strictEqual(typeof output, 'string');
  });

  await t.test('renders generatedAt timestamp', () => {
    const manifest = makeBaseManifest({
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    const output = renderManifestMarkdown(manifest);
    assert.match(output, /2026-01-01T00:00:00.000Z/);
  });
});

// ---------------------------------------------------------------------------
// renderStoryManifestMarkdown
// ---------------------------------------------------------------------------

test('renderStoryManifestMarkdown', async (t) => {
  await t.test('exists as an exported function', async () => {
    // If it doesn't export this, the import itself will fail
    const { renderStoryManifestMarkdown: fn } = await import(
      '../.agents/scripts/lib/presentation/manifest-renderer.js'
    );
    assert.strictEqual(typeof fn, 'function');
  });

  await t.test('renders story manifest header', () => {
    const manifest = {
      type: 'story-execution',
      epicId: 100,
      epicBranch: 'epic/100',
      generatedAt: '2026-01-01T00:00:00.000Z',
      stories: [
        {
          storyId: 42,
          storyTitle: 'Test Story',
          branchName: 'story-42',
          epicBranch: 'epic/100',
          tasks: [],
          blockers: [],
        },
      ],
    };
    const output = renderStoryManifestMarkdown(manifest);
    assert.strictEqual(typeof output, 'string');
    assert.match(output, /Story Execution/);
    assert.match(output, /Story #42/);
  });

  await t.test('renders story manifest with tasks and blockers', () => {
    const manifest = {
      type: 'story-execution',
      epicId: 100,
      generatedAt: '2026-01-01T00:00:00.000Z',
      stories: [
        {
          storyId: 43,
          storyTitle: 'Test Story',
          branchName: 'story-43',
          tasks: [
            {
              taskId: 431,
              title: 'Subtask 1',
              status: 'agent::ready',
              dependencies: [99],
            },
          ],
        },
      ],
    };
    const output = renderStoryManifestMarkdown(manifest);
    assert.match(output, /Subtask 1/);
    assert.match(output, /blocked by: #99/);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { persistManifest } from '../.agents/scripts/lib/presentation/manifest-renderer.js';

test('persistManifest', async (t) => {
  const tempDir = path.join(process.cwd(), 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

  await t.test('writes epic manifest files', () => {
    const manifest = {
      type: 'epic-dispatch',
      epicId: 999,
      epicTitle: 'Test',
      generatedAt: new Date().toISOString(),
      summary: {},
      storyManifest: [],
      waves: [],
    };

    persistManifest(manifest);
    // Per-Epic layout (Epic #1030 Story #1040): manifest moved to
    // `temp/epic-<eid>/manifest.{md,json}`.
    const epicDir = path.join(tempDir, 'epic-999');
    assert.ok(fs.existsSync(path.join(epicDir, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(epicDir, 'manifest.md')));

    fs.rmSync(epicDir, { recursive: true, force: true });
  });

  await t.test('writes story manifest files', () => {
    const manifest = {
      type: 'story-execution',
      stories: [
        {
          storyId: 888,
          storyTitle: 'Eight Eighty-Eight',
          epicId: 1,
          epicBranch: 'epic/1',
          branchName: 'story-888',
          tasks: [],
        },
      ],
      generatedAt: new Date().toISOString(),
    };

    persistManifest(manifest);
    // Per-Epic layout: `temp/epic-<eid>/story-<sid>/manifest.{md,json}`.
    const possibleDirs = [tempDir, path.join(process.cwd(), 'temp')];
    let found = false;
    for (const d of possibleDirs) {
      const storyDir = path.join(d, 'epic-1', 'story-888');
      if (fs.existsSync(path.join(storyDir, 'manifest.json'))) {
        found = true;
        fs.rmSync(path.join(d, 'epic-1'), { recursive: true, force: true });
        break;
      }
    }
    assert.ok(found, 'Should have found the persisted per-Story manifest');
  });
});
