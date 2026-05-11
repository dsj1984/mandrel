/**
 * agents-update-migration — Story #1401 (Epic #1386)
 *
 * Drives the `/agents-update` Step 3.5 install procedure (Epic #1386
 * stabilized-quality-gates surface) against three tmp-project fixtures:
 *
 *   1. **Fresh-upgrade path.** A project that was last bootstrapped on a
 *      pre-Epic #1386 framework version. The four `applyQualityBootstrap`
 *      steps mutate; a re-run produces no-change everywhere. Idempotence is
 *      part of the workflow contract, not a coincidence.
 *
 *   2. **Custom-hook-skip path.** A project that already maintains its own
 *      `.husky/pre-commit` is left untouched and the workflow surfaces a
 *      notice with the snippet the operator must merge in by hand. Silent
 *      overwrite is the failure mode this test guards against.
 *
 *   3. **Baseline-layout migration path.** A project carrying loose
 *      per-Epic snapshots at the baselines root, the prototype
 *      `baselines/snapshots/<id>/` tree, or the committed
 *      `baselines/epic/<id>/` subdirectory layout is migrated into the
 *      `temp/epic/<id>/baselines/` namespace (Story #1467: ephemeral
 *      scratch state, no commit, reaped on /epic-deliver merge). The
 *      main-tracked baselines at the root are NOT touched — that's the
 *      contract regression guard.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { migrateBaselinesLayout } from '../../.agents/scripts/lib/bootstrap/baselines-layout-migration.js';
import {
  applyQualityBootstrap,
  PRE_COMMIT_MARKER,
  QUALITY_CONFIG_DEFAULTS,
  QUALITY_NPM_SCRIPTS,
} from '../../.agents/scripts/lib/bootstrap/quality-bootstrap.js';

let tmpRoot;
let frameworkRoot;

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-update-mig-'));
  frameworkRoot = path.join(tmpRoot, '_framework');
  const helperSrc = path.join(
    frameworkRoot,
    'workflows',
    'helpers',
    'code-quality-guardrails.md',
  );
  fs.mkdirSync(path.dirname(helperSrc), { recursive: true });
  fs.writeFileSync(helperSrc, '# Code Quality Guardrails — fixture\n');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('agents-update — fresh-upgrade path', () => {
  it('installs all four artefacts and is idempotent on re-run', () => {
    const projectRoot = path.join(tmpRoot, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    writeJson(path.join(projectRoot, 'package.json'), {
      name: 'legacy-project',
      version: '1.2.3',
      scripts: { lint: 'eslint .' },
    });
    writeJson(path.join(projectRoot, '.agentrc.json'), {
      agentSettings: { baseBranch: 'main' },
    });

    const first = applyQualityBootstrap({ projectRoot, frameworkRoot });
    assert.equal(first.helper.action, 'copied');
    assert.equal(first.hook.action, 'created');
    assert.equal(first.scripts.action, 'updated');
    assert.equal(first.config.action, 'updated');

    // Operator's existing lint script survived.
    const pkg = readJson(path.join(projectRoot, 'package.json'));
    assert.equal(pkg.scripts.lint, 'eslint .');
    assert.equal(
      pkg.scripts['quality:preview'],
      QUALITY_NPM_SCRIPTS['quality:preview'],
    );

    // Config seeded with framework defaults.
    const cfg = readJson(path.join(projectRoot, '.agentrc.json'));
    assert.deepEqual(
      cfg.agentSettings.quality.codingGuardrails,
      QUALITY_CONFIG_DEFAULTS.codingGuardrails,
    );

    // Re-run is a no-op everywhere.
    const second = applyQualityBootstrap({ projectRoot, frameworkRoot });
    assert.equal(second.helper.action, 'already-present');
    assert.equal(second.hook.action, 'already-present');
    assert.equal(second.scripts.action, 'no-change');
    assert.equal(second.config.action, 'no-change');
  });
});

describe('agents-update — custom-hook-skip path', () => {
  it('preserves a custom .husky/pre-commit and surfaces a notice', () => {
    const projectRoot = path.join(tmpRoot, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    writeJson(path.join(projectRoot, 'package.json'), {
      name: 'project-with-custom-hook',
      version: '0.0.0',
    });
    writeJson(path.join(projectRoot, '.agentrc.json'), {
      agentSettings: { baseBranch: 'main' },
    });

    const hookPath = path.join(projectRoot, '.husky', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    const customBody =
      '#!/usr/bin/env sh\n# Operator-authored: run our internal sec-scan.\nnpm run secscan\n';
    fs.writeFileSync(hookPath, customBody);

    const result = applyQualityBootstrap({ projectRoot, frameworkRoot });
    assert.equal(result.hook.action, 'custom-hook-skip');
    assert.match(result.hook.notice, /Custom \.husky\/pre-commit detected/);
    // Operator's hook body is untouched, byte-for-byte.
    assert.equal(fs.readFileSync(hookPath, 'utf8'), customBody);
    // The recommended snippet the operator must merge in is returned.
    assert.ok(result.hook.snippet.includes(PRE_COMMIT_MARKER));

    // The other three install paths still ran.
    assert.equal(result.helper.action, 'copied');
    assert.equal(result.scripts.action, 'updated');
    assert.equal(result.config.action, 'updated');

    // Re-run after the operator merges in the snippet manually
    // produces `already-present` (the marker is the detection key).
    fs.writeFileSync(hookPath, `${customBody}\n${PRE_COMMIT_MARKER}\n`);
    const second = applyQualityBootstrap({ projectRoot, frameworkRoot });
    assert.equal(second.hook.action, 'already-present');
  });
});

describe('agents-update — baselines layout migration', () => {
  // A stub spawnSync that records git invocations without mutating anything;
  // the helper's `git rm -r --quiet --ignore-unmatch` is safe to no-op in
  // tests where the fixture is not a real git repo.
  function makeGitStub() {
    const calls = [];
    const spawnSync = (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: '', stderr: '' };
    };
    return { spawnSync, calls };
  }

  // Common fixture setup: a project root with a `baselines/` dir already
  // mkdir'd. Returns the absolute paths the tests need.
  function setupBaselineFixture() {
    const projectRoot = path.join(tmpRoot, 'project');
    const baselinesDir = path.join(projectRoot, 'baselines');
    fs.mkdirSync(baselinesDir, { recursive: true });
    return { projectRoot, baselinesDir };
  }

  // Temp-namespace destination for a per-Epic baseline file.
  function tempEpicPath(projectRoot, epicId, kind) {
    return path.join(
      projectRoot,
      'temp',
      'epic',
      String(epicId),
      'baselines',
      `${kind}.json`,
    );
  }

  // Run the helper with the standard git stub + repoRoot wiring.
  function runMigrate(projectRoot, baselinesDir) {
    const git = makeGitStub();
    const result = migrateBaselinesLayout({
      baselinesDir,
      repoRoot: projectRoot,
      spawnSync: git.spawnSync,
    });
    return { git, result };
  }

  it('relocates loose epic-<id>-*.json files under temp/epic/<id>/baselines/', () => {
    const { projectRoot, baselinesDir } = setupBaselineFixture();
    // Main-tracked baselines (must NOT be moved).
    writeJson(path.join(baselinesDir, 'maintainability.json'), { main: true });
    writeJson(path.join(baselinesDir, 'crap.json'), { kernelVersion: '1.0' });
    // Legacy loose snapshots for two Epics.
    writeJson(path.join(baselinesDir, 'epic-1386-maintainability.json'), {
      epic: 1386,
    });
    writeJson(path.join(baselinesDir, 'epic-1386-crap.json'), {
      epic: 1386,
      crap: true,
    });
    writeJson(path.join(baselinesDir, 'epic-1142-maintainability.json'), {
      epic: 1142,
    });

    const { result } = runMigrate(projectRoot, baselinesDir);
    assert.equal(result.action, 'migrated');
    assert.equal(result.moves.length, 3);
    for (const move of result.moves) {
      assert.equal(move.action, 'relocated-loose');
    }

    // Per-Epic snapshots landed under the temp namespace.
    const ep1386Mi = tempEpicPath(projectRoot, 1386, 'maintainability');
    assert.ok(fs.existsSync(ep1386Mi));
    assert.equal(readJson(ep1386Mi).epic, 1386);
    assert.ok(
      fs.existsSync(tempEpicPath(projectRoot, 1142, 'maintainability')),
    );

    // Nothing landed under the committed baselines/epic/ shape.
    assert.ok(!fs.existsSync(path.join(baselinesDir, 'epic')));

    // Main-tracked baselines at the root are untouched.
    assert.ok(fs.existsSync(path.join(baselinesDir, 'maintainability.json')));
    assert.ok(fs.existsSync(path.join(baselinesDir, 'crap.json')));
    // Legacy loose files are gone.
    assert.ok(
      !fs.existsSync(path.join(baselinesDir, 'epic-1386-maintainability.json')),
    );

    // Re-run is a no-op.
    const second = runMigrate(projectRoot, baselinesDir).result;
    assert.equal(second.action, 'no-change');
  });

  it('migrates the prototype baselines/snapshots/<id>/ tree to temp/epic/<id>/baselines/', () => {
    const { projectRoot, baselinesDir } = setupBaselineFixture();
    const protoDir = path.join(baselinesDir, 'snapshots', '1386');
    fs.mkdirSync(protoDir, { recursive: true });
    writeJson(path.join(protoDir, 'maintainability.json'), { proto: true });
    writeJson(path.join(protoDir, 'crap.json'), { proto: true, crap: 1 });

    const { result } = runMigrate(projectRoot, baselinesDir);
    assert.equal(result.action, 'migrated');
    assert.equal(result.moves.length, 2);
    for (const move of result.moves) {
      assert.equal(move.action, 'relocated-prototype');
    }
    assert.ok(
      fs.existsSync(tempEpicPath(projectRoot, 1386, 'maintainability')),
    );
    // Empty prototype tree is cleaned up.
    assert.ok(!fs.existsSync(path.join(baselinesDir, 'snapshots')));
  });

  it('relocates committed baselines/epic/<id>/ to temp/epic/<id>/baselines/ and stages a git rm', () => {
    const { projectRoot, baselinesDir } = setupBaselineFixture();
    const committedDir = path.join(baselinesDir, 'epic', '1181');
    fs.mkdirSync(committedDir, { recursive: true });
    writeJson(path.join(committedDir, 'maintainability.json'), { epic: 1181 });
    writeJson(path.join(committedDir, 'crap.json'), {
      epic: 1181,
      crap: true,
    });

    const { git, result } = runMigrate(projectRoot, baselinesDir);

    assert.equal(result.action, 'migrated');
    assert.equal(result.moves.length, 2);
    for (const move of result.moves) {
      assert.equal(move.action, 'relocated-committed');
    }

    // Snapshots landed under temp/epic/<id>/baselines/ and the committed
    // tree is removed from disk.
    assert.ok(
      fs.existsSync(tempEpicPath(projectRoot, 1181, 'maintainability')),
    );
    assert.ok(!fs.existsSync(committedDir));
    assert.ok(!fs.existsSync(path.join(baselinesDir, 'epic')));

    // `git rm` was invoked for the per-Epic dir with the safe flags.
    const rmCall = git.calls.find((c) => c.cmd === 'git' && c.args[0] === 'rm');
    assert.ok(rmCall, 'expected git rm invocation');
    assert.deepEqual(rmCall.args, [
      'rm',
      '-r',
      '--quiet',
      '--ignore-unmatch',
      '--',
      'baselines/epic/1181',
    ]);
    assert.equal(result.prunedDirs.length, 1);
    assert.equal(result.prunedDirs[0].path, 'baselines/epic/1181');
  });

  it('discards a legacy loose snapshot when the temp-namespace target is already populated', () => {
    const { projectRoot, baselinesDir } = setupBaselineFixture();
    const canonicalMi = tempEpicPath(projectRoot, 1386, 'maintainability');
    // Canonical snapshot (the source of truth) is already in place.
    writeJson(canonicalMi, { canonical: true });
    // Legacy loose copy that would otherwise overwrite it.
    writeJson(path.join(baselinesDir, 'epic-1386-maintainability.json'), {
      legacy: true,
      stale: true,
    });

    const { result } = runMigrate(projectRoot, baselinesDir);
    assert.equal(result.action, 'migrated');
    assert.equal(result.moves[0].action, 'discarded-superseded');
    // Canonical snapshot is preserved; legacy loose file is gone.
    assert.equal(readJson(canonicalMi).canonical, true);
    assert.ok(
      !fs.existsSync(path.join(baselinesDir, 'epic-1386-maintainability.json')),
    );
  });

  it('reports no-baselines-dir when baselines/ is absent', () => {
    const projectRoot = path.join(tmpRoot, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    const result = migrateBaselinesLayout({
      baselinesDir: path.join(projectRoot, 'baselines'),
      repoRoot: projectRoot,
    });
    assert.equal(result.action, 'no-baselines-dir');
  });
});
