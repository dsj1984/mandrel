/**
 * quality-bootstrap — Story #1401 (Epic #1386)
 *
 * Drives `applyQualityBootstrap` against a tmp project tree to assert the
 * four artefacts the stabilized-gates Epic ships:
 *
 *   1. The `code-quality-guardrails.md` helper lands under
 *      `.agents/workflows/helpers/`.
 *   2. `.husky/pre-commit` carries the `quality:preview` invocation, and a
 *      pre-existing custom hook is preserved with a `custom-hook-skip`
 *      outcome.
 *   3. `quality:preview` and `quality:watch` npm scripts are registered
 *      idempotently in `package.json`.
 *   4. `agentSettings.quality.codingGuardrails` and `autoRefresh` defaults
 *      are seeded into `.agentrc.json` without clobbering existing values.
 *
 * Each scenario exercises the re-run path so the workflow's idempotence
 * guarantee is enforced by the test suite, not just prose.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  applyQualityBootstrap,
  DOWNSTREAM_PRE_COMMIT,
  ensureGuardrailsHelper,
  ensurePreCommitHook,
  ensureQualityConfigDefaults,
  ensureQualityNpmScripts,
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-bootstrap-'));
  // Stand up a minimal "framework" tree so the helper has a copy source.
  // Real-world callers pass the path to their .agents submodule checkout.
  frameworkRoot = path.join(tmpRoot, '_framework');
  const helperSource = path.join(
    frameworkRoot,
    'workflows',
    'helpers',
    'code-quality-guardrails.md',
  );
  fs.mkdirSync(path.dirname(helperSource), { recursive: true });
  fs.writeFileSync(helperSource, '# Code Quality Guardrails — fixture\n');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeProject(overrides = {}) {
  const root = path.join(tmpRoot, 'project');
  fs.mkdirSync(root, { recursive: true });
  if (overrides.packageJson !== false) {
    writeJson(
      path.join(root, 'package.json'),
      overrides.packageJson ?? {
        name: 'tmp-project',
        version: '0.0.0',
        type: 'module',
        scripts: { test: 'echo ok' },
      },
    );
  }
  if (overrides.agentrc !== false) {
    writeJson(
      path.join(root, '.agentrc.json'),
      overrides.agentrc ?? {
        agentSettings: { baseBranch: 'main' },
      },
    );
  }
  return root;
}

describe('quality-bootstrap — fresh tmp project', () => {
  it('installs all four artefacts and is idempotent on re-run', () => {
    const projectRoot = makeProject();

    // First run: every step mutates.
    const first = applyQualityBootstrap({ projectRoot, frameworkRoot });
    assert.equal(first.helper.action, 'copied');
    assert.equal(first.hook.action, 'created');
    assert.equal(first.scripts.action, 'updated');
    assert.equal(first.config.action, 'updated');

    // Helper landed where the bootstrap step says it should.
    assert.ok(
      fs.existsSync(
        path.join(
          projectRoot,
          '.agents',
          'workflows',
          'helpers',
          'code-quality-guardrails.md',
        ),
      ),
    );

    // Hook carries the quality-preview invocation verbatim.
    const hookBody = fs.readFileSync(
      path.join(projectRoot, '.husky', 'pre-commit'),
      'utf8',
    );
    assert.ok(hookBody.includes(PRE_COMMIT_MARKER));
    assert.equal(hookBody, DOWNSTREAM_PRE_COMMIT);

    // Both npm scripts present with their framework-default values.
    const pkg = readJson(path.join(projectRoot, 'package.json'));
    for (const [name, cmd] of Object.entries(QUALITY_NPM_SCRIPTS)) {
      assert.equal(pkg.scripts[name], cmd);
    }
    // Pre-existing scripts preserved.
    assert.equal(pkg.scripts.test, 'echo ok');

    // Config has both keysets seeded with framework defaults under
    // delivery.quality (post-reshape).
    const cfg = readJson(path.join(projectRoot, '.agentrc.json'));
    assert.deepEqual(
      cfg.delivery.quality.codingGuardrails,
      QUALITY_CONFIG_DEFAULTS.codingGuardrails,
    );
    assert.deepEqual(
      cfg.delivery.quality.autoRefresh,
      QUALITY_CONFIG_DEFAULTS.autoRefresh,
    );

    // Second run: every step short-circuits.
    const second = applyQualityBootstrap({ projectRoot, frameworkRoot });
    assert.equal(second.helper.action, 'already-present');
    assert.equal(second.hook.action, 'already-present');
    assert.equal(second.scripts.action, 'no-change');
    assert.equal(second.config.action, 'no-change');
  });
});

describe('quality-bootstrap — preserves operator overrides', () => {
  it('does not clobber a custom .husky/pre-commit hook', () => {
    const projectRoot = makeProject();
    const hookPath = path.join(projectRoot, '.husky', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    const customBody = '#!/usr/bin/env sh\nnpm run my-custom-check\n';
    fs.writeFileSync(hookPath, customBody);

    const result = ensurePreCommitHook({ projectRoot });
    assert.equal(result.action, 'custom-hook-skip');
    assert.match(result.notice, /Custom \.husky\/pre-commit detected/);
    // The custom hook is left exactly as the operator wrote it.
    assert.equal(fs.readFileSync(hookPath, 'utf8'), customBody);
    // The notice carries the snippet the operator should merge in by hand.
    assert.ok(result.snippet.includes(PRE_COMMIT_MARKER));
  });

  it('preserves existing npm script values and only fills missing keys', () => {
    const projectRoot = makeProject({
      packageJson: {
        name: 'tmp-project',
        version: '0.0.0',
        type: 'module',
        scripts: {
          'quality:preview': 'node my-custom-preview.js',
          test: 'echo ok',
        },
      },
    });

    const result = ensureQualityNpmScripts({ projectRoot });
    assert.equal(result.action, 'updated');
    assert.equal(result.scripts['quality:preview'], 'already-present');
    assert.equal(result.scripts['quality:watch'], 'added');

    const pkg = readJson(path.join(projectRoot, 'package.json'));
    assert.equal(pkg.scripts['quality:preview'], 'node my-custom-preview.js');
    assert.equal(
      pkg.scripts['quality:watch'],
      QUALITY_NPM_SCRIPTS['quality:watch'],
    );
  });

  it('preserves existing config values when seeding defaults', () => {
    const projectRoot = makeProject({
      agentrc: {
        // Post-reshape: quality lives under `delivery.quality.*`.
        project: { baseBranch: 'main' },
        delivery: {
          quality: {
            codingGuardrails: { cyclomaticFlag: 6 },
            // autoRefresh entirely absent → seeded from defaults.
          },
        },
      },
    });

    const result = ensureQualityConfigDefaults({ projectRoot });
    assert.equal(result.action, 'updated');
    // Custom override survives.
    const cfg = readJson(path.join(projectRoot, '.agentrc.json'));
    assert.equal(cfg.delivery.quality.codingGuardrails.cyclomaticFlag, 6);
    // Sibling defaults filled in.
    assert.equal(
      cfg.delivery.quality.codingGuardrails.cyclomaticMustFix,
      QUALITY_CONFIG_DEFAULTS.codingGuardrails.cyclomaticMustFix,
    );
    // autoRefresh seeded entirely.
    assert.deepEqual(
      cfg.delivery.quality.autoRefresh,
      QUALITY_CONFIG_DEFAULTS.autoRefresh,
    );
    // The added-keys list reflects only the seeded keys, not the preserved one.
    assert.ok(
      result.addedKeys.some((k) => k.endsWith('cyclomaticMustFix')),
      'cyclomaticMustFix should be reported as added',
    );
    assert.ok(
      !result.addedKeys.some((k) => k.endsWith('cyclomaticFlag')),
      'cyclomaticFlag should NOT be reported as added (operator override)',
    );
  });
});

describe('quality-bootstrap — degraded environments', () => {
  it('reports missing-source when the helper file is absent', () => {
    const projectRoot = makeProject();
    const emptyFramework = path.join(tmpRoot, '_empty-framework');
    fs.mkdirSync(emptyFramework, { recursive: true });
    const result = ensureGuardrailsHelper({
      projectRoot,
      frameworkRoot: emptyFramework,
    });
    assert.equal(result.action, 'missing-source');
  });

  it('reports missing-package-json when package.json is absent', () => {
    const projectRoot = makeProject({ packageJson: false });
    const result = ensureQualityNpmScripts({ projectRoot });
    assert.equal(result.action, 'missing-package-json');
  });

  it('reports missing-config when .agentrc.json is absent', () => {
    const projectRoot = makeProject({ agentrc: false });
    const result = ensureQualityConfigDefaults({ projectRoot });
    assert.equal(result.action, 'missing-config');
    assert.deepEqual(result.addedKeys, []);
  });
});
