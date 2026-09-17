/**
 * deliver-run.test.js — Story #5345.
 *
 * `deliver-run.js` is the multi-Story delivery beat: tick, dispatch prompts,
 * run ledger, close commands. The tests drive the real beat over an injected
 * probe, so the scheduling kernel, the ledger round-trip and the prompt writer
 * are all exercised together — only the GitHub read is stubbed.
 *
 * Covered:
 *   - AC-1: one beat, one compact envelope; exit codes 2 / 3 / 4 preserved
 *   - AC-2: a repeat beat withholds what the ledger recorded, with no
 *     --dispatched from the caller
 *   - AC-3: a dispatch prompt per ready Story, carrying id, docs digest path,
 *     checklist path and the change-set discipline
 *   - AC-4: --merge-watch-mode async on a multi-Story run, absent on N=1
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  deriveRunId,
  readLedgerDispatched,
  renderCloseCommand,
  renderDispatchPrompt,
  resolveRunIds,
  runDeliverRunBeat,
} from '../../.agents/scripts/deliver-run.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, '.agents', 'scripts', 'deliver-run.js');

const CONFIG = {
  project: { paths: { tempRoot: 'temp', docsRoot: 'docs' } },
  delivery: { deliverRunner: { concurrencyCap: 3 } },
};

/** A Story body the parser accepts, declaring one changed path. */
const bodyFor = (id, changePath) =>
  [
    '## Goal',
    `Story ${id}.`,
    '',
    '## Changes',
    `- \`${changePath}\` — refactors-existing`,
    '',
    '## Acceptance',
    '- [ ] AC-1: it works.',
    '',
    '## Verify',
    '- npm test',
  ].join('\n');

/** A probed node with live labels, shaped as live-probe.js returns them. */
const node = (id, { dependsOn = [], files = [], labels = [] } = {}) => ({
  id,
  dependsOn,
  files,
  body: bodyFor(id, files[0] ?? `lib/story-${id}.js`),
  labels,
});

/**
 * Run one beat against an injected probe result inside a temp checkout.
 *
 * The stub mirrors the one behaviour of `live-probe.js` the ledger depends on:
 * a dispatched id is projected as `agent::executing` and counted in flight,
 * which is how a Story handed out on an earlier beat stays withheld while its
 * real label is still landing.
 */
const beat = async (probed, overrides = {}, deps = {}) =>
  runDeliverRunBeat(
    {
      cwd: overrides.cwd ?? makeTempDir('deliver-run-'),
      config: CONFIG,
      context: () => ({ provider: {}, owner: 'o', repo: 'r', self: null }),
      probe: async ({ dispatched = [] }) => {
        const inFlight = new Set(dispatched);
        const base = {
          inFlightRecords: [],
          doneIds: new Set(),
          blockedIds: [],
          foreignHeld: [],
          ...probed,
        };
        const nodes = (base.nodes ?? []).map((n) =>
          inFlight.has(n.id)
            ? { ...n, labels: [...n.labels, 'agent::executing'] }
            : n,
        );
        return {
          ...base,
          nodes,
          inFlightRecords: nodes.filter((n) => inFlight.has(n.id)),
          inFlight: base.inFlight ?? inFlight.size,
        };
      },
      ...overrides,
    },
    deps,
  );

// ---------------------------------------------------------------------------
// AC-1 — one beat, one envelope
// ---------------------------------------------------------------------------

