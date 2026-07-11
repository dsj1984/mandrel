/**
 * tests/lib/retro-proposals-graduator.test.js — Story #4418 / Epic #4406.
 *
 * Pins the retro auto-filer contract: the retro's actionable routed
 * proposals are filed (default ON) as `meta::<framework-gap|
 * consumer-improvement>` + `friction::<category>` issues via the graduator
 * pre-parsed-findings seam, before the retro body composes; a re-run files
 * nothing (idempotency marker probe); the `delivery.feedbackLoop.retroProposals`
 * toggle validates against the runtime AJV schema; the toggle-OFF path falls
 * back to command stanzas; the rendered body lists filed issue references;
 * and the per-run filing cap is respected.
 *
 * All gh/git child processes are stubbed via the `spawnImpl` seam and the
 * provider is a stub — no real network, git, or filesystem access.
 */

import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig } from '../../.agents/scripts/lib/config-resolver.js';
import { getAgentrcValidator } from '../../.agents/scripts/lib/config-settings-schema.js';
import {
  enrichRoutedProposalsWithFilings,
  fileRetroProposals,
  graduateRetroProposals,
  isAutoFileEnabled,
  issueNumberFromUrl,
} from '../../.agents/scripts/lib/feedback-loop/retro-proposals-graduator.js';
import { composeRetroBody } from '../../.agents/scripts/lib/orchestration/retro/phases/compose-body.js';

/**
 * Route a spawn by command / first args to a responder. `gh search` returns
 * the set of previously-created markers (so idempotency re-probes hit), and
 * `gh issue create` records the marker embedded in the `--body` arg and
 * returns a fresh issue URL. `git` is never expected (path-less findings).
 */
