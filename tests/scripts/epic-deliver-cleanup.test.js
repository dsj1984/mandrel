import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseCleanupArgs,
  renderSummaryLines,
  runEpicDeliverCleanup,
} from '../../.agents/scripts/epic-deliver-cleanup.js';

describe('parseCleanupArgs', () => {
  it('parses --epic / --dry-run / --json', () => {
    const out = parseCleanupArgs(['--epic', '1178', '--dry-run', '--json']);
    assert.deepEqual(out, {
      epicId: 1178,
      dryRun: true,
      json: true,
      help: false,
    });
  });

  it('defaults flags to false', () => {
    const out = parseCleanupArgs(['--epic', '5']);
    assert.equal(out.dryRun, false);
    assert.equal(out.json, false);
  });

  it('rejects bad epic ids', () => {
    assert.equal(parseCleanupArgs(['--epic', '0']).epicId, null);
    assert.equal(parseCleanupArgs([]).epicId, null);
  });
});

describe('runEpicDeliverCleanup', () => {
  it('returns ok=true with no work when checkpoint is missing', async () => {
    const out = await runEpicDeliverCleanup({
      epicId: 1178,
      injectedConfig: { orchestration: { provider: 'fake' } },
      injectedProvider: {},
      checkpointerFactory: () => ({ read: async () => null }),
      gitSpawnFn: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    assert.equal(out.ok, true);
    assert.equal(out.stateFound, false);
    assert.equal(out.reaped.length, 0);
  });

  it('dry-run lists branches without invoking git delete', async () => {
    let deleteCalled = false;
    const gitSpawnFn = (_cwd, ...args) => {
      if (args[0] === 'branch' && args[1] === '-D') {
        deleteCalled = true;
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const out = await runEpicDeliverCleanup({
      epicId: 1178,
      dryRun: true,
      injectedConfig: { orchestration: { provider: 'fake' } },
      injectedProvider: {},
      checkpointerFactory: () => ({
        read: async () => ({
          epicId: 1178,
          waves: [{ stories: [{ id: 1 }, { id: 2 }] }],
        }),
      }),
      gitSpawnFn,
    });
    assert.equal(out.dryRun, true);
    assert.equal(deleteCalled, false);
    assert.equal(out.branches.epicBranch, 'epic/1178');
    assert.deepEqual(out.branches.storyBranches, ['story-1', 'story-2']);
  });

  it('reaps story + epic branches when checkpoint enumerates them', async () => {
    const calls = [];
    const gitSpawnFn = (_cwd, ...args) => {
      calls.push(args.join(' '));
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const out = await runEpicDeliverCleanup({
      epicId: 100,
      injectedConfig: { orchestration: { provider: 'fake' } },
      injectedProvider: {},
      checkpointerFactory: () => ({
        read: async () => ({
          epicId: 100,
          waves: [{ stories: [{ id: 1 }] }],
        }),
      }),
      gitSpawnFn,
    });
    assert.equal(out.ok, true);
    assert.equal(out.reaped.length, 2);
    assert.deepEqual(
      out.reaped.map((r) => r.branch),
      ['story-1', 'epic/100'],
    );
    assert.ok(calls.some((c) => c === 'branch -D story-1'));
    assert.ok(calls.some((c) => c === 'branch -D epic/100'));
  });

  it('rejects bad epicId', async () => {
    await assert.rejects(
      () => runEpicDeliverCleanup({ epicId: 0 }),
      /must be a positive integer/,
    );
  });
});

describe('renderSummaryLines', () => {
  it('renders the header + one line per reaped branch', () => {
    const lines = renderSummaryLines({
      dryRun: false,
      reaped: [
        { branch: 'story-1', method: 'worktree-remove', branchDeleted: true },
        {
          branch: 'epic/100',
          method: 'no-worktree',
          branchDeleted: false,
          stderr: 'still checked out',
        },
      ],
      failures: [
        {
          branch: 'epic/100',
          method: 'no-worktree',
          branchDeleted: false,
          stderr: 'still checked out',
        },
      ],
    });
    assert.equal(lines.length, 3);
    assert.match(lines[0], /reaped=2 failures=1/);
    assert.match(lines[1], /story-1.*wt=worktree-remove.*branch=deleted/);
    assert.match(lines[2], /epic\/100.*branch=kept.*stderr=still checked out/);
  });

  it('prefixes (dry-run) in the header when dry', () => {
    const [header] = renderSummaryLines({
      dryRun: true,
      reaped: [],
      failures: [],
    });
    assert.match(header, /\(dry-run\)/);
  });
});
