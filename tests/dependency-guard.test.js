import assert from 'node:assert';
import { test } from 'node:test';
import {
  formatBlockerReport,
  loadDispatchManifest,
  validateBlockersMerged,
} from '../.agents/scripts/lib/story-init/dependency-guard.js';

// ---------------------------------------------------------------------------
// validateBlockersMerged — pure function over an in-memory manifest.
// ---------------------------------------------------------------------------

function makeManifest({ epicId = 668, repoSlug, stories } = {}) {
  return {
    epicId,
    ...(repoSlug ? { repoSlug } : {}),
    storyManifest: stories,
  };
}

test('validateBlockersMerged — merged blockers proceed (ok=true)', () => {
  const manifest = makeManifest({
    repoSlug: 'acme/repo',
    stories: [
      {
        storyId: 100,
        storyTitle: 'Upstream',
        earliestWave: 0,
        tasks: [
          { taskId: 1001, status: 'agent::done', dependencies: [] },
          { taskId: 1002, status: 'agent::done', dependencies: [] },
        ],
      },
      {
        storyId: 200,
        storyTitle: 'Downstream',
        earliestWave: 1,
        tasks: [{ taskId: 2001, status: 'agent::ready', dependencies: [1001] }],
      },
    ],
  });
  const result = validateBlockersMerged(manifest, 200);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.blockers, []);
});

test('validateBlockersMerged — task-less wave-fallback blockers defer to live blocked-by gate (3-tier)', () => {
  // 3-tier hierarchy: Stories carry no child Tasks, so manifest entries
  // have empty `tasks` arrays. The wave-fallback heuristic still discovers
  // earlier-wave peers as *potential* blockers, but a task-less Story holds
  // no merge-evidence in the manifest — classifying it as unmerged would
  // be a pure false positive that blocks every wave-1+ Story forever. The
  // guard must skip such entries and defer to the live `blocked by` gate.
  const manifest = makeManifest({
    stories: [
      { storyId: 100, storyTitle: 'Wave 0', earliestWave: 0, tasks: [] },
      { storyId: 150, storyTitle: 'Wave 0b', earliestWave: 0, tasks: [] },
      { storyId: 200, storyTitle: 'Wave 1', earliestWave: 1, tasks: [] },
    ],
  });
  const result = validateBlockersMerged(manifest, 200);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.blockers, []);
});

test('validateBlockersMerged — unmerged blockers reported with state + url', () => {
  const manifest = makeManifest({
    repoSlug: 'acme/repo',
    stories: [
      {
        storyId: 100,
        storyTitle: 'Upstream A',
        earliestWave: 0,
        tasks: [
          { taskId: 1001, status: 'agent::executing', dependencies: [] },
          { taskId: 1002, status: 'agent::done', dependencies: [] },
        ],
      },
      {
        storyId: 150,
        storyTitle: 'Upstream B',
        earliestWave: 0,
        tasks: [{ taskId: 1501, status: 'agent::ready', dependencies: [] }],
      },
      {
        storyId: 200,
        storyTitle: 'Downstream',
        earliestWave: 1,
        tasks: [
          { taskId: 2001, status: 'agent::ready', dependencies: [1001, 1501] },
        ],
      },
    ],
  });
  const result = validateBlockersMerged(manifest, 200);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blockers.length, 2);
  assert.deepStrictEqual(
    result.blockers.map((b) => b.id),
    [100, 150],
  );
  assert.strictEqual(result.blockers[0].title, 'Upstream A');
  assert.strictEqual(result.blockers[0].state, '1/2 tasks done');
  assert.strictEqual(
    result.blockers[0].url,
    'https://github.com/acme/repo/issues/100',
  );
  assert.strictEqual(result.blockers[1].state, '0/1 tasks done');
});

