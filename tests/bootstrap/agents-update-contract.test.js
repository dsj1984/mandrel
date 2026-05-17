/**
 * agents-update-contract — Story #2281
 *
 * The `/agents-update` workflow runs two `.agentrc.json` reconcilers back
 * to back:
 *
 *   - Helper A — `sync-agentrc` emits `[REDUNDANT]` advisories for
 *     project leaves that deep-equal the framework default.
 *   - Helper B — `quality-bootstrap`'s `ensureQualityConfigDefaults`
 *     seeds `delivery.quality.{codingGuardrails,autoRefresh}` keys.
 *
 * Before Story #2281 the two helpers contradicted each other: Helper A
 * told operators to strip default-equal keys; Helper B wrote them. The
 * original bug report from athportal traced this to two separable
 * failures — (1) Helper A's redundancy check ignored the schema's
 * `required` arrays, so following its `safe to delete` advice on
 * `project.paths.*` produced a config that failed schema validation;
 * (2) Helper B's `mergeMissingKeys` seeded keys whose intended value
 * equalled the framework default, only to have Helper A flag them as
 * redundant on the next run.
 *
 * This test exercises both helpers in sequence against a fixture
 * project and asserts the two invariants that keep them coherent:
 *
 *   1. Every `[REDUNDANT]` advisory Helper A emits would, if followed,
 *      leave the config valid against the framework schema.
 *   2. No key Helper B writes appears in Helper A's subsequent
 *      `[REDUNDANT]` advisory list.
 *
 * Together these two invariants are the load-bearing contract: when
 * either side regresses, this fixture-driven test fails fast — long
 * before a downstream consumer hits the same wall.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  applyQualityBootstrap,
  ensureQualityConfigDefaults,
} from '../../.agents/scripts/lib/bootstrap/quality-bootstrap.js';
import {
  collectRedundantAdvisories,
  syncAgentrc,
} from '../../.agents/scripts/lib/config/sync-agentrc.js';
import { getAgentrcValidator } from '../../.agents/scripts/lib/config-schema.js';

let tmpRoot;
let frameworkRoot;

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Delete a dotted path from a plain object. Used to materialise the
 * "follow Helper A's advice" hypothetical so we can re-validate.
 */
function deletePath(obj, dotted) {
  const parts = dotted.split('.');
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (cursor == null || typeof cursor !== 'object') return;
    cursor = cursor[parts[i]];
  }
  if (cursor && typeof cursor === 'object') {
    delete cursor[parts[parts.length - 1]];
  }
}

function makeFixtureProject() {
  const root = path.join(tmpRoot, 'project');
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, 'package.json'), {
    name: 'contract-fixture',
    version: '0.0.0',
    type: 'module',
    scripts: { test: 'echo ok' },
  });
  // Minimum config that validates — schema-required keys at their
  // canonical defaults, plus the identity placeholders the schema
  // requires.
  writeJson(path.join(root, '.agentrc.json'), {
    $schema: './.agents/schemas/agentrc.schema.json',
    project: {
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
    },
    github: { owner: 'acme', repo: 'demo', operatorHandle: '@octocat' },
  });
  return root;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-update-contract-'));
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

describe('agents-update contract — Helper A advisories are schema-safe', () => {
  it('following every [REDUNDANT] advisory leaves the config schema-valid', () => {
    const projectRoot = makeFixtureProject();
    const result = syncAgentrc({ projectRoot });
    assert.equal(result.status, 'noop');

    const cfg = readJson(path.join(projectRoot, '.agentrc.json'));
    for (const change of result.changes) {
      if (change.op !== 'REDUNDANT') continue;
      deletePath(cfg, change.path);
    }

    const validate = getAgentrcValidator();
    const valid = validate(cfg);
    assert.ok(
      valid,
      `following [REDUNDANT] advice produced an invalid config: ${
        validate.errors
          ?.map((e) => `${e.instancePath || '(root)'} ${e.message}`)
          .join(' | ') ?? '(no error details)'
      }`,
    );
  });

  it('never flags schema-required canonical paths as [REDUNDANT]', () => {
    // Regression guard for the original athportal report: a consumer
    // carrying the canonical `project.paths.{agentRoot,docsRoot,tempRoot}`
    // values must never see those keys in the advisory list.
    const projectRoot = makeFixtureProject();
    const result = syncAgentrc({ projectRoot });
    const flagged = result.changes
      .filter((c) => c.op === 'REDUNDANT')
      .map((c) => c.path);
    for (const required of [
      'project.paths.agentRoot',
      'project.paths.docsRoot',
      'project.paths.tempRoot',
    ]) {
      assert.ok(
        !flagged.includes(required),
        `schema-required key ${required} must never be advised for deletion`,
      );
    }
  });
});

describe('agents-update contract — Helper B does not seed Helper A redundancy', () => {
  it('no key Helper B writes appears in Helper A’s [REDUNDANT] list on next run', () => {
    const projectRoot = makeFixtureProject();

    // Run the full quality-bootstrap (Helper B). Whatever it writes is
    // the seed surface Helper A inspects on the next /agents-update.
    const bootstrap = applyQualityBootstrap({ projectRoot, frameworkRoot });
    const writtenKeys = bootstrap.config.addedKeys ?? [];

    // Now run Helper A and collect its advisories.
    const sync = syncAgentrc({ projectRoot });
    const redundantPaths = new Set(
      sync.changes.filter((c) => c.op === 'REDUNDANT').map((c) => c.path),
    );

    for (const key of writtenKeys) {
      assert.ok(
        !redundantPaths.has(key),
        `Helper B wrote ${key} but Helper A would advise deleting it — the two helpers must agree`,
      );
    }
  });

  it('ensureQualityConfigDefaults reports skipped default-equal keys instead of writing them', () => {
    const projectRoot = makeFixtureProject();
    const result = ensureQualityConfigDefaults({ projectRoot });
    assert.equal(result.action, 'no-change');
    assert.deepEqual(result.addedKeys, []);
    // Every default-mirror key is reported under skippedKeys so the
    // workflow can surface why the seed was a no-op.
    const skipped = result.skippedKeys ?? [];
    assert.ok(
      skipped.some(
        (k) => k === 'delivery.quality.codingGuardrails.cyclomaticFlag',
      ),
    );
    assert.ok(
      skipped.some((k) => k === 'delivery.quality.autoRefresh.enabled'),
    );
  });
});

describe('agents-update contract — collectRedundantAdvisories respects the schema', () => {
  it('honours a synthetic schema’s required arrays when injected', () => {
    // Synthetic schema that mirrors the project-paths constraint:
    // `required` lists the leaf at its immediate parent.
    const schema = {
      type: 'object',
      properties: {
        a: {
          type: 'object',
          required: ['locked'],
          properties: {
            locked: { type: 'string' },
            optional: { type: 'string' },
          },
        },
      },
    };
    const defaults = { a: { locked: 'x', optional: 'y' } };
    const project = { a: { locked: 'x', optional: 'y' } };
    const out = collectRedundantAdvisories(project, defaults, schema);
    const paths = out.map((c) => c.path).sort();
    // `a.locked` is schema-required → suppressed.
    // `a.optional` is removable → flagged.
    assert.deepEqual(paths, ['a.optional']);
  });
});
