import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  deleteLegacyFlatManifest,
  persistManifest,
} from '../../.agents/scripts/lib/presentation/manifest-persistence.js';

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-persist-'));
}

test('persistence: writes dispatch-manifest json + md under per-Epic dir', () => {
  const root = makeTmpRoot();
  const manifest = {
    epicId: 999077,
    epicTitle: 'Epic Seventy-Seven',
    dryRun: false,
    generatedAt: '2026-04-20T00:00:00.000Z',
    summary: {
      totalTasks: 1,
      doneTasks: 0,
      progressPercent: 0,
      dispatched: 0,
      totalWaves: 1,
    },
    storyManifest: [
      {
        storyId: 1,
        storySlug: 's1',
        type: 'story',
        earliestWave: 0,
        branchName: 'story-1',
        tasks: [{ taskId: 10, taskSlug: 't', status: 'agent::ready' }],
      },
    ],
  };
  const result = persistManifest(manifest, { projectRoot: root });
  const mdPath = path.join(root, 'temp', 'epic-999077', 'manifest.md');
  const jsonPath = path.join(root, 'temp', 'epic-999077', 'manifest.json');
  assert.deepEqual(result, {
    persisted: true,
    path: jsonPath,
    error: null,
  });
  assert.ok(fs.existsSync(mdPath), 'epic-999077/manifest.md missing');
  assert.ok(fs.existsSync(jsonPath), 'epic-999077/manifest.json missing');
  const md = fs.readFileSync(mdPath, 'utf8');
  assert.ok(md.includes('Dispatch Manifest — Epic #999077'));
  const epicDirEntries = fs.readdirSync(path.join(root, 'temp', 'epic-999077'));
  assert.ok(
    !epicDirEntries.some((f) => f.endsWith('.tmp')),
    'no .tmp residue should remain after successful write',
  );
});

test('persistence: writes story-manifest json + md under per-Story dir', () => {
  const root = makeTmpRoot();
  const manifest = {
    type: 'story-execution',
    generatedAt: '2026-04-20T00:00:00.000Z',
    stories: [
      {
        storyId: 42,
        storyTitle: 'Forty-Two',
        epicId: 999099,
        epicBranch: 'epic/999099',
        branchName: 'story-42',
        tasks: [{ taskId: 100, title: 'Do it', status: 'agent::ready' }],
      },
    ],
  };
  persistManifest(manifest, {
    projectRoot: root,
    agentSettings: {
      paths: { scriptsRoot: '.agents/scripts' },
      commands: {
        validate: 'npm run lint',
        test: 'npm test',
      },
    },
  });
  const mdPath = path.join(
    root,
    'temp',
    'epic-999099',
    'story-42',
    'manifest.md',
  );
  const jsonPath = path.join(
    root,
    'temp',
    'epic-999099',
    'story-42',
    'manifest.json',
  );
  assert.ok(fs.existsSync(mdPath), 'epic-999099/story-42/manifest.md missing');
  assert.ok(
    fs.existsSync(jsonPath),
    'epic-999099/story-42/manifest.json missing',
  );
  const md = fs.readFileSync(mdPath, 'utf8');
  assert.ok(md.includes('Story #42'));
  assert.ok(md.includes('.agents/scripts/story-init.js'));
});

test('persistence: story-execution manifest with no epicId falls back to legacy flat layout', () => {
  const root = makeTmpRoot();
  const manifest = {
    type: 'story-execution',
    generatedAt: '2026-04-20T00:00:00.000Z',
    stories: [
      {
        storyId: 42,
        storyTitle: 'Forty-Two (no epic)',
        branchName: 'story-42',
        tasks: [],
      },
    ],
  };
  persistManifest(manifest, {
    projectRoot: root,
    agentSettings: {
      paths: { scriptsRoot: '.agents/scripts' },
      commands: { validate: 'npm run lint', test: 'npm test' },
    },
  });
  const legacyMd = path.join(root, 'temp', 'story-manifest-42.md');
  const legacyJson = path.join(root, 'temp', 'story-manifest-42.json');
  assert.ok(fs.existsSync(legacyMd), 'legacy flat .md missing');
  assert.ok(fs.existsSync(legacyJson), 'legacy flat .json missing');
});

test('persistence: creates per-Epic temp dir if missing', () => {
  const root = makeTmpRoot();
  assert.ok(!fs.existsSync(path.join(root, 'temp')));
  persistManifest(
    {
      epicId: 999_001,
      epicTitle: 'e',
      dryRun: false,
      generatedAt: 'now',
      summary: {
        totalTasks: 0,
        doneTasks: 0,
        progressPercent: 0,
        dispatched: 0,
        totalWaves: 0,
      },
      storyManifest: [],
    },
    { projectRoot: root },
  );
  assert.ok(fs.existsSync(path.join(root, 'temp', 'epic-999001')));
});

test('persistence: no-op for manifest with neither story-execution type nor epicId', () => {
  const root = makeTmpRoot();
  persistManifest({ generatedAt: 'x' }, { projectRoot: root });
  const tempDir = path.join(root, 'temp');
  if (fs.existsSync(tempDir)) {
    assert.deepEqual(fs.readdirSync(tempDir), []);
  }
});