test('validateBlockersMerged — missing repoSlug omits url', () => {
  const manifest = makeManifest({
    stories: [
      {
        storyId: 100,
        storyTitle: 'Upstream',
        earliestWave: 0,
        tasks: [{ taskId: 1001, status: 'agent::ready', dependencies: [] }],
      },
      {
        storyId: 200,
        storyTitle: 'Downstream',
        earliestWave: 1,
        tasks: [{ taskId: 2001, status: 'agent::ready', dependencies: [1001] }],
      },
    ],
  });
  const result = validateBlockersMerged(manifest, 200);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blockers[0].url, undefined);
});

test('validateBlockersMerged — story not in manifest returns ok=true', () => {
  const manifest = makeManifest({ stories: [] });
  const result = validateBlockersMerged(manifest, 999);
  assert.deepStrictEqual(result, { ok: true, blockers: [] });
});

test('validateBlockersMerged — wave-fallback when task graph is unavailable', () => {
  // Wave-fallback fires when the TARGET Story has no parseable task graph
  // (empty tasks), discovering earlier-wave peers as potential blockers.
  // Task-bearing blockers that are not all-done are reported; task-less
  // blockers defer to the live gate (covered by the 3-tier test above).
  const manifest = makeManifest({
    stories: [
      {
        storyId: 100,
        storyTitle: 'Wave 0',
        earliestWave: 0,
        tasks: [{ taskId: 1001, status: 'agent::ready', dependencies: [] }],
      },
      {
        storyId: 150,
        storyTitle: 'Wave 0b',
        earliestWave: 0,
        tasks: [{ taskId: 1501, status: 'agent::ready', dependencies: [] }],
      },
      { storyId: 200, storyTitle: 'Wave 1', earliestWave: 1, tasks: [] },
    ],
  });
  const result = validateBlockersMerged(manifest, 200);
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(
    result.blockers.map((b) => b.id),
    [100, 150],
  );
  for (const b of result.blockers)
    assert.strictEqual(b.state, '0/1 tasks done');
});

test('validateBlockersMerged — task-graph beats wave-fallback when both present', () => {
  // Story 200 only depends on 100 explicitly via task deps; 150 is in an
  // earlier wave but is not a real blocker, so it must NOT appear.
  const manifest = makeManifest({
    stories: [
      {
        storyId: 100,
        storyTitle: 'Real upstream',
        earliestWave: 0,
        tasks: [{ taskId: 1001, status: 'agent::ready', dependencies: [] }],
      },
      {
        storyId: 150,
        storyTitle: 'Unrelated wave-0 peer',
        earliestWave: 0,
        tasks: [{ taskId: 1501, status: 'agent::ready', dependencies: [] }],
      },
      {
        storyId: 200,
        storyTitle: 'Downstream',
        earliestWave: 1,
        tasks: [{ taskId: 2001, status: 'agent::ready', dependencies: [1001] }],
      },
    ],
  });
  const result = validateBlockersMerged(manifest, 200);
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(
    result.blockers.map((b) => b.id),
    [100],
  );
});

test('validateBlockersMerged — string storyId arg is normalised', () => {
  const manifest = makeManifest({
    stories: [
      {
        storyId: 100,
        storyTitle: 'Upstream',
        earliestWave: 0,
        tasks: [{ taskId: 1001, status: 'agent::done', dependencies: [] }],
      },
      {
        storyId: 200,
        storyTitle: 'Downstream',
        earliestWave: 1,
        tasks: [{ taskId: 2001, status: 'agent::ready', dependencies: [1001] }],
      },
    ],
  });
  const result = validateBlockersMerged(manifest, '200');
  assert.strictEqual(result.ok, true);
});

// ---------------------------------------------------------------------------
// loadDispatchManifest — disk-first, comment fallback, missing → warn-reason.
// ---------------------------------------------------------------------------