function makeSpawnStub() {
  const calls = [];
  const filedMarkers = new Set();
  let nextIssue = 100;
  const fn = function spawnImpl(cmd, args) {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let result = { stdout: '', code: 0 };
    if (cmd !== 'gh') {
      // A `git cat-file` probe would be a contract violation for path-less
      // findings; surface it by returning non-zero so any accidental probe
      // trips the assertions below.
      result = { stdout: '', code: 1 };
    } else if (args[0] === 'search') {
      const marker = args[2];
      result = {
        stdout: filedMarkers.has(marker) ? '[{"number":1}]' : '[]',
        code: 0,
      };
    } else if (args[0] === 'issue' && args[1] === 'create') {
      const bodyIdx = args.indexOf('--body');
      const body = bodyIdx >= 0 ? args[bodyIdx + 1] : '';
      const m = body.match(/<!-- retro-proposal-followup:[^>]+-->/);
      if (m) filedMarkers.add(m[0]);
      const num = nextIssue++;
      result = { stdout: `https://github.com/o/r/issues/${num}`, code: 0 };
    }
    queueMicrotask(() => {
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
      child.emit('close', result.code ?? 0);
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

/** Minimal provider stub — the pre-parsed seam never reads comments. */
function makeProvider() {
  const posted = [];
  return {
    getTicketComments: async () => [],
    postComment: async (ticketId, { type, body }) => {
      posted.push({ ticketId, type, body });
      return { id: posted.length };
    },
    posted,
  };
}

/** Two actionable routed proposals — one framework, one consumer. */
function makeRoutedProposals() {
  return {
    framework: [
      {
        category: 'lint-loop',
        occurrences: 3,
        source: 'framework',
        title: 'Friction: lint-loop recurred 3 times in Epic #4406',
        body: 'Recurring friction category "lint-loop" surfaced 3 times.',
        command: 'gh issue create --repo o/r --title "lint-loop" ...',
      },
    ],
    consumer: [
      {
        category: 'flaky-setup',
        occurrences: 2,
        source: 'consumer',
        title: 'Friction: flaky-setup recurred 2 times in Epic #4406',
        body: 'Recurring friction category "flaky-setup" surfaced 2 times.',
        command: 'gh issue create --repo o/r --title "flaky-setup" ...',
      },
    ],
    discarded: [],
  };
}

const REPO = { owner: 'o', repo: 'r' };

describe('AC1 — default-ON files actionable proposals via the pre-parsed seam', () => {
  it('files two issues with meta::* + friction::<category> labels, and re-run files nothing', async () => {
    assert.equal(
      isAutoFileEnabled(undefined),
      true,
      'toggle defaults to ON when unset',
    );

    const spawnImpl = makeSpawnStub();
    const provider = makeProvider();
    const routedProposals = makeRoutedProposals();

    const first = await graduateRetroProposals({
      epicId: 4406,
      provider,
      config: {},
      currentRepo: REPO,
      frameworkRepo: REPO,
      routedProposals,
      spawnImpl,
    });

    assert.equal(first.errors.length, 0, `no errors: ${first.errors}`);
    assert.equal(first.filed.length, 2, 'both actionable proposals filed');

    const createCalls = spawnImpl.calls.filter(
      (c) => c.cmd === 'gh' && c.args[0] === 'issue' && c.args[1] === 'create',
    );
    assert.equal(createCalls.length, 2, 'two gh issue create invocations');

    // No git cat-file path probe for path-less findings.
    assert.ok(
      !spawnImpl.calls.some((c) => c.cmd === 'git'),
      'path-less findings must not invoke a git path probe',
    );

    const labelsFor = (cat) => {
      const call = createCalls.find((c) =>
        c.args.some((a) => a === `friction::${cat}`),
      );
      assert.ok(call, `a create call carries friction::${cat}`);
      const labels = [];
      for (let i = 0; i < call.args.length; i += 1) {
        if (call.args[i] === '--label') labels.push(call.args[i + 1]);
      }
      return labels;
    };
    assert.deepEqual(labelsFor('lint-loop'), [
      'meta::framework-gap',
      'friction::lint-loop',
    ]);
    assert.deepEqual(labelsFor('flaky-setup'), [
      'meta::consumer-improvement',
      'friction::flaky-setup',
    ]);

    // Re-run against the SAME spawn stub (markers now present) files nothing.
    const second = await graduateRetroProposals({
      epicId: 4406,
      provider,
      config: {},
      currentRepo: REPO,
      frameworkRepo: REPO,
      routedProposals,
      spawnImpl,
    });
    assert.equal(second.filed.length, 0, 're-run files nothing (idempotent)');
    assert.equal(
      second.skipped.filter((s) => s.reason === 'already-filed').length,
      2,
      'both proposals skip as already-filed on re-run',
    );
  });
});

describe('AC2 — toggle OFF suppresses filing and falls back to command stanzas', () => {
  it('files no issue and leaves the routed proposals unenriched', async () => {
    const spawnImpl = makeSpawnStub();
    const provider = makeProvider();
    const routedProposals = makeRoutedProposals();
    const config = { delivery: { feedbackLoop: { retroProposals: false } } };

    assert.equal(isAutoFileEnabled(config), false);

    const { routedProposals: out, summary } = await fileRetroProposals({
      epicId: 4406,
      provider,
      config,
      frameworkRepo: 'o/r',
      consumerRepo: 'o/r',
      routedProposals,
      spawnImpl,
    });

    assert.equal(
      spawnImpl.calls.length,
      0,
      'no gh/git spawn when the toggle is OFF',
    );
    assert.equal(summary.filed.length, 0);
    assert.equal(out, routedProposals, 'proposals pass through unchanged');

    // The rendered body falls back to the command stanza.
    const { body } = composeRetroBody({
      epicId: 4406,
      counts: { friction: 5, parked: 0, recuts: 0, hitl: 0 },
      routedProposals: out,
    });
    assert.ok(
      body.includes('```sh'),
      'toggle-OFF body renders the paste-ready gh command stanza',
    );
    assert.ok(
      !body.includes('Filed: ['),
      'toggle-OFF body carries no filed-issue reference',
    );
  });
});

describe('AC3 — the config key validates against the runtime AJV schema', () => {
  it('getAgentrcValidator accepts delivery.feedbackLoop.retroProposals', () => {
    const validate = getAgentrcValidator();
    const ok = validate({
      project: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      },
      delivery: { feedbackLoop: { retroProposals: false } },
    });
    assert.equal(ok, true, `schema errors: ${JSON.stringify(validate.errors)}`);
  });

  it('resolveConfig accepts the key from an injected .agentrc.json without a schema error', () => {
    const agentrc = JSON.stringify({
      project: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      },
      delivery: { feedbackLoop: { retroProposals: true } },
    });
    // Derive the expected path exactly as resolveConfig does — it calls
    // path.resolve(cwd) then path.join(root, '.agentrc.json'). Keying the stub
    // off a hard-coded '/'-separated literal only matches on POSIX; on Windows
    // resolveConfig produces `<drive>:\virtual\project\.agentrc.json`, so the
    // literal never matched and config fell back to defaults (no `delivery`),
    // making resolved.raw.delivery throw. Compute the path the same way here.
    const root = path.resolve('/virtual/project');
    const agentrcPath = path.join(root, '.agentrc.json');
    const fsStub = {
      existsSync: (p) => p === agentrcPath,
      readFileSync: (p) => (p === agentrcPath ? agentrc : '{}'),
    };
    const resolved = resolveConfig({
      cwd: root,
      bustCache: true,
      ctx: { fs: fsStub },
    });
    assert.equal(
      resolved.raw.delivery.feedbackLoop.retroProposals,
      true,
      'the key survives resolution',
    );
  });
});

describe('AC4 — rendered body lists filed issue references and the cap is respected', () => {
  it('renders the filed issue number in place of the command stanza', async () => {
    const spawnImpl = makeSpawnStub();
    const provider = makeProvider();
    const routedProposals = makeRoutedProposals();

    const { routedProposals: enriched, summary } = await fileRetroProposals({
      epicId: 4406,
      provider,
      config: {},
      frameworkRepo: 'o/r',
      consumerRepo: 'o/r',
      routedProposals,
      spawnImpl,
    });
    assert.equal(summary.filed.length, 2);

    const { body } = composeRetroBody({
      epicId: 4406,
      counts: { friction: 5, parked: 0, recuts: 0, hitl: 0 },
      routedProposals: enriched,
    });
    assert.match(
      body,
      /Filed: \[#\d+\]\(https:\/\/github\.com\/o\/r\/issues\/\d+\)/,
    );
    assert.ok(
      !body.includes('```sh'),
      'a fully-filed retro renders no leftover command stanza',
    );
  });

  it('stops filing at maxFilingsPerRun and records the excess as cap-reached', async () => {
    const spawnImpl = makeSpawnStub();
    const provider = makeProvider();
    const routedProposals = {
      framework: [
        mkItem('a', 'framework'),
        mkItem('b', 'framework'),
        mkItem('c', 'framework'),
      ],
      consumer: [mkItem('d', 'consumer')],
      discarded: [],
    };

    const res = await graduateRetroProposals({
      epicId: 4406,
      provider,
      config: {},
      currentRepo: REPO,
      frameworkRepo: REPO,
      routedProposals,
      spawnImpl,
      maxFilingsPerRun: 2,
    });
    assert.equal(
      res.filed.length,
      2,
      'cap bounds total filings across buckets',
    );
    assert.equal(
      res.skipped.filter((s) => s.reason === 'cap-reached').length,
      2,
      'the two over-cap proposals record cap-reached',
    );
  });
});

describe('unit helpers', () => {
  it('issueNumberFromUrl extracts the trailing issue number', () => {
    assert.equal(
      issueNumberFromUrl('https://github.com/o/r/issues/4420'),
      4420,
    );
    assert.equal(issueNumberFromUrl('no-number'), null);
    assert.equal(issueNumberFromUrl(null), null);
  });

  it('enrichRoutedProposalsWithFilings attaches filedIssue by source+category', () => {
    const routed = makeRoutedProposals();
    const filed = [
      {
        source: 'framework',
        category: 'lint-loop',
        url: 'https://github.com/o/r/issues/200',
      },
    ];
    const out = enrichRoutedProposalsWithFilings(routed, filed);
    assert.deepEqual(out.framework[0].filedIssue, {
      url: 'https://github.com/o/r/issues/200',
      number: 200,
    });
    assert.equal(
      out.consumer[0].filedIssue,
      undefined,
      'an unmatched proposal is left unenriched',
    );
  });
});

/** Helper: a minimal actionable routed item. */
function mkItem(category, source) {
  return {
    category,
    occurrences: 2,
    source,
    title: `Friction: ${category}`,
    body: `body for ${category}`,
    command: `gh issue create --title "${category}"`,
  };
}
