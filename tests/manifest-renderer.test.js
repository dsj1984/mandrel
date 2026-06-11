import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  persistManifest,
  renderManifestMarkdown,
  renderStoryManifestMarkdown,
} from '../.agents/scripts/lib/presentation/manifest-renderer.js';

// ---------------------------------------------------------------------------
// Shared Fixtures
// ---------------------------------------------------------------------------

function makeStory(storyId, status = 'agent::ready', wave = 0) {
  return {
    storyId,
    storyTitle: `Story ${storyId}`,
    storySlug: `story-${storyId}`,
    type: 'story',
    branchName: `story-${storyId}`,
    earliestWave: wave,
    status,
  };
}

function makeBaseManifest(overrides = {}) {
  return {
    epicId: 100,
    epicTitle: 'Test Epic Title',
    generatedAt: '2026-01-01T00:00:00.000Z',
    dryRun: false,
    summary: {
      totalStories: 0,
      doneStories: 0,
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
    assert.match(output, /\/deliver/);
  });

  await t.test('header meta line carries done/total story counts', () => {
    const manifest = makeBaseManifest({
      summary: {
        totalStories: 4,
        doneStories: 0,
        progressPercent: 0,
        totalWaves: 1,
        dispatched: 0,
      },
      storyManifest: [
        makeStory(1, 'agent::ready', 0),
        makeStory(2, 'agent::ready', 0),
        makeStory(3, 'agent::ready', 0),
        makeStory(4, 'agent::ready', 0),
      ],
    });
    const output = renderManifestMarkdown(manifest);
    assert.match(output, /0\/4 stories/);
    // No residual Task-tier count.
    assert.doesNotMatch(output, /tasks/);
    // Hero progress block + status emoji are gone — the meta line carries
    // the totals and the Wave Summary table breaks them down per wave.
    assert.doesNotMatch(output, /Sprint Progress/);
    assert.doesNotMatch(output, /🏗️|🔥|🎉/);
  });

  await t.test('renders wave summary table for stories', () => {
    const story = makeStory(10, 'agent::ready', 0);
    const manifest = makeBaseManifest({
      summary: {
        totalStories: 1,
        doneStories: 0,
        progressPercent: 0,
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
    const story = makeStory(10, 'agent::ready', 0);
    const manifest = makeBaseManifest({ storyManifest: [story] });
    const output = renderManifestMarkdown(manifest);
    assert.match(output, /🚀 Ready/);
  });

  await t.test('marks wave as Done when all stories are done', () => {
    // Story #3194 / #3413 (Epic #3163): wave Done is derived from Story
    // status. The Story carries its own `status` on the entry.
    const story = makeStory(10, 'agent::done', 0);
    const manifest = makeBaseManifest({
      summary: {
        totalStories: 1,
        doneStories: 1,
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
    const story0 = makeStory(10, 'agent::ready', 0);
    const story1 = makeStory(11, 'agent::ready', 1);
    const manifest = makeBaseManifest({ storyManifest: [story0, story1] });
    const output = renderManifestMarkdown(manifest);
    assert.match(output, /⏳ Blocked/);
  });

  await t.test('renders nested per-wave H2 with Story headings', () => {
    const story = makeStory(10, 'agent::ready', 0);
    const manifest = makeBaseManifest({ storyManifest: [story] });
    const output = renderManifestMarkdown(manifest);
    // Legacy "## Execution Plan" was retired in Story #1194 Task #1212.
    assert.doesNotMatch(output, /## Execution Plan/);
    assert.match(output, /^## .* Wave 0/m); // per-wave H2
    assert.match(output, /^### .* #10/m); // per-Story H3 with id
    // Under the 2-tier hierarchy (Epic #3163, Story #3413) Stories are
    // leaves; no per-Task body or checkbox row is emitted.
    assert.doesNotMatch(output, /_\(no tasks\)_/);
    assert.doesNotMatch(output, /- \[ \]/);
  });

  await t.test('renders completed story with checkmark', () => {
    const story = makeStory(10, 'agent::done', 0);
    const manifest = makeBaseManifest({ storyManifest: [story] });
    const output = renderManifestMarkdown(manifest);
    assert.match(output, /✅/);
  });

  await t.test('never renders a Feature Containers section (2-tier)', () => {
    const story = makeStory(10, 'agent::ready', 0);
    const manifest = makeBaseManifest({ storyManifest: [story] });
    const output = renderManifestMarkdown(manifest);
    assert.doesNotMatch(output, /Feature Containers/);
    // No residual Child Tasks column either.
    assert.doesNotMatch(output, /Child Tasks/);
    assert.match(output, /Wave 0/);
  });

  await t.test('renders multiple waves in correct order', () => {
    const s0 = makeStory(10, 'agent::done', 0);
    const s1 = makeStory(11, 'agent::ready', 1);
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
});

test('persistManifest', async (t) => {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'manifest-renderer-persist-'),
  );
  const tempDir = path.join(projectRoot, 'temp');
  t.after(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  await t.test('writes epic manifest files', () => {
    const manifest = {
      type: 'epic-dispatch',
      epicId: 999_100,
      epicTitle: 'Test',
      generatedAt: new Date().toISOString(),
      summary: {},
      storyManifest: [],
      waves: [],
    };

    persistManifest(manifest, { projectRoot });
    // Per-Epic layout (Epic #1030 Story #1040): manifest moved to
    // `temp/epic-<eid>/manifest.{md,json}`.
    const epicDir = path.join(tempDir, 'epic-999100');
    assert.ok(fs.existsSync(path.join(epicDir, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(epicDir, 'manifest.md')));
  });

  await t.test('writes story manifest files', () => {
    const manifest = {
      type: 'story-execution',
      stories: [
        {
          storyId: 888,
          storyTitle: 'Eight Eighty-Eight',
          epicId: 999_001,
          epicBranch: 'epic/999001',
          branchName: 'story-888',
          tasks: [],
        },
      ],
      generatedAt: new Date().toISOString(),
    };

    persistManifest(manifest, { projectRoot });
    // Per-Epic layout: `temp/epic-<eid>/stories/story-<sid>/manifest.{md,json}`.
    const storyDir = path.join(tempDir, 'epic-999001', 'stories', 'story-888');
    assert.ok(
      fs.existsSync(path.join(storyDir, 'manifest.json')),
      'per-Story manifest.json',
    );
    assert.ok(
      fs.existsSync(path.join(storyDir, 'manifest.md')),
      'per-Story manifest.md',
    );
  });
});
