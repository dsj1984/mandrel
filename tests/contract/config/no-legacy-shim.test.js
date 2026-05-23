// tests/contract/config/no-legacy-shim.test.js
/**
 * Contract test — Story #2947 Task #2954 (Epic #2880, F14B finalization).
 *
 * Asserts the post-cutover config contract:
 *
 *   1. `resolveConfig()` returns a wrapper that carries **no** legacy
 *      `agentSettings` / `orchestration` keys at any depth — neither on the
 *      `.agentrc.json`-backed path nor on the zero-config defaults path.
 *      The previously synthesized output-side shim has been deleted; every
 *      consumer reads the canonical `project` / `github` / `planning` /
 *      `delivery` blocks directly.
 *
 *   2. The AJV `.agentrc.json` schema **rejects** input documents that
 *      declare a top-level `agentSettings` or `orchestration` block
 *      (rejected via `additionalProperties: false` at the document root).
 *
 * Hard cutover precedent lives in
 * `.agents/rules/git-conventions.md#contract-cutovers-—-no-shim-layer`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { resolveConfig } from '../../../.agents/scripts/lib/config-resolver.js';
import { getAgentrcValidator } from '../../../.agents/scripts/lib/config-schema.js';

const LEGACY_KEYS = ['agentSettings', 'orchestration'];

describe('contract/config/no-legacy-shim', () => {
  describe('resolveConfig() output shape', () => {
    let tmpRoot;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mandrel-no-shim-'));
    });

    afterEach(() => {
      if (tmpRoot) {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('omits agentSettings and orchestration keys for a canonical .agentrc.json', () => {
      // Arrange: write a minimal canonical .agentrc.json.
      const doc = {
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        github: {
          owner: 'dsj1984',
          repo: 'mandrel',
          operatorHandle: '@dsj1984',
        },
      };
      fs.writeFileSync(
        path.join(tmpRoot, '.agentrc.json'),
        JSON.stringify(doc),
        'utf8',
      );

      // Act
      const resolved = resolveConfig({ cwd: tmpRoot, bustCache: true });

      // Assert: canonical blocks present.
      assert.ok(resolved.project, 'project block present');
      assert.ok(resolved.github, 'github block present');
      assert.ok(resolved.delivery, 'delivery block present');

      // Assert: legacy output pointers absent.
      for (const key of LEGACY_KEYS) {
        assert.equal(
          Object.hasOwn(resolved, key),
          false,
          `resolved wrapper must NOT carry top-level "${key}" pointer`,
        );
      }
    });

    it('omits agentSettings and orchestration keys on the zero-config defaults path', () => {
      // Arrange: empty directory — no .agentrc.json, no AP_AGENTRC_CWD.
      // Act
      const resolved = resolveConfig({ cwd: tmpRoot, bustCache: true });

      // Assert
      assert.equal(resolved.source, 'built-in defaults');
      for (const key of LEGACY_KEYS) {
        assert.equal(
          Object.hasOwn(resolved, key),
          false,
          `zero-config wrapper must NOT carry top-level "${key}" pointer`,
        );
      }
    });
  });

  describe('AJV schema rejection of legacy input shapes', () => {
    it('rejects a document declaring top-level agentSettings', () => {
      const validate = getAgentrcValidator();
      const doc = {
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        agentSettings: {
          baseBranch: 'main',
        },
      };

      const ok = validate(doc);

      assert.equal(
        ok,
        false,
        'AJV must reject documents carrying top-level agentSettings',
      );
      const messages = (validate.errors ?? [])
        .map((e) => `${e.instancePath} ${e.message}`)
        .join(' | ');
      assert.match(
        messages,
        /additional properties|must NOT have additional properties/i,
        `expected additionalProperties violation, got: ${messages}`,
      );
    });

    it('rejects a document declaring top-level orchestration', () => {
      const validate = getAgentrcValidator();
      const doc = {
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        orchestration: {
          provider: 'github',
          github: { owner: 'dsj1984', repo: 'mandrel' },
        },
      };

      const ok = validate(doc);

      assert.equal(
        ok,
        false,
        'AJV must reject documents carrying top-level orchestration',
      );
      const messages = (validate.errors ?? [])
        .map((e) => `${e.instancePath} ${e.message}`)
        .join(' | ');
      assert.match(
        messages,
        /additional properties|must NOT have additional properties/i,
        `expected additionalProperties violation, got: ${messages}`,
      );
    });
  });
});
