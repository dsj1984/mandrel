/**
 * tests/scripts/dispatcher-fromspec.test.js
 *
 * Story #1501 — dispatcher routing contract:
 *   1. When a spec file exists alongside the Epic, the dispatcher
 *      renders the Markdown manifest via `fromSpec` (returns a non-null
 *      pre-rendered string).
 *   2. When the spec file is absent, the dispatcher falls back to
 *      `fromManifest` (returns null, signalling "no spec markdown
 *      override — let persistManifest use the renderer's default
 *      formatManifestMarkdown path").
 *
 * Drives the `tryRenderFromSpec` injection seam directly so the test
 * doesn't depend on a live GitHub provider or fs writes under
 * `.agents/epics/`. The seam mirrors the loader signature exactly
 * (`(epicId, loaderOpts)`) so the swap is transparent: production
 * callers get the real `loadSpec` / `loadState` from `lib/spec/index.js`,
 * tests get this in-memory pair.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  overlayLiveTaskStateFromManifest,
  tryRenderFromSpec,
} from '../../.agents/scripts/dispatcher.js';
import { SpecNotFoundError } from '../../.agents/scripts/lib/spec/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL_SPEC = {
  epic: { id: 7777, title: 'Dispatcher Routing Fixture' },
  features: [
    {
      slug: 'feat-routing',
      title: 'Routing Feature',
      stories: [
        {
          slug: 'story-routing',
          title: 'Routing Story',
          wave: 0,
          tasks: [{ slug: 'task-routing', title: 'Routing Task' }],
        },
      ],
    },
  ],
};

const MINIMAL_STATE = {
  epicId: 7777,
  mapping: {
    'story-routing': {
      issueNumber: 5001,
      contentHash: 'sha256:x',
      lastObservedAgentState: 'agent::ready',
    },
    'task-routing': {
      issueNumber: 5002,
      contentHash: 'sha256:y',
      lastObservedAgentState: 'agent::ready',
    },
  },
};

function buildManifest(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    generatedAt: '2026-05-12T00:00:00.000Z',
    epicId: 7777,
    epicTitle: 'Dispatcher Routing Fixture',
    executor: 'mock',
    dryRun: false,
    summary: {
      totalTasks: 1,
      doneTasks: 0,
      progressPercent: 0,
      totalWaves: 1,
      dispatched: 0,
    },
    waves: [],
    storyManifest: [
      {
        storyId: 5001,
        storyTitle: 'Routing Story',
        storySlug: 'story-routing',
        type: 'story',
        branchName: 'story-5001',
        earliestWave: 0,
        tasks: [
          {
            taskId: 5002,
            taskSlug: 'task-routing',
            status: 'agent::ready',
            dependencies: [],
          },
        ],
      },
    ],
    dispatched: [],
    agentTelemetry: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory loaders (mirror the real loader API)
// ---------------------------------------------------------------------------

function buildSpecPresentLoaders() {
  let loadSpecCalls = 0;
  let loadStateCalls = 0;
  return {
    loadSpec: (epicId) => {
      loadSpecCalls++;
      assert.equal(epicId, 7777);
      return MINIMAL_SPEC;
    },
    loadState: (epicId) => {
      loadStateCalls++;
      assert.equal(epicId, 7777);
      return MINIMAL_STATE;
    },
    callCounts: () => ({ loadSpecCalls, loadStateCalls }),
  };
}

function buildSpecAbsentLoaders() {
  return {
    loadSpec: (epicId) => {
      throw new SpecNotFoundError(
        String(epicId),
        path.join('phantom', `${epicId}.yaml`),
      );
    },
    loadState: () => ({ epicId: 0, mapping: {} }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('tryRenderFromSpec returns spec-rendered Markdown when the spec is present', () => {
  const loaders = buildSpecPresentLoaders();
  const manifest = buildManifest();
  const md = tryRenderFromSpec(manifest, {
    loadSpec: loaders.loadSpec,
    loadState: loaders.loadState,
  });
  assert.equal(typeof md, 'string', 'expected pre-rendered Markdown string');
  assert.match(md, /# 📋 Dispatch Manifest — Epic #7777/);
  assert.match(md, /Dispatcher Routing Fixture/);
  // Spec-routed render exercises the slug→issueNumber mapping in state.
  assert.match(md, /Routing Story/);
  assert.match(md, /#5001/);
  // Under the 3-tier hierarchy (Epic #3163, Story #3196) Stories are
  // leaves; the per-Story body collapses to the empty-tasks marker
  // and the renderer no longer emits per-Task checkbox rows.
  assert.match(md, /_\(no tasks\)_/);
  assert.doesNotMatch(md, /- \[ \] #5002 — task-routing/);
  // Each loader is invoked exactly once per render.
  const { loadSpecCalls, loadStateCalls } = loaders.callCounts();
  assert.equal(loadSpecCalls, 1);
  assert.equal(loadStateCalls, 1);
});

test('tryRenderFromSpec returns null (fallback signal) when the spec file is absent', () => {
  const loaders = buildSpecAbsentLoaders();
  const manifest = buildManifest();
  const md = tryRenderFromSpec(manifest, {
    loadSpec: loaders.loadSpec,
    loadState: loaders.loadState,
  });
  assert.equal(
    md,
    null,
    'no spec → null Markdown override → dispatcher falls back to formatManifestMarkdown',
  );
});

test('tryRenderFromSpec returns null for story-execution manifests (never spec-routed)', () => {
  const loaders = buildSpecPresentLoaders();
  const manifest = buildManifest({ type: 'story-execution', stories: [] });
  const md = tryRenderFromSpec(manifest, {
    loadSpec: loaders.loadSpec,
    loadState: loaders.loadState,
  });
  assert.equal(md, null);
  // The Story-execution short-circuit must avoid loader calls entirely.
  const { loadSpecCalls } = loaders.callCounts();
  assert.equal(loadSpecCalls, 0);
});

test('tryRenderFromSpec returns null when the manifest has no epicId', () => {
  const loaders = buildSpecPresentLoaders();
  const md = tryRenderFromSpec(
    { generatedAt: '2026-01-01' },
    {
      loadSpec: loaders.loadSpec,
      loadState: loaders.loadState,
    },
  );
  assert.equal(md, null);
  const { loadSpecCalls } = loaders.callCounts();
  assert.equal(loadSpecCalls, 0);
});

// ---------------------------------------------------------------------------
// Real-loader integration: drive `loadSpec` against a sandbox `.agents/epics/`
// directory so the on-disk path is exercised end-to-end.
// ---------------------------------------------------------------------------

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'dispatcher-fromspec-'));
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

test('tryRenderFromSpec round-trips through the real loader against a sandbox spec', () => {
  // Epic #3163: Stories are leaves under the 3-tier hierarchy, so the
  // on-disk spec carries no Story.tasks[]. The real-loader round-trip
  // surfaces the Story and collapses its body to the empty-tasks marker.
  const yaml = `epic:\n  id: 7777\n  title: 'Dispatcher Routing Fixture'\nfeatures:\n  - slug: feat-routing\n    title: 'Routing Feature'\n    stories:\n      - slug: story-routing\n        title: 'Routing Story'\n        wave: 0\n`;
  writeFileSync(path.join(sandbox, '7777.yaml'), yaml, 'utf8');
  writeFileSync(
    path.join(sandbox, '7777.state.json'),
    JSON.stringify(MINIMAL_STATE, null, 2),
    'utf8',
  );

  const manifest = buildManifest();
  const md = tryRenderFromSpec(manifest, {
    loaderOpts: { epicsDir: sandbox },
  });
  assert.equal(typeof md, 'string');
  assert.match(md, /Routing Story/);
  assert.match(md, /_\(no tasks\)_/);
  assert.doesNotMatch(md, /task-routing/);
});

test('tryRenderFromSpec returns null when the sandbox spec is missing', () => {
  const manifest = buildManifest();
  const md = tryRenderFromSpec(manifest, {
    loaderOpts: { epicsDir: sandbox },
  });
  assert.equal(md, null);
});

// ---------------------------------------------------------------------------
// overlayLiveTaskStateFromManifest — 3-tier overlay (Epic #3163, Story #3206).
// The runtime manifest's wave records carry `stories[]` (each with a live
// `storyId` + `status`), not the retired Task-tier `tasks[]` shape. The
// overlay must copy each Story's status onto the matching slug.
// ---------------------------------------------------------------------------

function buildStateWithStorySlug() {
  return {
    epicId: 7777,
    mapping: {
      'story-routing': {
        issueNumber: 5001,
        contentHash: 'sha256:x',
        lastObservedAgentState: 'agent::ready',
      },
    },
  };
}

test('overlayLiveTaskStateFromManifest copies live Story status onto the matching slug', () => {
  const state = buildStateWithStorySlug();
  const manifest = {
    waves: [
      {
        waveIndex: 0,
        stories: [{ storyId: 5001, status: 'agent::done' }],
      },
    ],
  };
  const result = overlayLiveTaskStateFromManifest(state, manifest);
  assert.equal(
    result.mapping['story-routing'].lastObservedAgentState,
    'agent::done',
  );
});

test('overlayLiveTaskStateFromManifest ignores non-agent statuses and unknown storyIds', () => {
  const state = buildStateWithStorySlug();
  const manifest = {
    waves: [
      {
        waveIndex: 0,
        stories: [
          { storyId: 5001, status: 'in-progress' },
          { storyId: 9999, status: 'agent::done' },
        ],
      },
    ],
  };
  const result = overlayLiveTaskStateFromManifest(state, manifest);
  // Non-`agent::*` status is not applied; unknown storyId has no slug.
  assert.equal(
    result.mapping['story-routing'].lastObservedAgentState,
    'agent::ready',
  );
});

test('overlayLiveTaskStateFromManifest is a safe no-op on null/empty inputs', () => {
  assert.equal(overlayLiveTaskStateFromManifest(null, {}), null);
  assert.equal(overlayLiveTaskStateFromManifest(undefined, {}), undefined);
  const state = buildStateWithStorySlug();
  // A wave with no `stories[]` array (e.g. the retired tasks-only shape)
  // is skipped without throwing and leaves state untouched.
  const result = overlayLiveTaskStateFromManifest(state, {
    waves: [{ waveIndex: 0, tasks: [{ taskId: 5001, status: 'agent::done' }] }],
  });
  assert.equal(
    result.mapping['story-routing'].lastObservedAgentState,
    'agent::ready',
  );
});
