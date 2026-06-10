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
  _clearMainCheckoutRootCache,
  epicArtifactPath,
  epicManifestPath,
  epicPerfReportPath,
  epicPrdPath,
  epicRetroMirrorPath,
  epicTechSpecPath,
  epicTempDir,
  mainCheckoutRoot,
  signalsFile,
  storyArtifactPath,
  storyManifestPath,
  storyPerfSummaryPath,
  storyTempDir,
  tempRootFrom,
} from '../../../.agents/scripts/lib/config/temp-paths.js';

const SEP = path.sep;

/**
 * The directory helpers anchor a *relative* tempRoot to the main checkout
 * root (Story #3900). In the test process — which runs inside the repo
 * working tree — `mainCheckoutRoot()` resolves to a real path, so the
 * expected directory is `<root>/<relative-suffix>`. Helper to build the
 * expected anchored path for a relative-tempRoot suffix.
 */
function anchored(...segments) {
  const root = mainCheckoutRoot();
  const suffix = path.join(...segments);
  return root ? path.join(root, suffix) : suffix;
}

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
    assert.equal(epicTempDir(1030), anchored('temp', 'epic-1030'));
  });

  it('honours a custom tempRoot via config bag', () => {
    const cfg = { project: { paths: { tempRoot: 'workspace' } } };
    assert.equal(epicTempDir(42, cfg), anchored('workspace', 'epic-42'));
  });

  it('builds the canonical story dir', () => {
    assert.equal(
      storyTempDir(1030, 1042),
      anchored('temp', 'epic-1030', 'stories', 'story-1042'),
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
  it('signalsFile resolves to stories/story-<sid>/signals.ndjson', () => {
    assert.equal(
      signalsFile(1030, 1042),
      anchored('temp', 'epic-1030', 'stories', 'story-1042', 'signals.ndjson'),
    );
  });

  it('Epic-level canonical filenames live directly under the Epic dir', () => {
    assert.equal(epicPrdPath(1030), anchored('temp', 'epic-1030', 'prd.md'));
    assert.equal(
      epicTechSpecPath(1030),
      anchored('temp', 'epic-1030', 'techspec.md'),
    );
    assert.equal(
      epicManifestPath(1030),
      anchored('temp', 'epic-1030', 'manifest.md'),
    );
    assert.equal(
      epicRetroMirrorPath(1030),
      anchored('temp', 'epic-1030', 'retro.md'),
    );
    assert.equal(
      epicPerfReportPath(1030),
      anchored('temp', 'epic-1030', 'perf-report.md'),
    );
  });

  it('Story-level canonical filenames live under the Story dir', () => {
    assert.equal(
      storyManifestPath(1030, 1042),
      anchored('temp', 'epic-1030', 'stories', 'story-1042', 'manifest.md'),
    );
    assert.equal(
      storyPerfSummaryPath(1030, 1042),
      anchored('temp', 'epic-1030', 'stories', 'story-1042', 'perf-summary.md'),
    );
  });
});

describe('lib/config/temp-paths.js — artifact-name guards', () => {
  it('epicArtifactPath / storyArtifactPath accept a leaf name', () => {
    assert.equal(
      epicArtifactPath(1030, 'custom.md'),
      anchored('temp', 'epic-1030', 'custom.md'),
    );
    assert.equal(
      storyArtifactPath(1030, 1042, 'custom.txt'),
      anchored('temp', 'epic-1030', 'stories', 'story-1042', 'custom.txt'),
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
      anchored('a', 'b', 'temp', 'epic-1030'),
    );
    assert.equal(
      signalsFile(1030, 1042, cfg),
      anchored(
        'a',
        'b',
        'temp',
        'epic-1030',
        'stories',
        'story-1042',
        'signals.ndjson',
      ),
    );
  });

  it('honours an absolute tempRoot verbatim (no main-checkout anchoring)', () => {
    const absRoot = path.resolve(SEP, 'var', 'mandrel-temp');
    const cfg = { project: { paths: { tempRoot: absRoot } } };
    assert.equal(epicTempDir(1030, cfg), path.join(absRoot, 'epic-1030'));
  });

  it('honours platform-native separators', () => {
    // On Windows path.join produces backslashes; on POSIX it produces
    // forward slashes. Either way the helper must use path.join — assert
    // the exact separator that ships on the host.
    const dir = storyTempDir(1030, 1042);
    assert.ok(
      dir.includes(`epic-1030${SEP}stories${SEP}story-1042`),
      `expected platform separator '${SEP}' in ${dir}`,
    );
  });
});

describe('lib/config/temp-paths.js — standalone Story routing (Story #2874)', () => {
  it('storyTempDir(null, sid) routes to <tempRoot>/standalone/stories/story-<sid>', () => {
    const dir = storyTempDir(null, 1042);
    assert.equal(dir, anchored('temp', 'standalone', 'stories', 'story-1042'));
  });

  it('signalsFile(null, sid) routes through the standalone parent', () => {
    const file = signalsFile(null, 1042);
    assert.equal(
      file,
      anchored('temp', 'standalone', 'stories', 'story-1042', 'signals.ndjson'),
    );
  });

  it('storyArtifactPath(null, sid, name) routes through the standalone parent', () => {
    const file = storyArtifactPath(null, 7, 'manifest.md');
    assert.equal(
      file,
      anchored('temp', 'standalone', 'stories', 'story-7', 'manifest.md'),
    );
  });

  it('honours a custom tempRoot under standalone', () => {
    const cfg = { project: { paths: { tempRoot: path.join('a', 'b') } } };
    assert.equal(
      storyTempDir(null, 7, cfg),
      anchored('a', 'b', 'standalone', 'stories', 'story-7'),
    );
  });

  it('still rejects 0 / negative epicId (null is the only standalone signal)', () => {
    assert.throws(
      () => storyTempDir(0, 7),
      /epicId must be a positive integer or null/,
    );
    assert.throws(
      () => storyTempDir(-1, 7),
      /epicId must be a positive integer or null/,
    );
  });
});

describe('lib/config/temp-paths.js — main-checkout anchoring (Story #3900)', () => {
  // Build an ABSOLUTE fake git-common-dir via path.resolve so it carries a
  // drive letter on Windows. The implementation keeps an absolute
  // `--git-common-dir` verbatim, so the expected root is exactly its
  // path.dirname — computed the same way to avoid drive-letter divergence
  // between path.resolve(SEP, ...) (gets the cwd drive) and the bare `\repo`
  // path.join produces on Windows (no drive).
  const REPO_ROOT_ABS = path.resolve(SEP, 'repo');
  const COMMON_GIT_ABS = path.join(REPO_ROOT_ABS, '.git');
  const EXPECTED_ROOT = path.dirname(COMMON_GIT_ABS);

  it('mainCheckoutRoot returns the parent of `--git-common-dir`', () => {
    _clearMainCheckoutRootCache();
    const fakeExec = () => `${COMMON_GIT_ABS}\n`;
    const root = mainCheckoutRoot('/anywhere', { exec: fakeExec });
    assert.equal(root, EXPECTED_ROOT);
  });

  it('mainCheckoutRoot resolves a relative `--git-common-dir` against cwd', () => {
    const cwd = path.join(REPO_ROOT_ABS, 'checkout');
    // A relative `--git-common-dir` output (e.g. `.git`) is resolved against
    // the cwd, then its parent is taken. Compute the expectation the same way
    // the implementation does so the drive letter matches on Windows.
    const relOut = '.git';
    const fakeExec = () => `${relOut}\n`;
    const root = mainCheckoutRoot(cwd, { exec: fakeExec });
    assert.equal(root, path.dirname(path.resolve(cwd, relOut)));
  });

  it('a worktree cwd and the main-checkout cwd converge on the same ledger root', () => {
    // The bug: heartbeats written from a worktree cwd and reads from the
    // main checkout cwd must target the same `temp/epic-N/lifecycle.ndjson`.
    const fakeExec = () => `${COMMON_GIT_ABS}\n`;
    const fromWorktree = mainCheckoutRoot(
      path.join(REPO_ROOT_ABS, '.worktrees', 'story-7'),
      { exec: fakeExec },
    );
    const fromMain = mainCheckoutRoot(REPO_ROOT_ABS, { exec: fakeExec });
    assert.equal(fromWorktree, fromMain);
  });

  it('mainCheckoutRoot returns null when git is unavailable / non-repo', () => {
    const throwingExec = () => {
      throw new Error('not a git repository');
    };
    const root = mainCheckoutRoot('/tmp/not-a-repo', { exec: throwingExec });
    assert.equal(root, null);
  });
});
