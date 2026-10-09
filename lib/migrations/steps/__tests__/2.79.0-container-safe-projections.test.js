/**
 * Story #5581 — the 2.79.0 step brings an existing consumer's `prepare` and
 * `.gitignore` to the fresh-bootstrap shape: guarded prepare, `.claude/agents/`
 * ignored. Driven against a real temp project root.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  ensureGitignore,
  GITIGNORE_BLOCKS,
  LEGACY_PREPARE_COMMAND,
  PREPARE_COMMAND,
} from '../../../../.agents/scripts/lib/bootstrap/project-bootstrap.js';
import { makeTempDir } from '../../../../.agents/scripts/lib/test-temp.js';
import { compareVersions, migrations, runMigrations } from '../../index.js';
import { containerSafeProjections } from '../2.79.0-container-safe-projections.js';

/**
 * @param {{ prepare?: string, gitignore?: string }} [opts]
 * @returns {{ ctx: { projectRoot: string }, pkgPath: string, giPath: string }}
 */
function project({ prepare = LEGACY_PREPARE_COMMAND, gitignore } = {}) {
  const projectRoot = makeTempDir('container-safe-projections-');
  const pkgPath = path.join(projectRoot, 'package.json');
  const giPath = path.join(projectRoot, '.gitignore');
  const scripts = prepare === undefined ? {} : { prepare, build: 'tsc' };
  fs.writeFileSync(
    pkgPath,
    `${JSON.stringify({ name: 'host', scripts }, null, 2)}\n`,
  );
  if (gitignore !== undefined) fs.writeFileSync(giPath, gitignore);
  return { ctx: { projectRoot }, pkgPath, giPath };
}

const readPkg = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** A .gitignore exactly as a pre-#5581 bootstrap left it. */
function legacyGitignore() {
  const root = makeTempDir('container-safe-legacy-gi-');
  ensureGitignore(
    { projectRoot: root },
    Object.keys(GITIGNORE_BLOCKS).filter((k) => k !== 'agents'),
  );
  return fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
}

describe('containerSafeProjections (2.79.0)', () => {
  it('upgrades a legacy prepare and adds the .claude/agents/ ignore entry', () => {
    const { ctx, pkgPath, giPath } = project({ gitignore: legacyGitignore() });
    assert.equal(containerSafeProjections.detect(ctx), true);
    containerSafeProjections.apply(ctx);
    const pkg = readPkg(pkgPath);
    assert.equal(pkg.scripts.prepare, PREPARE_COMMAND);
    assert.equal(pkg.scripts.build, 'tsc', 'other scripts survive');
    const body = fs.readFileSync(giPath, 'utf8');
    assert.ok(GITIGNORE_BLOCKS.agents.pattern.test(body));
    assert.ok(body.includes('.claude/commands/'), 'existing entries survive');
  });

  it('leaves an operator-customised prepare alone while still adding the ignore entry', () => {
    const custom = `husky && ${LEGACY_PREPARE_COMMAND}`;
    const { ctx, pkgPath, giPath } = project({
      prepare: custom,
      gitignore: 'node_modules/\n',
    });
    assert.equal(containerSafeProjections.detect(ctx), true);
    containerSafeProjections.apply(ctx);
    assert.equal(readPkg(pkgPath).scripts.prepare, custom);
    assert.equal(
      fs.readFileSync(giPath, 'utf8'),
      `node_modules/\n${GITIGNORE_BLOCKS.agents.block}`,
    );
  });

  it('is a no-op on an already-migrated project', () => {
    const { ctx, pkgPath, giPath } = project({
      prepare: PREPARE_COMMAND,
      gitignore: `node_modules/\n.claude/agents/\n`,
    });
    const pkgBefore = fs.readFileSync(pkgPath, 'utf8');
    const giBefore = fs.readFileSync(giPath, 'utf8');
    assert.equal(containerSafeProjections.detect(ctx), false);
    const result = runMigrations({
      fromVersion: '2.78.0',
      toVersion: '2.79.0',
      ctx,
      log: () => {},
    });
    assert.deepEqual(result, { applied: [], skipped: ['2.79.0'] });
    assert.equal(fs.readFileSync(pkgPath, 'utf8'), pkgBefore);
    assert.equal(fs.readFileSync(giPath, 'utf8'), giBefore);
  });

  it('is idempotent: detect is false after apply, and a second pass changes nothing', () => {
    const { ctx, pkgPath, giPath } = project({ gitignore: legacyGitignore() });
    const first = runMigrations({
      fromVersion: '2.78.0',
      toVersion: '2.79.0',
      ctx,
      log: () => {},
    });
    assert.deepEqual(first.applied, ['2.79.0']);
    assert.equal(containerSafeProjections.detect(ctx), false);
    const pkgAfter = fs.readFileSync(pkgPath, 'utf8');
    const giAfter = fs.readFileSync(giPath, 'utf8');
    const second = runMigrations({
      fromVersion: '2.78.0',
      toVersion: '2.79.0',
      ctx,
      log: () => {},
    });
    assert.deepEqual(second, { applied: [], skipped: ['2.79.0'] });
    assert.equal(fs.readFileSync(pkgPath, 'utf8'), pkgAfter);
    assert.equal(fs.readFileSync(giPath, 'utf8'), giAfter);
  });

  it('tolerates a project without package.json', () => {
    const projectRoot = makeTempDir('container-safe-no-pkg-');
    const ctx = { projectRoot };
    assert.equal(containerSafeProjections.detect(ctx), true);
    containerSafeProjections.apply(ctx);
    assert.equal(fs.existsSync(path.join(projectRoot, 'package.json')), false);
    assert.equal(containerSafeProjections.detect(ctx), false);
  });

  it('is registered in ascending version order', () => {
    const i = migrations.indexOf(containerSafeProjections);
    assert.ok(i > 0, 'registered');
    assert.equal(containerSafeProjections.version, '2.79.0');
    assert.equal(
      compareVersions(migrations[i - 1].version, '2.79.0') < 0,
      true,
    );
    const next = migrations[i + 1];
    if (next) assert.equal(compareVersions(next.version, '2.79.0') > 0, true);
  });
});
