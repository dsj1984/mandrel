/**
 * Unit tests for `lib/config/temp-paths.js` (Epic #1030 Story #1039 / Task
 * #1051). Covers the five named helpers, the missing-tempRoot fallback,
 * argument validation, and Windows-friendly `path.join` normalization
 * (no double-slashes regardless of how the operator wrote `tempRoot`).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  epicArtifactPath,
  epicManifestPath,
  epicPerfReportPath,
  epicPrdPath,
  epicRetroMirrorPath,
  epicTechSpecPath,
  epicTempDir,
  signalsFile,
  storyArtifactPath,
  storyManifestPath,
  storyPerfSummaryPath,
  storyTempDir,
  tempRootFrom,
} from '../../../.agents/scripts/lib/config/temp-paths.js';

const SEP = path.sep;

describe('lib/config/temp-paths.js — tempRoot resolution', () => {
  it('returns "temp" when no config is provided', () => {
    assert.equal(tempRootFrom(undefined), 'temp');
    assert.equal(tempRootFrom(null), 'temp');
    assert.equal(tempRootFrom({}), 'temp');
  });

  it('reads from a full resolved config (project.paths.tempRoot)', () => {
    const config = { project: { paths: { tempRoot: 'tmp/work' } } };
    assert.equal(tempRootFrom(config), 'tmp/work');
  });

  it('ignores legacy agentSettings.paths shape (hard cutover)', () => {
    const config = { agentSettings: { paths: { tempRoot: 'workspace' } } };
    assert.equal(tempRootFrom(config), 'temp');
  });

  it('ignores a bare `paths` bag (hard cutover)', () => {
    const config = { paths: { tempRoot: 'workspace' } };
    assert.equal(tempRootFrom(config), 'temp');
  });

  it('falls back to "temp" when tempRoot is empty / non-string', () => {
    assert.equal(
      tempRootFrom({ project: { paths: { tempRoot: '' } } }),
      'temp',
    );
    assert.equal(
      tempRootFrom({ project: { paths: { tempRoot: null } } }),
      'temp',
    );
    assert.equal(
      tempRootFrom({ project: { paths: { tempRoot: 123 } } }),
      'temp',
    );
  });
});

describe('lib/config/temp-paths.js — Epic / Story directory helpers', () => {
  it('builds the canonical epic dir (default tempRoot)', () => {
    assert.equal(epicTempDir(1030), path.join('temp', 'epic-1030'));
  });

  it('honours a custom tempRoot via config bag', () => {
    const cfg = { project: { paths: { tempRoot: 'workspace' } } };
    assert.equal(epicTempDir(42, cfg), path.join('workspace', 'epic-42'));
  });

  it('builds the canonical story dir', () => {
    assert.equal(
      storyTempDir(1030, 1042),
      path.join('temp', 'epic-1030', 'story-1042'),
    );
  });

  it('rejects non-positive epicId / storyId', () => {
    assert.throws(() => epicTempDir(0), /positive integer/);
    assert.throws(() => epicTempDir(-1), /positive integer/);
    assert.throws(() => epicTempDir(1.5), /positive integer/);
    assert.throws(() => storyTempDir(1, 0), /positive integer/);
    assert.throws(() => storyTempDir(1, -2), /positive integer/);
  });
});

describe('lib/config/temp-paths.js — signals + canonical artifact paths', () => {
  it('signalsFile resolves to story-<sid>/signals.ndjson', () => {
    assert.equal(
      signalsFile(1030, 1042),
      path.join('temp', 'epic-1030', 'story-1042', 'signals.ndjson'),
    );
  });

  it('Epic-level canonical filenames live directly under the Epic dir', () => {
    assert.equal(epicPrdPath(1030), path.join('temp', 'epic-1030', 'prd.md'));
    assert.equal(
      epicTechSpecPath(1030),
      path.join('temp', 'epic-1030', 'techspec.md'),
    );
    assert.equal(
      epicManifestPath(1030),
      path.join('temp', 'epic-1030', 'manifest.md'),
    );
    assert.equal(
      epicRetroMirrorPath(1030),
      path.join('temp', 'epic-1030', 'retro.md'),
    );
    assert.equal(
      epicPerfReportPath(1030),
      path.join('temp', 'epic-1030', 'perf-report.md'),
    );
  });

  it('Story-level canonical filenames live under the Story dir', () => {
    assert.equal(
      storyManifestPath(1030, 1042),
      path.join('temp', 'epic-1030', 'story-1042', 'manifest.md'),
    );
    assert.equal(
      storyPerfSummaryPath(1030, 1042),
      path.join('temp', 'epic-1030', 'story-1042', 'perf-summary.md'),
    );
  });
});

describe('lib/config/temp-paths.js — artifact-name guards', () => {
  it('epicArtifactPath / storyArtifactPath accept a leaf name', () => {
    assert.equal(
      epicArtifactPath(1030, 'custom.md'),
      path.join('temp', 'epic-1030', 'custom.md'),
    );
    assert.equal(
      storyArtifactPath(1030, 1042, 'custom.txt'),
      path.join('temp', 'epic-1030', 'story-1042', 'custom.txt'),
    );
  });

  it('rejects an empty / non-string artifact name', () => {
    assert.throws(() => epicArtifactPath(1030, ''), /non-empty string/);
    assert.throws(() => storyArtifactPath(1, 2, undefined), /non-empty string/);
    assert.throws(() => epicArtifactPath(1030, 42), /non-empty string/);
  });

  it('rejects a name containing path separators (traversal guard)', () => {
    assert.throws(
      () => epicArtifactPath(1030, '../escape.md'),
      /must not contain path separators/,
    );
    assert.throws(
      () => epicArtifactPath(1030, 'sub/dir.md'),
      /must not contain path separators/,
    );
    assert.throws(
      () => storyArtifactPath(1030, 1042, 'a\\b.md'),
      /must not contain path separators/,
    );
  });
});

describe('lib/config/temp-paths.js — path.join semantics (Windows + POSIX)', () => {
  it('round-trips through path.join with no double-separators', () => {
    // path.join collapses repeated separators; round-tripping the result
    // through path.normalize should be a no-op.
    const cfg = { project: { paths: { tempRoot: 'temp' } } };
    const candidates = [
      epicTempDir(1030, cfg),
      storyTempDir(1030, 1042, cfg),
      signalsFile(1030, 1042, cfg),
      epicPrdPath(1030, cfg),
      epicTechSpecPath(1030, cfg),
      storyManifestPath(1030, 1042, cfg),
    ];
    for (const p of candidates) {
      assert.equal(
        p,
        path.normalize(p),
        `expected ${p} to be already normalized`,
      );
      assert.ok(
        !p.includes(`${SEP}${SEP}`),
        `expected no double separators in ${p}`,
      );
    }
  });

  it('handles a tempRoot with a trailing separator', () => {
    const cfg = { project: { paths: { tempRoot: `tmp${SEP}` } } };
    const dir = epicTempDir(1030, cfg);
    assert.ok(
      !dir.includes(`${SEP}${SEP}`),
      `expected trailing-slash tempRoot to collapse: ${dir}`,
    );
    assert.equal(path.normalize(dir), dir);
  });

  it('handles a nested tempRoot ("a/b/temp")', () => {
    const cfg = {
      project: { paths: { tempRoot: path.join('a', 'b', 'temp') } },
    };
    assert.equal(
      epicTempDir(1030, cfg),
      path.join('a', 'b', 'temp', 'epic-1030'),
    );
    assert.equal(
      signalsFile(1030, 1042, cfg),
      path.join('a', 'b', 'temp', 'epic-1030', 'story-1042', 'signals.ndjson'),
    );
  });

  it('honours platform-native separators', () => {
    // On Windows path.join produces backslashes; on POSIX it produces
    // forward slashes. Either way the helper must use path.join — assert
    // the exact separator that ships on the host.
    const dir = storyTempDir(1030, 1042);
    assert.ok(
      dir.includes(`epic-1030${SEP}story-1042`),
      `expected platform separator '${SEP}' in ${dir}`,
    );
  });
});