describe('deliver-run — one beat, one envelope (AC-1)', () => {
  it('lists each ready Story with its dispatch prompt path', async () => {
    const { envelope, exitCode } = await beat(
      { nodes: [node(101), node(102)] },
      { stories: '101,102' },
    );

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(envelope.kind, 'deliver-run-beat');
    assert.deepEqual(
      envelope.ready.map((r) => r.id),
      [101, 102],
    );
    for (const entry of envelope.ready) {
      assert.strictEqual(
        path.basename(entry.promptPath),
        `dispatch-${entry.id}.md`,
      );
      assert.ok(readFileSync(entry.promptPath, 'utf8').length > 0);
    }
    assert.deepEqual(envelope.stories, [101, 102]);
    assert.strictEqual(envelope.done, false);
  });

  it('reports the run done when every Story is done', async () => {
    const { envelope, exitCode } = await beat(
      {
        nodes: [node(101, { labels: ['agent::done'] })],
        doneIds: new Set([101]),
      },
      { stories: '101' },
    );

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(envelope.done, true);
    assert.deepEqual(envelope.doneStories, [101]);
    assert.deepEqual(envelope.ready, []);
  });

  it('preserves the tick exit code 2 for a dependency cycle', async () => {
    const { envelope, exitCode } = await beat(
      {
        nodes: [
          { ...node(101), dependsOn: [102] },
          { ...node(102), dependsOn: [101] },
        ],
      },
      { stories: '101,102' },
    );

    assert.strictEqual(exitCode, 2);
    assert.ok(envelope.cycleError);
  });

  it('preserves the tick exit code 3 for a wedged run', async () => {
    const { envelope, exitCode } = await beat(
      { nodes: [{ ...node(101), dependsOn: [999] }] },
      { stories: '101' },
    );

    assert.strictEqual(exitCode, 3);
    assert.ok(envelope.wedged);
  });

  it('preserves the tick exit code 4 for a blocked Story', async () => {
    const { envelope, exitCode } = await beat(
      {
        nodes: [node(101, { labels: ['agent::blocked'] })],
        blockedIds: [101],
      },
      { stories: '101' },
    );

    assert.strictEqual(exitCode, 4);
    assert.deepEqual(envelope.blocked, [101]);
    assert.ok(envelope.blockedReason);
  });

  it('reports an input error as exit 1 without ticking', async () => {
    const { envelope, exitCode } = await runDeliverRunBeat({
      stories: '',
      cwd: makeTempDir('deliver-run-'),
      config: CONFIG,
    });

    assert.strictEqual(exitCode, 1);
    assert.match(envelope.inputError, /--stories is required/);
  });
});

// ---------------------------------------------------------------------------
// AC-2 — the run ledger replaces --dispatched
// ---------------------------------------------------------------------------

