import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  executeDeletion,
  parseDeleteArgs,
  planDeletion,
  renderDeletionLine,
  renderDryRun,
  renderExecutionSummary,
} from '../.agents/scripts/delete-epic-branches.js';
import { __setGitRunners } from '../.agents/scripts/lib/git-utils.js';

const DELETE_EPIC_BRANCHES_SRC = readFileSync(
  fileURLToPath(
    new URL('../.agents/scripts/delete-epic-branches.js', import.meta.url),
  ),
  'utf8',
);
const DELETE_EPIC_BRANCHES_WORKFLOW = readFileSync(
  fileURLToPath(
    new URL('../.agents/workflows/delete-epic-branches.md', import.meta.url),
  ),
  'utf8',
);

describe('delete-epic-branches.parseDeleteArgs', () => {
  it('returns null epicId when missing or invalid', () => {
    assert.equal(parseDeleteArgs([]).epicId, null);
    assert.equal(parseDeleteArgs(['--epic', 'abc']).epicId, null);
    assert.equal(parseDeleteArgs(['--epic', '0']).epicId, null);
  });
  it('parses --epic, --dry-run, --json flags', () => {
    const out = parseDeleteArgs(['--epic', '777', '--dry-run', '--json']);
    assert.deepEqual(out, { epicId: 777, dryRun: true, json: true });
  });
  it('defaults boolean flags to false', () => {
    assert.deepEqual(parseDeleteArgs(['--epic', '7']), {
      epicId: 7,
      dryRun: false,
      json: false,
    });
  });
});

