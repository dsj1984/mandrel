// tests/scripts/single-story-init-checklist.test.js — Story #5518.
//
// The footprint-matched write-time checklist reaches every delivery path:
// `single-story-init.js` builds it from the Story body and returns its path
// in the init envelope (so a one-Story inline run gets it too), and a
// multi-Story dispatch prompt names that SAME Story-scoped path because both
// call the one `buildStoryChecklist` helper.

import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { buildStoryChecklist } from '../../.agents/scripts/lib/audit-suite/index.js';
import { storyTempDir } from '../../.agents/scripts/lib/config/temp-paths.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { runSingleStoryInit } from '../../.agents/scripts/single-story-init.js';

// A security-sensitive footprint so at least one lens matches.
const BODY = [
  '## Goal',
  'x',
  '',
  '## Changes',
  '- `.agents/scripts/lib/orchestration/code-review.js` — refactors-existing',
  '',
  '## Acceptance',
  '- [ ] AC-1: holds',
].join('\n');

let tempRoot;
beforeEach(() => {
  tempRoot = makeTempDir('mandrel-init-checklist-');
});
afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

const configFor = () => ({
  project: { baseBranch: 'main', paths: { tempRoot } },
  github: { operatorHandle: '@dsj1984' },
});

function initArgs(config, body, overrides = {}) {
  const provider = {
    async getTicket() {
      return {
        labels: ['type::story', 'agent::ready'],
        title: 'Story 5518',
        body,
        assignees: ['dsj1984'],
        state: 'open',
      };
    },
    async updateTicket() {},
  };
  return {
    storyId: 5518,
    injectedProvider: provider,
    injectedConfig: config,
    injectedVerifyRemote: () => ({
      remoteVerified: true,
      remoteUrl: 'https://github.com/dsj1984/mandrel.git',
      detail: 'ok',
    }),
    injectedAcquireLease: async () => ({
      acquired: true,
      owner: 'dsj1984',
      previousOwner: null,
      reason: 'unclaimed',
    }),
    injectedMaterialize: async () => {},
    injectedSeedBranch: () => {},
    injectedProvisionWorktree: async () => ({
      workCwd: '/tmp/wt',
      worktreeCreated: true,
      installStatus: { status: 'skipped', reason: 'test' },
    }),
    ...overrides,
  };
}

describe('single-story-init — the write-time checklist on every path', () => {
  it('returns the footprint-matched checklist path in the init envelope', async () => {
    const config = configFor();
    const { result } = await runSingleStoryInit(initArgs(config, BODY));
    assert.ok(result.checklistPath, 'a lens matched this footprint');
    assert.equal(
      path.dirname(result.checklistPath),
      storyTempDir(null, 5518, config),
    );
    assert.match(readFileSync(result.checklistPath, 'utf8'), /checklist/i);
  });

  it('names the same path a dispatch prompt names for the Story', async () => {
    const config = configFor();
    const { result } = await runSingleStoryInit(initArgs(config, BODY));
    const dispatch = buildStoryChecklist({ storyId: 5518, body: BODY, config });
    assert.equal(dispatch.checklistPath, result.checklistPath);
  });

  it('is null when no lens matches the footprint', async () => {
    const config = configFor();
    const { result } = await runSingleStoryInit(
      initArgs(config, BODY, {
        injectedBuildChecklist: () => ({ checklistPath: null }),
      }),
    );
    assert.equal(result.checklistPath, null);
  });

  it('a checklist builder failure costs the checklist, never the caller', () => {
    const out = buildStoryChecklist({
      storyId: 5518,
      body: BODY,
      config: configFor(),
      buildChecklistFn: () => {
        throw new Error('lens index unreadable');
      },
    });
    assert.deepEqual(out, { checklistPath: null });
  });
});
