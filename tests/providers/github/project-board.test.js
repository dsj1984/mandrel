/**
 * Unit test for `.agents/scripts/providers/github/project-board.js`.
 *
 * The gateway is a thin pass-through to the existing `projects-v2-graphql`
 * shim — the GraphQL semantics are exercised exhaustively by
 * `tests/lib/providers/github-projects-extra.test.js` and friends. This
 * suite asserts the gateway threads the shared `_ctx` into every shim
 * call so the `ensureProjectFields` ordering invariant the parent
 * provider relied on continues to hold via the new delegation path.
 *
 * Story #2462 / Task #2479 — ProjectBoardGateway is the project-board
 * slice of the seven-gateway split.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const pbMod = await import(
  pathToFileURL(
    path.join(
      ROOT,
      '.agents',
      'scripts',
      'providers',
      'github',
      'project-board.js',
    ),
  ).href
);

const { ProjectBoardGateway } = pbMod;

describe('providers/github/project-board.js — ProjectBoardGateway', () => {
  it('exposes the four Projects V2 methods on its prototype', () => {
    const gw = new ProjectBoardGateway({ ctx: {} });
    assert.equal(typeof gw.resolveOrCreateProject, 'function');
    assert.equal(typeof gw.ensureStatusField, 'function');
    assert.equal(typeof gw.ensureProjectViews, 'function');
    assert.equal(typeof gw.ensureProjectFields, 'function');
  });

  it('preserves the shared _ctx instance across calls', () => {
    const ctx = { owner: 'o', repo: 'r', state: { projectId: 'fixture' } };
    const gw = new ProjectBoardGateway({ ctx });
    assert.strictEqual(gw._ctx, ctx);
    // Mutations on ctx (the shim mutates `state.projectId` after
    // `resolveOrCreateProject`) survive because the reference is shared.
    ctx.state.projectId = 'mutated';
    assert.equal(gw._ctx.state.projectId, 'mutated');
  });
});
