/**
 * tests/sentinel/ajv-presence.test.js
 *
 * Fail-loud watchdog for the recurring `node_modules/ajv` prune regression
 * surfaced during Epic #2453 and remediated by Epic #2501 / Story #2505.
 *
 * Background:
 *   The dispatcher hard-depends on `ajv` (used by the JSON-Schema
 *   validators, the bootstrap sentinel check, and several lint rules). On
 *   three separate occasions during Epic #2453, `node_modules/ajv`
 *   disappeared between dispatcher runs and bricked every
 *   `.agents/scripts/*.js` CLI with `ERR_MODULE_NOT_FOUND: ajv`. The
 *   upstream cause was the `nodeModulesStrategy: symlink` worktree mode,
 *   which lets a per-worktree install prune optional peer deps from the
 *   shared donor `node_modules/` tree.
 *
 *   Story #2505 (Epic #2501) flips the strategy to `pnpm-store` so the
 *   host tree stops being a shared mutation target, and this sentinel
 *   test asserts the invariant from the test side: after `npm test`, the
 *   `ajv` package MUST be resolvable both as a filesystem artefact and as
 *   an ESM import. If either check fails, the dispatcher is one step away
 *   from the failure mode that Epic #2453 hit three times, and the
 *   operator needs to know *before* the next CLI invocation breaks.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const FAILURE_HINT =
  'If this test fails, `node_modules/ajv` was pruned between dispatcher ' +
  'runs — the exact regression Epic #2501 (Story #2505) was opened to ' +
  'eliminate. Verify `delivery.worktreeIsolation.nodeModulesStrategy` in ' +
  '`.agentrc.json` is set to `pnpm-store` (not `symlink`) and re-run the ' +
  "host's package-manager install before reporting.";

describe('sentinel: ajv presence (Epic #2501, Story #2505)', () => {
  it('node_modules/ajv/package.json exists on disk', () => {
    const pkgJson = path.join(REPO_ROOT, 'node_modules', 'ajv', 'package.json');
    assert.ok(
      existsSync(pkgJson),
      `Expected ${pkgJson} to exist. ${FAILURE_HINT}`,
    );
  });

  it("import('ajv') resolves without ERR_MODULE_NOT_FOUND", async () => {
    try {
      const mod = await import('ajv');
      // `ajv` ships a default export (the Ajv constructor). The exact
      // shape varies across major versions; assert only that *something*
      // came back so we do not couple the sentinel to ajv's API.
      assert.ok(
        mod && (mod.default || mod.Ajv || typeof mod === 'object'),
        `Expected 'ajv' module to expose an object. ${FAILURE_HINT}`,
      );
    } catch (err) {
      assert.fail(
        `import('ajv') threw ${err?.code ?? 'unknown'}: ${err?.message}. ${FAILURE_HINT}`,
      );
    }
  });

  it("require.resolve('ajv') succeeds from the repo root", () => {
    const require_ = createRequire(path.join(REPO_ROOT, 'package.json'));
    try {
      const resolved = require_.resolve('ajv');
      assert.ok(
        resolved.includes(`${path.sep}ajv${path.sep}`),
        `Expected resolved path to live under node_modules/ajv; got ${resolved}. ${FAILURE_HINT}`,
      );
    } catch (err) {
      assert.fail(
        `require.resolve('ajv') threw ${err?.code ?? 'unknown'}: ${err?.message}. ${FAILURE_HINT}`,
      );
    }
  });
});
