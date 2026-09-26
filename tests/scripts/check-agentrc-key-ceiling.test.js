// tests/scripts/check-agentrc-key-ceiling.test.js
//
// Story #5382 — the `.agentrc` leaf-key ceiling. The counting rule is driven
// against small literal schemas; one case pins the real schema at the landed
// ceiling and one runs the real CLI against this repository.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AGENTRC_SCHEMA } from '../../.agents/scripts/lib/config-settings-schema.js';
import { checkLeafKeyCeiling } from '../../scripts/lib/agentrc-key-ceiling.js';

/** The leaf paths the ceiling counts. */
const collectLeafKeys = (schema) => checkLeafKeyCeiling(schema).leaves;

/** The landed ceiling, read back through the check's own default. */
const AGENTRC_LEAF_KEY_CEILING = checkLeafKeyCeiling({}).ceiling;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'check-agentrc-key-ceiling.js');

describe('collectLeafKeys', () => {
  it('counts scalar properties and recurses into namespaces', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: {
          type: 'object',
          properties: { c: { type: 'integer' }, d: { type: 'boolean' } },
        },
      },
    };
    assert.deepEqual(collectLeafKeys(schema), ['a', 'b.c', 'b.d']);
  });

  it('counts an open map once, however many entries it could hold', () => {
    const schema = {
      properties: {
        floors: { type: 'object', additionalProperties: { type: 'number' } },
      },
    };
    assert.deepEqual(collectLeafKeys(schema), ['floors']);
  });

  it('walks composition branches and de-duplicates their paths', () => {
    const schema = {
      properties: {
        dirs: {
          oneOf: [
            { type: 'array', items: { type: 'string' } },
            {
              type: 'object',
              properties: {
                append: { type: 'array' },
                prepend: { type: 'array' },
              },
            },
          ],
        },
      },
      allOf: [
        { properties: { dirs: { oneOf: [{ properties: { append: {} } }] } } },
      ],
    };
    assert.deepEqual(collectLeafKeys(schema), ['dirs.append', 'dirs.prepend']);
  });
});

describe('checkLeafKeyCeiling', () => {
  const schema = { properties: { a: {}, b: {}, c: {} } };

  it('passes at the ceiling', () => {
    assert.deepEqual(checkLeafKeyCeiling(schema, 3), {
      leaves: ['a', 'b', 'c'],
      count: 3,
      ceiling: 3,
      ok: true,
    });
  });

  it('fails one key above the ceiling', () => {
    assert.equal(checkLeafKeyCeiling(schema, 2).ok, false);
  });

  it('the landed ceiling is 131 (183 before Story #5382, +1 for #5459 scratch, +1 for #5472 captureScope, +1 for #5485 coverage.timeoutMs)', () => {
    assert.equal(AGENTRC_LEAF_KEY_CEILING, 131);
  });

  it('holds the real schema at the landed ceiling', () => {
    const { count, ok } = checkLeafKeyCeiling(AGENTRC_SCHEMA);
    assert.equal(ok, true);
    assert.equal(
      count,
      AGENTRC_LEAF_KEY_CEILING,
      'the ceiling tracks the landed count; lower it when a key is removed',
    );
  });

  it('the removed keys are gone from the real schema', () => {
    const leaves = new Set(collectLeafKeys(AGENTRC_SCHEMA));
    for (const removed of [
      'delivery.quality.gates.lint.enabled',
      'delivery.quality.gates.lighthouse.routes',
      'delivery.quality.gates.mutation.strykerConfigPath',
      'delivery.auditToStories.autoComment',
      'delivery.ci.watch.pollIntervalMs',
      'github.defaultTimeoutMs',
    ]) {
      assert.equal(leaves.has(removed), false, removed);
    }
    for (const kept of [
      'delivery.deliverRunner.concurrencyCap',
      'delivery.routing.roleScopedAgents',
      'delivery.routing.closeAndLand',
      'delivery.ci.autoMerge',
      'github.operatorHandle',
      'project.baseBranch',
    ]) {
      assert.equal(leaves.has(kept), true, kept);
    }
  });
});

describe('the CLI', () => {
  it('exits 0 against this repository', () => {
    const result = spawnSync(process.execPath, [CLI], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /leaf key\(s\), ceiling \d+ — ok/);
  });
});
