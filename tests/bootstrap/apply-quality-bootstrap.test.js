/**
 * apply-quality-bootstrap — Story #4171
 * (refactor(agents-update): extract the quality-bootstrap heredoc into a
 * tested script)
 *
 * Exercises the script that replaced Step 3.5's inline `node -e` heredoc. The
 * Story's acceptance criteria are:
 *
 *   1. The script calls the same `applyQualityBootstrap` +
 *      `migrateBaselinesLayout` helpers and prints the same `{ quality,
 *      baselines }` JSON shape.
 *   2. It is idempotent — a second run is a no-op beyond reporting.
 *   3. A unit test exercises the script against both helpers, covering the
 *      success path and an idempotent re-run.
 *
 * The composition is tested two ways: against the *real* helpers in a tmp
 * project tree (success path + idempotent re-run, asserting on-disk effects),
 * and against injected stubs (asserting the wiring — that both helpers are
 * invoked with the project-root-derived arguments and that the envelope keys
 * preserve the heredoc shape).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { applyBootstrapAndMigration } from '../../.agents/scripts/apply-quality-bootstrap.js';

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('applyBootstrapAndMigration — wiring (stubbed helpers)', () => {
  it('invokes both helpers with project-root-derived args and preserves the heredoc envelope shape', () => {
    const calls = { quality: [], baselines: [] };
    const projectRoot = '/tmp/some-consumer';

    const result = applyBootstrapAndMigration({
      projectRoot,
      applyQualityBootstrap: (ctx) => {
        calls.quality.push(ctx);
        return { helper: { action: 'already-present' } };
      },
      migrateBaselinesLayout: (args) => {
        calls.baselines.push(args);
        return { action: 'no-baselines-dir', moves: [], prunedDirs: [] };
      },
    });

    // applyQualityBootstrap receives { projectRoot }.
    assert.equal(calls.quality.length, 1);
    assert.deepEqual(calls.quality[0], { projectRoot });

    // migrateBaselinesLayout receives baselinesDir = <root>/baselines and
    // repoRoot = <root>.
    assert.equal(calls.baselines.length, 1);
    assert.equal(
      calls.baselines[0].baselinesDir,
      path.join(projectRoot, 'baselines'),
    );
    assert.equal(calls.baselines[0].repoRoot, projectRoot);

    // The envelope keeps the heredoc's two-key shape.
    assert.deepEqual(Object.keys(result), ['quality', 'baselines']);
    assert.deepEqual(result.quality, { helper: { action: 'already-present' } });
    assert.deepEqual(result.baselines, {
      action: 'no-baselines-dir',
      moves: [],
      prunedDirs: [],
    });
  });
});

describe('applyBootstrapAndMigration — real helpers against a tmp project', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'apply-quality-bootstrap-'),
    );
    // The guardrails helper is materialized under the project's own
    // `.agents/` tree (the npm-distribution shape: `mandrel update`'s sync
    // step already places it there, so the bootstrap reports the helper as
    // already-present). The default `frameworkRoot` the helper falls back to
    // is `<projectRoot>/.agents`, so this is also the copy source.
    const helperSource = path.join(
      tmpRoot,
      '.agents',
      'workflows',
      'helpers',
      'code-quality-guardrails.md',
    );
    fs.mkdirSync(path.dirname(helperSource), { recursive: true });
    fs.writeFileSync(helperSource, '# code-quality-guardrails\n', 'utf8');

    // A minimal consumer package.json + .agentrc.json so the npm-script and
    // config seeds have somewhere to land.
    writeJson(path.join(tmpRoot, 'package.json'), {
      name: 'consumer',
      scripts: {},
    });
    writeJson(path.join(tmpRoot, '.agentrc.json'), {});
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('runs both helpers, returns the { quality, baselines } envelope, and applies the on-disk effects', () => {
    const result = applyBootstrapAndMigration({ projectRoot: tmpRoot });

    // Envelope shape matches the retired heredoc.
    assert.deepEqual(Object.keys(result), ['quality', 'baselines']);
    assert.ok(result.quality.helper);
    assert.ok(result.quality.hook);
    assert.ok(result.quality.scripts);
    assert.ok(result.quality.config);

    // Quality bootstrap applied its on-disk effects: the guardrails helper
    // is present, the pre-commit hook was created, and the npm scripts were
    // backfilled. (The helper reports `already-present` because the npm
    // distribution materializes it under `.agents/` ahead of the bootstrap.)
    assert.equal(result.quality.helper.action, 'already-present');
    assert.equal(result.quality.hook.action, 'created');
    assert.equal(result.quality.scripts.action, 'updated');

    assert.ok(
      fs.existsSync(
        path.join(
          tmpRoot,
          '.agents',
          'workflows',
          'helpers',
          'code-quality-guardrails.md',
        ),
      ),
    );
    assert.ok(fs.existsSync(path.join(tmpRoot, '.husky', 'pre-commit')));
    const pkg = readJson(path.join(tmpRoot, 'package.json'));
    assert.equal(typeof pkg.scripts['quality:preview'], 'string');
    assert.equal(typeof pkg.scripts['quality:watch'], 'string');

    // No baselines dir in this fixture → migration reports the no-op shape.
    assert.equal(result.baselines.action, 'no-baselines-dir');
  });

  it('is idempotent — a second run is a no-op beyond reporting and leaves identical on-disk state', () => {
    // First run lands all effects.
    applyBootstrapAndMigration({ projectRoot: tmpRoot });

    // Snapshot the files the bootstrap writes after the first run.
    const snapshot = () => ({
      hook: fs.readFileSync(path.join(tmpRoot, '.husky', 'pre-commit'), 'utf8'),
      pkg: fs.readFileSync(path.join(tmpRoot, 'package.json'), 'utf8'),
      agentrc: fs.readFileSync(path.join(tmpRoot, '.agentrc.json'), 'utf8'),
    });
    const before = snapshot();

    const second = applyBootstrapAndMigration({ projectRoot: tmpRoot });

    // Every install path reports the idempotent no-op outcome on re-run.
    assert.equal(second.quality.helper.action, 'already-present');
    assert.equal(second.quality.hook.action, 'already-present');
    assert.equal(second.quality.scripts.action, 'no-change');
    assert.equal(second.quality.config.action, 'no-change');
    assert.equal(second.baselines.action, 'no-baselines-dir');

    // The files are byte-for-byte identical after the second run — the
    // re-run mutates nothing on disk.
    assert.deepEqual(snapshot(), before);
  });
});