describe('delete-epic-branches.renderDryRun', () => {
  it('lists branches when present', () => {
    const lines = renderDryRun({
      epicId: 12,
      local: ['epic/12', 'story/epic-12/40'],
      remote: ['epic/12'],
    });
    assert.equal(lines.length, 3);
    assert.match(lines[0], /Epic #12 — DRY RUN/);
    assert.match(lines[1], /Local {3}\(2\): epic\/12, story\/epic-12\/40/);
    assert.match(lines[2], /Remote {2}\(1\): epic\/12/);
  });
  it('renders (none) when both lists are empty', () => {
    const lines = renderDryRun({ epicId: 99, local: [], remote: [] });
    assert.match(lines[1], /\(none\)/);
    assert.match(lines[2], /\(none\)/);
  });
});

describe('delete-epic-branches.renderDeletionLine', () => {
  it('renders an OK local line', () => {
    assert.equal(
      renderDeletionLine({ branch: 'epic/1', ok: true }, 'local'),
      '[delete-epic-branches] ✅ local  epic/1',
    );
  });
  it('renders a failed local line', () => {
    assert.equal(
      renderDeletionLine({ branch: 'epic/2', ok: false }, 'local'),
      '[delete-epic-branches] ❌ local  epic/2',
    );
  });
  it('renders a remote line with already-gone annotation', () => {
    assert.equal(
      renderDeletionLine(
        { branch: 'task/epic-1/3', ok: true, alreadyGone: true },
        'remote',
      ),
      '[delete-epic-branches] ✅ remote task/epic-1/3 (already gone)',
    );
  });
  it('renders a remote failure without annotation', () => {
    assert.equal(
      renderDeletionLine({ branch: 'epic/4', ok: false }, 'remote'),
      '[delete-epic-branches] ❌ remote epic/4',
    );
  });
});

describe('delete-epic-branches.renderExecutionSummary', () => {
  it('reports success counts when ok', () => {
    const out = renderExecutionSummary(7, {
      ok: true,
      local: [1, 2],
      remote: [1],
      failures: [],
    });
    assert.equal(
      out,
      '[delete-epic-branches] ✅ Epic #7 — 2 local + 1 remote branch(es) deleted.',
    );
  });
  it('reports failure count when not ok', () => {
    const out = renderExecutionSummary(7, {
      ok: false,
      local: [],
      remote: [],
      failures: [{}, {}, {}],
    });
    assert.equal(out, '[delete-epic-branches] ❌ 3 deletion(s) failed.');
  });
});

describe('delete-epic-branches.planDeletion', () => {
  it('collects local + remote matches from the injected listers', () => {
    const plan = planDeletion({
      epicId: 441,
      localLister: () => ['epic/441', 'story/epic-441/453'],
      remoteLister: () => ['epic/441', 'task/epic-441/500'],
    });
    assert.equal(plan.epicId, 441);
    assert.deepEqual(plan.local, ['epic/441', 'story/epic-441/453']);
    assert.deepEqual(plan.remote, ['epic/441', 'task/epic-441/500']);
  });

  it('tolerates empty match sets', () => {
    const plan = planDeletion({
      epicId: 999,
      localLister: () => [],
      remoteLister: () => [],
    });
    assert.deepEqual(plan.local, []);
    assert.deepEqual(plan.remote, []);
  });
});

describe('delete-epic-branches.executeDeletion', () => {
  it('reports ok when all deletions succeed', () => {
    const plan = { epicId: 1, local: ['a'], remote: ['b'] };
    const result = executeDeletion({
      plan,
      deleteLocal: (b) => ({ branch: b, ok: true }),
      deleteRemote: (b) => ({ branch: b, ok: true, alreadyGone: false }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.failures.length, 0);
  });

  it('aggregates failures and flips ok to false', () => {
    const plan = { epicId: 1, local: ['a', 'b'], remote: ['c'] };
    const result = executeDeletion({
      plan,
      deleteLocal: (b) => ({ branch: b, ok: b !== 'b', stderr: 'nope' }),
      deleteRemote: (b) => ({ branch: b, ok: true, alreadyGone: false }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].branch, 'b');
    assert.equal(result.failures[0].scope, 'local');
  });

  it('treats already-gone remote refs as success', () => {
    const plan = { epicId: 1, local: [], remote: ['orig-only'] };
    const result = executeDeletion({
      plan,
      deleteLocal: () => ({ ok: true }),
      deleteRemote: (b) => ({ branch: b, ok: true, alreadyGone: true }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.remote[0].alreadyGone, true);
  });
});

describe('delete-epic-branches — wrapper integration with git-branch-cleanup', () => {
  after(() => {
    __setGitRunners(execFileSync, spawnSync);
  });

  it("treats 'remote ref does not exist' as deleted: true, reason: 'not-found' (regression)", () => {
    // Drives executeDeletion through the real wrappers (no `deleteRemote`
    // injection), which now delegate to `deleteBranchRemote` from the
    // shared cleanup lib. Mock the spawn layer to emit git's exact
    // already-gone error so the lib's NOT_FOUND_REMOTE matcher fires.
    __setGitRunners(
      () => '',
      (_cmd, args) => {
        // Only the per-ref `git push origin --delete <branch>` is
        // expected here — listing happens via `planDeletion`'s injected
        // listers, so the test doesn't drive the real branch-list calls.
        assert.deepEqual(args, [
          'push',
          'origin',
          '--delete',
          'story/epic-9/already-gone',
        ]);
        return {
          status: 1,
          stdout: '',
          stderr:
            "error: unable to delete 'story/epic-9/already-gone': remote ref does not exist",
        };
      },
    );

    const plan = {
      epicId: 9,
      local: [],
      remote: ['story/epic-9/already-gone'],
    };
    const result = executeDeletion({ plan });

    // The wrapper carries both the new lib shape (deleted/reason) and
    // the legacy shape (ok/alreadyGone) so executeDeletion's `failures`
    // filter and `renderDeletionLine`'s annotation both stay correct.
    assert.equal(result.ok, true);
    assert.equal(result.failures.length, 0);
    const row = result.remote[0];
    assert.equal(row.branch, 'story/epic-9/already-gone');
    assert.equal(row.deleted, true);
    assert.equal(row.reason, 'not-found');
    assert.equal(row.ok, true);
    assert.equal(row.alreadyGone, true);
  });
});

describe('delete-epic-branches — worktree-only scope (regression)', () => {
  it('does not import or reference ITicketingProvider', () => {
    assert.equal(
      DELETE_EPIC_BRANCHES_SRC.includes('ITicketingProvider'),
      false,
      'delete-epic-branches.js must not depend on ITicketingProvider — ticket state is owned by story-close.js / epic-deliver-finalize.js',
    );
  });

  it('does not import any ticketing provider module', () => {
    // Allow-list: only git/worktree/CLI utilities + Logger. Anything matching
    // a ticketing/provider/issue/label import is a worktree-only-scope leak.
    const importLines = DELETE_EPIC_BRANCHES_SRC.split('\n').filter((l) =>
      /^\s*import\b/.test(l),
    );
    for (const line of importLines) {
      assert.equal(
        /ticket|provider|issue|label|github/i.test(line),
        false,
        `delete-epic-branches.js import leaks out of worktree scope: ${line}`,
      );
    }
  });

  it('does not invoke any ticket-closure helper', () => {
    // Sentinel call sites that would indicate the script is mutating ticket
    // state. If a future refactor reintroduces any of these, the regression
    // here flags it before the workflow doc and the runtime drift apart.
    const closureSentinels = [
      'closeTicket',
      'closeIssue',
      'updateTicketState',
      'transitionTicket',
      'agent::done',
      'gh issue close',
    ];
    for (const sentinel of closureSentinels) {
      assert.equal(
        DELETE_EPIC_BRANCHES_SRC.includes(sentinel),
        false,
        `delete-epic-branches.js must not invoke ticket-closure path: ${sentinel}`,
      );
    }
  });

  it('workflow doc declares worktree-only scope and disclaims ticket closure', () => {
    assert.match(
      DELETE_EPIC_BRANCHES_WORKFLOW,
      /worktree-only/i,
      'workflow markdown must declare worktree-only scope',
    );
    assert.equal(
      /close.*ticket|ticket.*closure/i.test(DELETE_EPIC_BRANCHES_WORKFLOW),
      true,
      'workflow markdown must explicitly disclaim ticket closure (point operators at /delete-epic-tickets)',
    );
  });
});

describe('delete-epic-branches — transitive dependency graph (regression)', () => {
  // Recursively walk the static `import` graph of delete-epic-branches.js and
  // assert that every reachable file is free of `ITicketingProvider`. If a
  // future refactor pulls a helper that itself imports a ticketing provider,
  // this test fails even though the top-level source is still clean.
  function collectTransitiveSources(entryUrl) {
    const visited = new Set();
    const seenSources = new Map();

    function walk(fileUrl) {
      if (visited.has(fileUrl)) return;
      visited.add(fileUrl);
      let src;
      try {
        src = readFileSync(fileURLToPath(fileUrl), 'utf8');
      } catch {
        // Bare module specifiers / node: built-ins resolve outside the repo —
        // skip them (they cannot leak a ticketing provider into our scope).
        return;
      }
      seenSources.set(fileUrl, src);
      const importRe = /^\s*import\s+(?:[^'"`]*?from\s+)?['"`]([^'"`]+)['"`]/gm;
      let match;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
      while ((match = importRe.exec(src)) !== null) {
        const spec = match[1];
        if (!spec.startsWith('.') && !spec.startsWith('/')) continue; // bare/native
        try {
          const child = new URL(spec, fileUrl);
          walk(child);
        } catch {
          // Unresolvable — treat as opaque; the top-level text scan above
          // already covers the source we *can* read.
        }
      }
    }

    walk(entryUrl);
    return seenSources;
  }

  const entry = new URL(
    '../.agents/scripts/delete-epic-branches.js',
    import.meta.url,
  );
  const transitiveSources = collectTransitiveSources(entry);

  it('reachable import graph is non-empty and includes delete-epic-branches.js', () => {
    assert.ok(
      transitiveSources.size > 1,
      'collectTransitiveSources should have walked at least one helper',
    );
    const entryHref = entry.href;
    assert.ok(
      [...transitiveSources.keys()].some((u) => u.href === entryHref),
      'entry module must appear in the visited set',
    );
  });

  it('no file in the import graph references ITicketingProvider', () => {
    const offenders = [];
    for (const [url, src] of transitiveSources.entries()) {
      if (src.includes('ITicketingProvider')) {
        offenders.push(url.href);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `transitive import graph must not depend on ITicketingProvider; offenders=${JSON.stringify(offenders)}`,
    );
  });

  it('no file in the import graph imports a ticketing/issue/label module', () => {
    const offenders = [];
    for (const [url, src] of transitiveSources.entries()) {
      const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
      for (const line of importLines) {
        if (
          /ticket|provider-|issue-mutator|label-mutator|gh-mutate/i.test(line)
        ) {
          offenders.push({ file: url.href, line: line.trim() });
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `transitive graph must not import ticketing/mutation modules; offenders=${JSON.stringify(offenders)}`,
    );
  });
});

describe('delete-epic-branches — fixture regression: only branch/worktree ops', () => {
  // Drive the CLI's exported entry points end-to-end against a fixture set
  // of "matched branches" and assert the only git verbs invoked are
  // `branch -D` (local) and `push origin --delete` (remote). If a future
  // refactor sneaks in a `gh issue close` or similar via the wrapper layer,
  // this regression fires because the verb-whitelist breaks.
  after(() => {
    __setGitRunners(execFileSync, spawnSync);
  });

  it('only invokes branch / push operations when executing the plan', () => {
    const invocations = [];
    __setGitRunners(
      () => '',
      (_cmd, args) => {
        invocations.push(args.slice());
        // Pretend each deletion succeeds with empty output.
        return { status: 0, stdout: '', stderr: '' };
      },
    );

    const plan = {
      epicId: 1182,
      local: ['epic/1182', 'story/epic-1182/1503'],
      remote: ['epic/1182', 'task/epic-1182/1542'],
    };
    const result = executeDeletion({ plan });

    assert.equal(result.ok, true);
    assert.equal(result.local.length, 2);
    assert.equal(result.remote.length, 2);

    // Every captured git invocation must be a worktree-scope verb only:
    //   - `branch -D <name>`           (local deletion)
    //   - `push origin --delete <ref>` (remote deletion)
    // Anything else (e.g. `issue`, `api`, `pr`, `label`) is a scope leak.
    for (const args of invocations) {
      const isLocalDelete = args[0] === 'branch' && args[1] === '-D';
      const isRemoteDelete =
        args[0] === 'push' && args[1] === 'origin' && args[2] === '--delete';
      assert.ok(
        isLocalDelete || isRemoteDelete,
        `worktree-only scope violated by git args=${JSON.stringify(args)}`,
      );
    }

    // And the verbs we expect MUST have actually been called (i.e. the
    // fixture wasn't degenerate / no-op).
    assert.equal(
      invocations.filter((a) => a[0] === 'branch' && a[1] === '-D').length,
      2,
    );
    assert.equal(
      invocations.filter(
        (a) => a[0] === 'push' && a[1] === 'origin' && a[2] === '--delete',
      ).length,
      2,
    );
  });
});