test('persistence: returns { persisted:false, error } on fs failure instead of throwing', () => {
  // Pointing at an invalid root forces fs.mkdirSync to fail; the function
  // must capture the error and return it rather than throwing.
  let result;
  assert.doesNotThrow(() => {
    result = persistManifest(
      {
        epicId: 999_001,
        epicTitle: 'e',
        dryRun: false,
        generatedAt: 'now',
        summary: {
          totalTasks: 0,
          doneTasks: 0,
          progressPercent: 0,
          dispatched: 0,
          totalWaves: 0,
        },
        storyManifest: [],
      },
      { projectRoot: '\0/invalid' },
    );
  });
  assert.equal(result.persisted, false);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0);
  assert.ok(result.path?.includes('manifest.json'));
});

function seedOrphans(root, epicId) {
  const epicDir = path.join(root, 'temp', `epic-${epicId}`);
  fs.mkdirSync(epicDir, { recursive: true });
  const md = path.join(epicDir, `dispatch-manifest-${epicId}.md`);
  const json = path.join(epicDir, `dispatch-manifest-${epicId}.json`);
  fs.writeFileSync(md, 'x');
  fs.writeFileSync(json, '{}');
  return { epicDir, md, json };
}

test('sweep: deleteLegacyFlatManifest removes both orphans + logs once', () => {
  const root = makeTmpRoot();
  const { md, json } = seedOrphans(root, 999077);
  const messages = [];
  const result = deleteLegacyFlatManifest(999077, {
    projectRoot: root,
    logger: { info: (m) => messages.push(m) },
  });
  assert.equal(result.removed.length, 2);
  assert.ok(!fs.existsSync(md));
  assert.ok(!fs.existsSync(json));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Epic #999077/);
});

test('sweep: deleteLegacyFlatManifest is a no-op when orphans are absent', () => {
  const root = makeTmpRoot();
  fs.mkdirSync(path.join(root, 'temp', 'epic-999077'), { recursive: true });
  const messages = [];
  const result = deleteLegacyFlatManifest(999077, {
    projectRoot: root,
    logger: { info: (m) => messages.push(m) },
  });
  assert.deepEqual(result.removed, []);
  assert.equal(messages.length, 0);
});

test('sweep: deleteLegacyFlatManifest defaults to the framework project root safely', () => {
  const result = deleteLegacyFlatManifest(999_078, {
    logger: { info: () => assert.fail('no orphan should be swept') },
  });
  assert.deepEqual(result.removed, []);
});

test('sweep: deleteLegacyFlatManifest is idempotent across calls', () => {
  const root = makeTmpRoot();
  seedOrphans(root, 999077);
  const first = deleteLegacyFlatManifest(999077, { projectRoot: root });
  const second = deleteLegacyFlatManifest(999077, { projectRoot: root });
  assert.equal(first.removed.length, 2);
  assert.deepEqual(second.removed, []);
});

test('sweep: persistManifest invokes the sweep on Epic dispatch render', () => {
  const root = makeTmpRoot();
  const { epicDir, md, json } = seedOrphans(root, 999077);
  persistManifest(
    {
      epicId: 999077,
      epicTitle: 'Epic 999077',
      dryRun: false,
      generatedAt: 'now',
      summary: {
        totalTasks: 0,
        doneTasks: 0,
        progressPercent: 0,
        dispatched: 0,
        totalWaves: 0,
      },
      storyManifest: [],
    },
    { projectRoot: root },
  );
  assert.ok(!fs.existsSync(md));
  assert.ok(!fs.existsSync(json));
  assert.ok(fs.existsSync(path.join(epicDir, 'manifest.md')));
  assert.ok(fs.existsSync(path.join(epicDir, 'manifest.json')));
});

test('persistence: on writeFileSync failure, no .tmp residue remains and final path untouched', () => {
  const root = makeTmpRoot();
  const manifest = {
    epicId: 999099,
    epicTitle: 'Epic 999099',
    dryRun: false,
    generatedAt: 'now',
    summary: {
      totalTasks: 0,
      doneTasks: 0,
      progressPercent: 0,
      dispatched: 0,
      totalWaves: 0,
    },
    storyManifest: [],
  };

  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (targetPath, ...rest) => {
    if (String(targetPath).endsWith('.tmp')) {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    }
    return originalWriteFileSync(targetPath, ...rest);
  };
  let result;
  try {
    result = persistManifest(manifest, { projectRoot: root });
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(result.persisted, false);
  assert.match(result.error, /EACCES/);

  const epicDir = path.join(root, 'temp', 'epic-999099');
  const entries = fs.existsSync(epicDir) ? fs.readdirSync(epicDir) : [];
  assert.ok(
    !entries.some((f) => f.endsWith('.tmp')),
    `no .tmp residue should remain; saw: ${entries.join(', ')}`,
  );
  const finalJson = path.join(epicDir, 'manifest.json');
  assert.ok(
    !fs.existsSync(finalJson),
    'final epic-999099/manifest.json should not exist after failed write',
  );
});
