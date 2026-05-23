import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  BDD_RUNNER_TAG_TABLE,
  PENDING_TAGS,
  verifyBddRunnerPendingTag,
} from '../.agents/scripts/lib/bdd-runner-detect.js';

/**
 * Unit tests for `verifyBddRunnerPendingTag` — the package.json scan that
 * decides whether the acceptance-spec records a verified pending tag
 * (features-first ordering) or falls back to dependencies-first.
 *
 * The function is pure: it only reads `package.json`. Tests stub the file
 * read via the `readPkg` injection so they exercise every branch without
 * touching disk.
 */
describe('bdd-runner-detect:verifyBddRunnerPendingTag', () => {
  it('records the verified tag when a known runner is in dependencies', async () => {
    const result = await verifyBddRunnerPendingTag({
      cwd: '/repo',
      readPkg: async () =>
        JSON.stringify({
          name: 'sample',
          dependencies: { 'playwright-bdd': '^1.0.0' },
        }),
    });
    assert.equal(result.runner, 'playwright-bdd');
    assert.equal(result.pendingTag, '@skip');
    assert.equal(result.supported, true);
    assert.equal(result.fallback, false);
  });

  it('records the verified tag when a known runner is in devDependencies', async () => {
    const result = await verifyBddRunnerPendingTag({
      cwd: '/repo',
      readPkg: async () =>
        JSON.stringify({
          devDependencies: { '@cucumber/cucumber': '^11.0.0' },
        }),
    });
    assert.equal(result.runner, '@cucumber/cucumber');
    assert.equal(result.pendingTag, '@skip');
    assert.equal(result.supported, true);
    assert.equal(result.fallback, false);
  });

  it('falls back to dependencies-first when no BDD runner is detected', async () => {
    const result = await verifyBddRunnerPendingTag({
      cwd: '/repo',
      readPkg: async () => JSON.stringify({ dependencies: { lodash: '*' } }),
    });
    assert.equal(result.runner, null);
    assert.equal(result.pendingTag, null);
    assert.equal(result.supported, false);
    assert.equal(result.fallback, true);
    assert.equal(result.reason, 'no-bdd-runner-detected');
  });

  it('falls back when package.json is missing (ENOENT)', async () => {
    const result = await verifyBddRunnerPendingTag({
      cwd: '/repo',
      readPkg: async () => {
        const err = new Error('not found');
        err.code = 'ENOENT';
        throw err;
      },
    });
    assert.equal(result.fallback, true);
    assert.equal(result.reason, 'package-json-missing');
  });

  it('falls back when package.json is unparseable', async () => {
    const result = await verifyBddRunnerPendingTag({
      cwd: '/repo',
      readPkg: async () => '{ not valid json',
    });
    assert.equal(result.fallback, true);
    assert.match(result.reason, /^package-json-parse-error:/);
  });

  it('PENDING_TAGS covers every pendingTag in BDD_RUNNER_TAG_TABLE (drift guard)', () => {
    // Contract: adding a new runner to BDD_RUNNER_TAG_TABLE without
    // registering its pendingTag in PENDING_TAGS would silently regress
    // `acceptance-spec-reconciler.classifyCoverage`, which membership-
    // tests scenario tag sets against PENDING_TAGS. This walk fails the
    // build instead of letting the gap reach production.
    for (const [runner, pendingTag] of Object.entries(BDD_RUNNER_TAG_TABLE)) {
      assert.ok(
        PENDING_TAGS.has(pendingTag),
        `PENDING_TAGS missing ${pendingTag} (registered by ${runner} in BDD_RUNNER_TAG_TABLE)`,
      );
    }
  });

  it('exposes the runner→tag lookup table for downstream callers', () => {
    assert.ok(Object.hasOwn(BDD_RUNNER_TAG_TABLE, 'playwright-bdd'));
    assert.ok(Object.hasOwn(BDD_RUNNER_TAG_TABLE, '@cucumber/cucumber'));
    // Table is frozen — guard against accidental mutation by callers.
    assert.throws(() => {
      BDD_RUNNER_TAG_TABLE['some-new-runner'] = '@skip';
    });
  });

  // Story #2956 — workspace-aware detection. The runner often lives in a
  // workspace package (e.g. `apps/web/package.json`) in pnpm/npm/yarn
  // monorepos; the detector must union deps across the root and every
  // declared workspace before deciding to fall back.
  describe('workspace-aware detection (Story #2956)', () => {
    it('detects a runner declared in a workspace package.json', async () => {
      const result = await verifyBddRunnerPendingTag({
        cwd: '/repo',
        readPkg: async (p) => {
          if (
            p.endsWith('/repo/package.json') ||
            p.endsWith('\\repo\\package.json')
          ) {
            return JSON.stringify({ name: 'root', dependencies: {} });
          }
          if (
            p.endsWith('apps/web/package.json') ||
            p.endsWith('apps\\web\\package.json')
          ) {
            return JSON.stringify({
              name: 'web',
              devDependencies: { 'playwright-bdd': '^8.5.1' },
            });
          }
          throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        },
        listWorkspacePkgPaths: async ({ cwd }) => [
          `${cwd}/apps/web/package.json`,
        ],
      });
      assert.equal(result.runner, 'playwright-bdd');
      assert.equal(result.pendingTag, '@skip');
      assert.equal(result.supported, true);
      assert.equal(result.fallback, false);
    });

    it('falls back when no workspace package declares a runner', async () => {
      const result = await verifyBddRunnerPendingTag({
        cwd: '/repo',
        readPkg: async (p) => {
          if (p.endsWith('package.json')) {
            return JSON.stringify({ dependencies: { lodash: '*' } });
          }
          throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        },
        listWorkspacePkgPaths: async ({ cwd }) => [
          `${cwd}/apps/web/package.json`,
          `${cwd}/packages/ui/package.json`,
        ],
      });
      assert.equal(result.runner, null);
      assert.equal(result.fallback, true);
      assert.equal(result.reason, 'no-bdd-runner-detected');
    });

    it('preserves preferred-first ordering across root and workspaces', async () => {
      // Root declares cucumber-js (later in the preferred-first table);
      // workspace declares playwright-bdd (first). The first runner in
      // BDD_RUNNER_TAG_TABLE that appears anywhere wins.
      const result = await verifyBddRunnerPendingTag({
        cwd: '/repo',
        readPkg: async (p) => {
          if (
            p.endsWith('/repo/package.json') ||
            p.endsWith('\\repo\\package.json')
          ) {
            return JSON.stringify({
              devDependencies: { 'cucumber-js': '^9.0.0' },
            });
          }
          if (p.includes('apps')) {
            return JSON.stringify({
              devDependencies: { 'playwright-bdd': '^8.5.1' },
            });
          }
          throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        },
        listWorkspacePkgPaths: async ({ cwd }) => [
          `${cwd}/apps/web/package.json`,
        ],
      });
      assert.equal(result.runner, 'playwright-bdd');
    });

    it('ignores unreadable workspace package.json files (non-fatal)', async () => {
      const result = await verifyBddRunnerPendingTag({
        cwd: '/repo',
        readPkg: async (p) => {
          if (
            p.endsWith('/repo/package.json') ||
            p.endsWith('\\repo\\package.json')
          ) {
            return JSON.stringify({
              devDependencies: { '@cucumber/cucumber': '^11.0.0' },
            });
          }
          // Every workspace pkg "fails to read" — must not crash; root match
          // still wins.
          throw new Error('boom');
        },
        listWorkspacePkgPaths: async ({ cwd }) => [
          `${cwd}/apps/web/package.json`,
        ],
      });
      assert.equal(result.runner, '@cucumber/cucumber');
    });

    it('ignores unparseable workspace package.json files (non-fatal)', async () => {
      const result = await verifyBddRunnerPendingTag({
        cwd: '/repo',
        readPkg: async (p) => {
          if (
            p.endsWith('/repo/package.json') ||
            p.endsWith('\\repo\\package.json')
          ) {
            return JSON.stringify({ dependencies: {} });
          }
          return '{ not valid json';
        },
        listWorkspacePkgPaths: async ({ cwd }) => [
          `${cwd}/apps/web/package.json`,
        ],
      });
      assert.equal(result.fallback, true);
      assert.equal(result.reason, 'no-bdd-runner-detected');
    });

    // Real-filesystem tests for the default workspace-discovery path.
    // The injection-free tests above cover the union/preference logic;
    // these probe the actual yaml + glob-expansion implementation against
    // an isolated temp directory.
    describe('default discovery against the filesystem', () => {
      let root;
      beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), 'bdd-runner-detect-'));
      });
      afterEach(() => {
        rmSync(root, { recursive: true, force: true });
      });

      const writePkg = (rel, pkg) => {
        const dir = path.join(root, rel);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
      };

      it('expands pnpm-workspace.yaml `apps/*` to find a runner one level down', async () => {
        writePkg('.', { name: 'root', private: true, devDependencies: {} });
        writePkg('apps/web', {
          name: 'web',
          devDependencies: { 'playwright-bdd': '^8.5.1' },
        });
        writeFileSync(
          path.join(root, 'pnpm-workspace.yaml'),
          'packages:\n  - apps/*\n  - packages/*\n',
        );
        const result = await verifyBddRunnerPendingTag({ cwd: root });
        assert.equal(result.runner, 'playwright-bdd');
        assert.equal(result.fallback, false);
      });

      it('expands a `workspaces` array on the root package.json', async () => {
        writePkg('.', {
          name: 'root',
          private: true,
          workspaces: ['apps/*'],
        });
        writePkg('apps/api', {
          name: 'api',
          devDependencies: { '@cucumber/cucumber': '^11.0.0' },
        });
        const result = await verifyBddRunnerPendingTag({ cwd: root });
        assert.equal(result.runner, '@cucumber/cucumber');
      });

      it('expands a `workspaces.packages` object form (yarn classic)', async () => {
        writePkg('.', {
          name: 'root',
          private: true,
          workspaces: { packages: ['apps/*'] },
        });
        writePkg('apps/mobile', {
          name: 'mobile',
          devDependencies: { 'cucumber-js': '^9.0.0' },
        });
        const result = await verifyBddRunnerPendingTag({ cwd: root });
        assert.equal(result.runner, 'cucumber-js');
      });

      it('honours `!` exclusion patterns in pnpm-workspace.yaml', async () => {
        writePkg('.', { name: 'root', private: true });
        writePkg('apps/web', {
          name: 'web',
          devDependencies: { 'playwright-bdd': '^8.5.1' },
        });
        writeFileSync(
          path.join(root, 'pnpm-workspace.yaml'),
          'packages:\n  - apps/*\n  - "!apps/web"\n',
        );
        const result = await verifyBddRunnerPendingTag({ cwd: root });
        // apps/web is excluded → no runner detected anywhere.
        assert.equal(result.fallback, true);
        assert.equal(result.reason, 'no-bdd-runner-detected');
      });

      it('walks recursive `packages/**` patterns', async () => {
        writePkg('.', { name: 'root', private: true });
        writePkg('packages/qa/e2e', {
          name: 'e2e',
          devDependencies: { 'playwright-bdd': '^8.5.1' },
        });
        writeFileSync(
          path.join(root, 'pnpm-workspace.yaml'),
          'packages:\n  - "packages/**"\n',
        );
        const result = await verifyBddRunnerPendingTag({ cwd: root });
        assert.equal(result.runner, 'playwright-bdd');
      });
    });

    it('treats workspace discovery failure as non-fatal (degrades to root scan)', async () => {
      const result = await verifyBddRunnerPendingTag({
        cwd: '/repo',
        readPkg: async () =>
          JSON.stringify({
            devDependencies: { 'playwright-bdd': '^8.0.0' },
          }),
        listWorkspacePkgPaths: async () => {
          throw new Error('workspace discovery exploded');
        },
      });
      assert.equal(result.runner, 'playwright-bdd');
    });
  });
});