describe('deliver-run — the run ledger (AC-2)', () => {
  it('withholds on a repeat beat with no --dispatched from the caller', async () => {
    const cwd = makeTempDir('deliver-run-');
    const probed = { nodes: [node(101), node(102)] };

    const first = await beat(probed, { stories: '101,102', cwd });
    assert.deepEqual(
      first.envelope.ready.map((r) => r.id),
      [101, 102],
    );

    // The second beat sees the identical live state — nothing has been
    // labelled yet, which is exactly the init window --dispatched existed to
    // close — and must still hand out nothing.
    const second = await beat(probed, { stories: '101,102', cwd });
    assert.deepEqual(second.envelope.ready, []);
    assert.strictEqual(second.exitCode, 0, 'a waiting beat is not a wedge');
  });

  it('records the handed-out ids in the ledger under the run temp dir', async () => {
    const cwd = makeTempDir('deliver-run-');
    const { envelope } = await beat(
      { nodes: [node(101), node(102)] },
      { stories: '101,102', cwd },
    );

    const ledgerPath = path.join(envelope.runTempDir, 'ledger.json');
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    assert.strictEqual(ledger.kind, 'deliver-run-ledger');
    assert.deepEqual(ledger.dispatched, [101, 102]);
    assert.deepEqual(readLedgerDispatched(ledgerPath), [101, 102]);
  });

  it('derives one stable run id per Story set', () => {
    assert.strictEqual(deriveRunId([102, 101]), deriveRunId([101, 102]));
    assert.notStrictEqual(deriveRunId([101, 102]), deriveRunId([101, 103]));
    assert.match(deriveRunId([101]), /^[0-9a-f]{8}$/);
  });

  it('treats a missing or corrupt ledger as empty rather than fatal', () => {
    const dir = makeTempDir('deliver-run-');
    assert.deepEqual(readLedgerDispatched(path.join(dir, 'nope.json')), []);
    assert.deepEqual(
      readLedgerDispatched(path.join(dir, 'bad.json'), {
        readFileFn: () => 'not json',
      }),
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// AC-3 — the dispatch prompt
// ---------------------------------------------------------------------------

describe('deliver-run — the dispatch prompt (AC-3)', () => {
  it('carries the Story id, the digest path and the change-set discipline', async () => {
    const cwd = makeTempDir('deliver-run-');
    const { envelope } = await beat(
      { nodes: [node(101, { files: ['.agents/scripts/lib/Logger.js'] })] },
      { stories: '101', cwd },
    );

    const prompt = readFileSync(envelope.ready[0].promptPath, 'utf8');
    assert.match(prompt, /Deliver Story #101/);
    assert.match(prompt, /single-story-init\.js --story 101/);
    assert.match(prompt, /ceremony-derive\.js --story 101/);
    assert.match(prompt, /prefix \*\*every\*\* path-based/);
    assert.match(prompt, /Docs digest: none/);
  });

  it('threads the checklist path the dispatch-checklist builder produced', async () => {
    const cwd = makeTempDir('deliver-run-');
    const seen = [];
    const { envelope } = await beat(
      { nodes: [node(101, { files: ['lib/api/routes.js'] })] },
      { stories: '101', cwd },
      {
        buildChecklistFn: (args) => {
          seen.push(args);
          return {
            checklistPath: path.join(args.runTempDir, 'story-101-checklist.md'),
          };
        },
      },
    );

    assert.strictEqual(seen.length, 1);
    assert.deepEqual(
      seen[0].changes.map((c) => c.path),
      ['lib/api/routes.js'],
      'the footprint comes from the Story body the probe already fetched',
    );
    const prompt = readFileSync(envelope.ready[0].promptPath, 'utf8');
    assert.match(prompt, /story-101-checklist\.md/);
  });

  it('says so plainly when nothing matched the footprint', () => {
    const prompt = renderDispatchPrompt({
      storyId: 7,
      mainRepo: '/repo',
      docsDigestPath: null,
      checklistPath: null,
    });
    assert.match(prompt, /Write-time checklist: none matched/);
  });
});

// ---------------------------------------------------------------------------
// AC-4 — the close command
// ---------------------------------------------------------------------------

describe('deliver-run — the close command (AC-4)', () => {
  it('adds --merge-watch-mode async on a multi-Story run', async () => {
    const { envelope } = await beat(
      { nodes: [node(101), node(102)] },
      { stories: '101,102', handoff: ['101'] },
    );

    assert.deepEqual(
      envelope.close.map((c) => c.id),
      [101],
    );
    assert.match(envelope.close[0].command, /single-story-close\.js/);
    assert.match(envelope.close[0].command, /--story 101/);
    assert.match(envelope.close[0].command, /--merge-watch-mode async/);
  });

  it('omits the async flag for a run of one', async () => {
    const { envelope } = await beat(
      { nodes: [node(101)] },
      { stories: '101', handoff: ['101'] },
    );

    assert.doesNotMatch(envelope.close[0].command, /merge-watch-mode/);
  });

  it('renders one close entry per --handoff', async () => {
    const { envelope } = await beat(
      { nodes: [node(101), node(102), node(103)] },
      { stories: '101,102,103', handoff: ['101', '102'] },
    );

    assert.deepEqual(
      envelope.close.map((c) => c.id),
      [101, 102],
    );
  });

  it('pins the close command at the main checkout', () => {
    const command = renderCloseCommand({
      storyId: 5,
      mainRepo: '/main/repo',
      storyCount: 1,
    });
    assert.strictEqual(
      command,
      'node /main/repo/.agents/scripts/single-story-close.js --story 5 --cwd /main/repo',
    );
  });
});

// ---------------------------------------------------------------------------
// id parsing
// ---------------------------------------------------------------------------

describe('deliver-run — id resolution', () => {
  it('expands ranges in --stories and --handoff', () => {
    const { ids, handoffIds, error } = resolveRunIds({
      stories: '101,103-105',
      handoff: ['103', '104'],
    });
    assert.strictEqual(error, null);
    assert.deepEqual(ids, [101, 103, 104, 105]);
    assert.deepEqual(handoffIds, [103, 104]);
  });

  it('refuses a backwards range rather than guessing', () => {
    const { error } = resolveRunIds({ stories: '105-101' });
    assert.match(error, /runs backwards/);
  });
});

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

describe('deliver-run — CLI', () => {
  it('prints usage for --help without ticking', () => {
    const out = spawnSync(process.execPath, [CLI, '--help'], {
      encoding: 'utf8',
    });
    assert.strictEqual(out.status, 0);
    assert.match(out.stdout, /deliver-run\.js --stories/);
    assert.match(out.stdout, /--handoff/);
    assert.match(out.stdout, /--merge-watch-mode async/);
  });

  it('exits 1 on a missing --stories', () => {
    const out = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
    assert.strictEqual(out.status, 1);
    assert.match(out.stdout, /--stories is required/);
  });
});