function makeFsImpl({ files = {} } = {}) {
  return {
    existsSync: (p) => Object.hasOwn(files, p),
    readFileSync: (p) => {
      if (!Object.hasOwn(files, p)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
  };
}

test('loadDispatchManifest — reads on-disk manifest when present', async () => {
  const manifest = {
    epicId: 668,
    storyManifest: [{ storyId: 200, earliestWave: 1, tasks: [] }],
  };
  const projectRoot = '/repo';
  // Per-Epic layout (Epic #1030 Story #1040): manifest path moved from
  // `temp/dispatch-manifest-<eid>.json` to `temp/epic-<eid>/manifest.json`.
  const diskPath = '/repo/temp/epic-668/manifest.json'.replace(
    /\//g,
    process.platform === 'win32' ? '\\' : '/',
  );
  const fsImpl = makeFsImpl({
    files: { [diskPath]: JSON.stringify(manifest) },
  });
  const result = await loadDispatchManifest({
    epicId: 668,
    projectRoot,
    repoSlug: 'acme/repo',
    fsImpl,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.source, 'disk');
  assert.strictEqual(result.manifest.epicId, 668);
  assert.strictEqual(result.manifest.repoSlug, 'acme/repo');
});

test('loadDispatchManifest — falls back to dispatch-manifest comment when disk missing', async () => {
  const fsImpl = makeFsImpl({ files: {} });
  const commentBody = `<!-- ap:structured-comment type="dispatch-manifest" -->

## Dispatch manifest

\`\`\`json
${JSON.stringify({
  stories: [
    { storyId: 100, wave: 0, title: 'Upstream' },
    { storyId: 200, wave: 1, title: 'Downstream' },
  ],
})}
\`\`\`
`;
  const provider = {
    async getTicketComments() {
      return [{ id: 9001, body: commentBody }];
    },
  };
  const result = await loadDispatchManifest({
    epicId: 668,
    projectRoot: '/repo',
    provider,
    fsImpl,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.source, 'comment');
  assert.strictEqual(result.manifest.storyManifest.length, 2);
  assert.strictEqual(result.manifest.storyManifest[0].earliestWave, 0);
});

test('loadDispatchManifest — missing disk + missing comment yields ok=false', async () => {
  const fsImpl = makeFsImpl({ files: {} });
  const provider = {
    async getTicketComments() {
      return [];
    },
  };
  const result = await loadDispatchManifest({
    epicId: 668,
    projectRoot: '/repo',
    provider,
    fsImpl,
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /no-dispatch-manifest-comment/);
});

test('loadDispatchManifest — invalid epicId rejected', async () => {
  const result = await loadDispatchManifest({
    epicId: 0,
    projectRoot: '/repo',
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'invalid-epic-id');
});

test('loadDispatchManifest — comment without parseable JSON returns reason', async () => {
  const fsImpl = makeFsImpl({ files: {} });
  const provider = {
    async getTicketComments() {
      return [
        {
          id: 9002,
          body: '<!-- ap:structured-comment type="dispatch-manifest" -->\n\nno json here',
        },
      ];
    },
  };
  const result = await loadDispatchManifest({
    epicId: 668,
    projectRoot: '/repo',
    provider,
    fsImpl,
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /unparseable/);
});

// ---------------------------------------------------------------------------
// formatBlockerReport — wording lock so callers stay in sync with stderr UX.
// ---------------------------------------------------------------------------

test('formatBlockerReport — includes id, title, state, url and instruction', () => {
  const out = formatBlockerReport(200, [
    {
      id: 100,
      title: 'Upstream',
      state: '0/2 tasks done',
      url: 'https://github.com/acme/repo/issues/100',
    },
  ]);
  assert.match(out, /Story #200 cannot start/);
  assert.match(out, /1 unmerged blocker/);
  assert.match(out, /#100 "Upstream"/);
  assert.match(out, /state: 0\/2 tasks done/);
  assert.match(out, /https:\/\/github\.com\/acme\/repo\/issues\/100/);
  assert.match(out, /\/epic-plan/);
});
