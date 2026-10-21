/**
 * mandrel-update-migration — Story #1401 (Epic #1386)
 *
 * Drives the `/mandrel-update` Step 3.5 install procedure (Epic #1386
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
 *   3. **Legacy `baselines/epic/` prune path.** Story #5007 retired the
 *      per-Epic layout migration along with the epic model that gave it a
 *      reader. Its one surviving hygiene step gets a committed pre-v2
 *      `baselines/epic/` tree out of version control. The main-tracked
 *      baselines at the root are NOT touched — that's the contract
 *      regression guard.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  applyQualityBootstrap,
  PRE_COMMIT_MARKER,
  QUALITY_NPM_SCRIPTS,
} from '../../.agents/scripts/lib/bootstrap/quality-bootstrap.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

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
  tmpRoot = makeTempDir('mandrel-update-mig-');
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

describe('mandrel-update — fresh-upgrade path', () => {
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
    // Story #2281: default-equal config seeds are skipped to avoid
    // contradicting sync-agentrc's [REDUNDANT] advisories on next run.
    assert.equal(first.config.action, 'no-change');

    // Operator's existing lint script survived.
    const pkg = readJson(path.join(projectRoot, 'package.json'));
    assert.equal(pkg.scripts.lint, 'eslint .');
    assert.equal(
      pkg.scripts['quality:preview'],
      QUALITY_NPM_SCRIPTS['quality:preview'],
    );

    // Config stays at the minimum that validates — no default-equal
    // scaffolding has been written under delivery.quality.
    const cfg = readJson(path.join(projectRoot, '.agentrc.json'));
    assert.ok(
      cfg.delivery === undefined ||
        cfg.delivery.quality === undefined ||
        Object.keys(cfg.delivery.quality).length === 0,
      'default-equal seeds must not materialise as on-disk keys',
    );

    // Re-run is a no-op everywhere.
    const second = applyQualityBootstrap({ projectRoot, frameworkRoot });
    assert.equal(second.helper.action, 'already-present');
    assert.equal(second.hook.action, 'already-present');
    assert.equal(second.scripts.action, 'no-change');
    assert.equal(second.config.action, 'no-change');
  });
});

describe('mandrel-update — custom-hook-skip path', () => {
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
    // Story #2281: default-equal config seeds are skipped.
    assert.equal(result.config.action, 'no-change');

    // Re-run after the operator merges in the snippet manually
    // produces `already-present` (the marker is the detection key).
    fs.writeFileSync(hookPath, `${customBody}\n${PRE_COMMIT_MARKER}\n`);
    const second = applyQualityBootstrap({ projectRoot, frameworkRoot });
    assert.equal(second.hook.action, 'already-present');
  });
});

describe('mandrel-update — legacy baselines/epic prune (Story #5007)', () => {
  // A stub spawnSync that records the prune's `git rm` without mutating
  // anything; every other git call (the merge-driver step) reports
  // not-a-repo, so only the prune's invocations are recorded.
  function makeGitStub() {
    const calls = [];
    const spawnImpl = (cmd, args) => {
      if (args[0] !== 'rm') return { status: 1, stdout: '', stderr: '' };
      calls.push({ cmd, args });
      return { status: 0, stdout: '', stderr: '' };
    };
    return { spawnImpl, calls };
  }

  /** The prune step's outcome, driven through the public entry point. */
  function prune(projectRoot, spawnImpl) {
    return applyQualityBootstrap({ projectRoot, frameworkRoot, spawnImpl })
      .legacyBaselines;
  }

  function setupProject() {
    const projectRoot = path.join(tmpRoot, 'project');
    fs.mkdirSync(path.join(projectRoot, 'baselines'), { recursive: true });
    return projectRoot;
  }

  it('reports absent when no committed baselines/epic tree exists', () => {
    const projectRoot = setupProject();
    const git = makeGitStub();
    const result = prune(projectRoot, git.spawnImpl);
    assert.equal(result.action, 'absent');
    assert.equal(git.calls.length, 0, 'no git spawn on the common path');
  });

  it('stages the git rm and clears the on-disk tree, then reports absent on re-run', () => {
    const projectRoot = setupProject();
    const epicDir = path.join(projectRoot, 'baselines', 'epic', '1386');
    fs.mkdirSync(epicDir, { recursive: true });
    writeJson(path.join(epicDir, 'maintainability.json'), { legacy: true });

    const git = makeGitStub();
    const result = prune(projectRoot, git.spawnImpl);

    assert.equal(result.action, 'pruned');
    assert.equal(result.gitStatus, 0);
    assert.deepEqual(git.calls, [
      {
        cmd: 'git',
        args: [
          'rm',
          '-r',
          '--quiet',
          '--ignore-unmatch',
          '--',
          'baselines/epic',
        ],
      },
    ]);
    assert.ok(!fs.existsSync(path.join(projectRoot, 'baselines', 'epic')));

    // Idempotent: the second pass finds nothing and spawns no git.
    const second = makeGitStub();
    assert.equal(prune(projectRoot, second.spawnImpl).action, 'absent');
    assert.equal(second.calls.length, 0);
  });

  it('never touches the main-tracked root baselines', () => {
    const projectRoot = setupProject();
    const canonical = path.join(
      projectRoot,
      'baselines',
      'maintainability.json',
    );
    writeJson(canonical, { canonical: true });
    fs.mkdirSync(path.join(projectRoot, 'baselines', 'epic', '42'), {
      recursive: true,
    });

    prune(projectRoot, makeGitStub().spawnImpl);

    assert.equal(readJson(canonical).canonical, true);
  });
});
