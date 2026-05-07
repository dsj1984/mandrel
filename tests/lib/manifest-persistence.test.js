import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { persistManifest } from '../../.agents/scripts/lib/presentation/manifest-persistence.js';

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-persist-'));
}

test('persistence: writes dispatch-manifest json + md under per-Epic dir', () => {
  const root = makeTmpRoot();
  const manifest = {
    epicId: 77,
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
  const mdPath = path.join(root, 'temp', 'epic-77', 'manifest.md');
  const jsonPath = path.join(root, 'temp', 'epic-77', 'manifest.json');
  assert.deepEqual(result, {
    persisted: true,
    path: jsonPath,
    error: null,
  });
  assert.ok(fs.existsSync(mdPath), 'epic-77/manifest.md missing');
  assert.ok(fs.existsSync(jsonPath), 'epic-77/manifest.json missing');
  const md = fs.readFileSync(mdPath, 'utf8');
  assert.ok(md.includes('Dispatch Manifest — Epic #77'));
  const epicDirEntries = fs.readdirSync(path.join(root, 'temp', 'epic-77'));
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
        epicId: 99,
        epicBranch: 'epic/99',
        branchName: 'story-42',
        tasks: [{ taskId: 100, title: 'Do it', status: 'agent::ready' }],
      },
    ],
  };
  persistManifest(manifest, {
    projectRoot: root,
    settings: {
      paths: { scriptsRoot: '.agents/scripts' },
      commands: {
        validate: 'npm run lint',
        test: 'npm test',
      },
    },
  });
  const mdPath = path.join(root, 'temp', 'epic-99', 'story-42', 'manifest.md');
  const jsonPath = path.join(
    root,
    'temp',
    'epic-99',
    'story-42',
    'manifest.json',
  );
  assert.ok(fs.existsSync(mdPath), 'epic-99/story-42/manifest.md missing');
  assert.ok(fs.existsSync(jsonPath), 'epic-99/story-42/manifest.json missing');
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
    settings: {
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
      epicId: 1,
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
  assert.ok(fs.existsSync(path.join(root, 'temp', 'epic-1')));
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
        epicId: 1,
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

test('persistence: on writeFileSync failure, no .tmp residue remains and final path untouched', () => {
  const root = makeTmpRoot();
  const manifest = {
    epicId: 99,
    epicTitle: 'Epic 99',
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

  const epicDir = path.join(root, 'temp', 'epic-99');
  const entries = fs.existsSync(epicDir) ? fs.readdirSync(epicDir) : [];
  assert.ok(
    !entries.some((f) => f.endsWith('.tmp')),
    `no .tmp residue should remain; saw: ${entries.join(', ')}`,
  );
  const finalJson = path.join(epicDir, 'manifest.json');
  assert.ok(
    !fs.existsSync(finalJson),
    'final epic-99/manifest.json should not exist after failed write',
  );
});
