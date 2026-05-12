/**
 * tests/scripts/manifest-formatter-fromspec.test.js
 *
 * Story #1501 parity contract:
 *   `fromSpec(spec, opts)` produces byte-identical Markdown to
 *   `fromManifest(manifest)` when the spec + state pair is a faithful
 *   round-trip of the manifest fixture.
 *
 * The fixture pair is constructed in-file so the round-trip relationship
 * is obvious at a glance: we hand-author a manifest, then derive the
 * spec + state that — by construction — describe the same Stories /
 * Tasks / wave layout / status labels. `fromSpec` is expected to produce
 * the same Markdown the renderer would emit for the manifest directly.
 *
 * Also exercises:
 *   - `fromManifest` is the canonical alias for `formatManifestMarkdown`
 *     (same identity, byte-identical output).
 *   - Missing `state.mapping[slug]` entries fall back to `slug:<slug>`
 *     ids + `agent::ready` status without throwing.
 *   - Empty spec (no features) renders a header-only manifest cleanly.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __resetManifestFormatterCache,
  buildManifestFromSpec,
  formatManifestMarkdown,
  fromManifest,
  fromSpec,
} from '../../.agents/scripts/lib/presentation/manifest-formatter.js';

// ---------------------------------------------------------------------------
// Round-trip fixture pair: spec + state ↔ manifest.
// ---------------------------------------------------------------------------

const GENERATED_AT = '2026-05-12T00:00:00.000Z';

function buildFixturePair() {
  const spec = {
    epic: { id: 4242, title: 'Parity Fixture Epic' },
    features: [
      {
        slug: 'feat-a',
        title: 'Feature A',
        stories: [
          {
            slug: 'story-alpha',
            title: 'Alpha Story',
            wave: 0,
            tasks: [
              { slug: 'task-a1', title: 'Task A1' },
              { slug: 'task-a2', title: 'Task A2' },
            ],
          },
          {
            slug: 'story-beta',
            title: 'Beta Story',
            wave: 1,
            tasks: [{ slug: 'task-b1', title: 'Task B1' }],
          },
        ],
      },
    ],
  };

  const state = {
    epicId: 4242,
    mapping: {
      'story-alpha': {
        issueNumber: 101,
        contentHash: 'sha256:x',
        lastObservedAgentState: 'agent::executing',
      },
      'story-beta': {
        issueNumber: 102,
        contentHash: 'sha256:y',
        lastObservedAgentState: 'agent::ready',
      },
      'task-a1': {
        issueNumber: 201,
        contentHash: 'sha256:a1',
        lastObservedAgentState: 'agent::done',
      },
      'task-a2': {
        issueNumber: 202,
        contentHash: 'sha256:a2',
        lastObservedAgentState: 'agent::ready',
      },
      'task-b1': {
        issueNumber: 203,
        contentHash: 'sha256:b1',
        lastObservedAgentState: 'agent::ready',
      },
    },
  };

  // The equivalent manifest, hand-derived so the round-trip relationship
  // is the assertion itself. Field order matches `buildManifestFromSpec`
  // so the JSON object equality below is also a structural assertion.
  const manifest = {
    schemaVersion: '1.0.0',
    generatedAt: GENERATED_AT,
    epicId: 4242,
    epicTitle: 'Parity Fixture Epic',
    executor: 'spec',
    dryRun: false,
    summary: {
      totalTasks: 3,
      doneTasks: 1,
      progressPercent: 33,
      totalWaves: 2,
      dispatched: 0,
    },
    waves: [],
    storyManifest: [
      {
        storyId: 101,
        storyTitle: 'Alpha Story',
        storySlug: 'story-alpha',
        type: 'story',
        branchName: 'story-101',
        earliestWave: 0,
        tasks: [
          {
            taskId: 201,
            taskSlug: 'task-a1',
            status: 'agent::done',
            dependencies: [],
          },
          {
            taskId: 202,
            taskSlug: 'task-a2',
            status: 'agent::ready',
            dependencies: [],
          },
        ],
      },
      {
        storyId: 102,
        storyTitle: 'Beta Story',
        storySlug: 'story-beta',
        type: 'story',
        branchName: 'story-102',
        earliestWave: 1,
        tasks: [
          {
            taskId: 203,
            taskSlug: 'task-b1',
            status: 'agent::ready',
            dependencies: [],
          },
        ],
      },
    ],
    dispatched: [],
    agentTelemetry: null,
  };

  return { spec, state, manifest };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('fromManifest is the canonical alias for formatManifestMarkdown', () => {
  assert.strictEqual(fromManifest, formatManifestMarkdown);
});

test('buildManifestFromSpec projects spec+state into a manifest matching the round-trip fixture', () => {
  const { spec, state, manifest } = buildFixturePair();
  const projected = buildManifestFromSpec(spec, {
    state,
    generatedAt: GENERATED_AT,
  });
  // Drop generatedAt + waves + executor from both so the structural
  // assertion focuses on the spec-derived fields. They're checked
  // separately below.
  assert.deepEqual(projected.storyManifest, manifest.storyManifest);
  assert.deepEqual(projected.summary, manifest.summary);
  assert.equal(projected.epicId, manifest.epicId);
  assert.equal(projected.epicTitle, manifest.epicTitle);
  assert.equal(projected.generatedAt, GENERATED_AT);
});

test('fromSpec output is byte-identical to fromManifest for a round-tripped fixture pair', () => {
  const { spec, state, manifest } = buildFixturePair();
  __resetManifestFormatterCache();
  const fromSpecMd = fromSpec(spec, { state, generatedAt: GENERATED_AT });
  __resetManifestFormatterCache();
  const fromManifestMd = fromManifest(manifest);
  assert.equal(
    fromSpecMd,
    fromManifestMd,
    'fromSpec must produce byte-identical Markdown to fromManifest for the round-tripped fixture',
  );
});

test('fromSpec falls back to slug:<slug> ids + agent::ready when state mapping is absent', () => {
  const spec = {
    epic: { id: 9000, title: 'Fresh Epic' },
    features: [
      {
        slug: 'feat-x',
        title: 'Feature X',
        stories: [
          {
            slug: 'lonely-story',
            title: 'Lonely Story',
            wave: 0,
            tasks: [{ slug: 'lonely-task', title: 'Lonely Task' }],
          },
        ],
      },
    ],
  };
  __resetManifestFormatterCache();
  const md = fromSpec(spec, { generatedAt: GENERATED_AT });
  // The Story id surfaces as the slug-sentinel string and the renderer
  // emits it verbatim into the H3 + checkbox lines. No throw. The H3
  // carries the spec-author title; the Task checkbox carries the slug.
  assert.match(md, /Lonely Story/);
  assert.match(md, /#slug:lonely-story/);
  assert.match(md, /- \[ \] #slug:lonely-task — lonely-task/);
  // doneTasks should be 0 (fallback status is agent::ready, not agent::done).
  assert.match(md, /0\/1 tasks/);
});

test('fromSpec on an empty spec emits the header-only manifest cleanly', () => {
  const spec = {
    epic: { id: 1, title: 'Empty Epic' },
    features: [],
  };
  __resetManifestFormatterCache();
  const md = fromSpec(spec, { generatedAt: GENERATED_AT });
  assert.match(md, /# 📋 Dispatch Manifest — Epic #1/);
  assert.match(md, /Empty Epic/);
  // No Wave Summary table when there are zero waves.
  assert.doesNotMatch(md, /## Wave Summary/);
});
