import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { runPlanRunEpilogue } from '../.agents/scripts/lib/orchestration/run-epilogue.js';
import { main } from '../.agents/scripts/plan-run-epilogue.js';

/**
 * Story #4780 — `main` scored CRAP 39.6: the per-run closeout's id parsing,
 * its synthesized `adhoc-<ids>` run id, and both loud operator warnings (the
 * unresolvable landed diff and the suspiciously-empty friction roll-up) were
 * unreached.
 *
 * Config, provider, epilogue engine and log sink are injected through the
 * optional final `deps` parameter (`.agents/rules/test-seams.md` rules 1 and
 * 5) — no GitHub call, no module mocking.
 */

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
});

function harness(result = { results: [] }) {
  const info = [];
  const warn = [];
  const calls = [];
  return {
    info,
    warn,
    calls,
    deps: {
      resolveConfigImpl: (args) => ({ resolvedFor: args.cwd }),
      createProviderImpl: (config) => ({ providerFor: config.resolvedFor }),
      runPlanRunEpilogueImpl: async (args) => {
        calls.push(args);
        return result;
      },
      logger: { info: (m) => info.push(m), warn: (m) => warn.push(m) },
    },
  };
}

describe('plan-run-epilogue main', () => {
  it('refuses an invocation with no --stories', async () => {
    for (const argv of [[], ['--stories', '   ']]) {
      await assert.rejects(
        () => main(argv, harness().deps),
        /Usage: node plan-run-epilogue\.js --stories 1,2,3/,
      );
    }
  });

  it('synthesizes a sorted adhoc run id from the delivered ids', async () => {
    const h = harness();
    await main(['--stories', '30,4,12'], h.deps);
    assert.equal(h.calls[0].planRunId, 'adhoc-4-12-30');
    assert.deepEqual(h.calls[0].stories, [30, 4, 12]);
  });

  // Tightened deliberately, not loosened: this used to silently DROP a bad
  // token, which turned a typo into an epilogue keyed on the wrong id set and
  // an empty roll-up that reads like a clean run. Every sibling id parser
  // fails loud, and now so does this one.
  it('refuses a non-integer or non-positive id rather than dropping it', async () => {
    for (const bad of ['5, abc , 7', '5,0', '5,-2']) {
      await assert.rejects(
        () => main(['--stories', bad], harness().deps),
        /\[plan-run-epilogue\] --stories/,
      );
    }
  });

  it('expands a dash range into the delivered id set', async () => {
    const h = harness();
    await main(['--stories', '12,30-32'], h.deps);
    assert.deepEqual(h.calls[0].stories, [12, 30, 31, 32]);
    assert.equal(h.calls[0].planRunId, 'adhoc-12-30-31-32');
  });

  // Story #5343 — the audit roster is the one epilogue step that spends the
  // host's sub-agent budget and asks the operator to act. A default run must
  // therefore not enumerate it, and the flag is the only thing that does.
  it('leaves the audit roster off unless --audit-roster is passed', async () => {
    const off = harness();
    await main(['--stories', '1,2'], off.deps);
    assert.equal(off.calls[0].auditRoster, false);

    const on = harness();
    await main(['--stories', '1,2', '--audit-roster'], on.deps);
    assert.equal(on.calls[0].auditRoster, true);
  });

  it('defaults cwd to the process cwd and threads --cwd when given', async () => {
    const bare = harness();
    await main(['--stories', '1'], bare.deps);
    assert.equal(bare.calls[0].cwd, process.cwd());

    const explicit = harness();
    await main(['--stories', '1', '--cwd', '  /repo  '], explicit.deps);
    assert.equal(explicit.calls[0].cwd, '/repo');
    assert.deepEqual(explicit.calls[0].config, { resolvedFor: '/repo' });
    assert.deepEqual(explicit.calls[0].provider, { providerFor: '/repo' });
  });

  it('prints the envelope as a single JSON line and leaves the exit code alone', async () => {
    const h = harness({ results: [], ok: true });
    const result = await main(['--stories', '1'], h.deps);
    assert.deepEqual(JSON.parse(h.info[0]), result);
    assert.equal(process.exitCode, originalExitCode);
  });

  it('sets a non-zero exit code when the epilogue reports errors', async () => {
    const h = harness({ results: [], errors: ['boom'] });
    await main(['--stories', '1'], h.deps);
    assert.equal(process.exitCode, 1);
  });

  it('warns loudly when the combined landed diff could not be resolved', async () => {
    const h = harness({
      results: [
        {
          kind: 'audit-roster',
          baseResolution: {
            resolved: false,
            baseRef: 'main',
            reason: 'no merge base',
          },
        },
      ],
    });
    await main(['--stories', '1'], h.deps);
    assert.match(h.warn[0], /Combined landed diff unavailable/);
    assert.match(h.warn[0], /changedFiles is null \(NOT an empty set\)/);
  });

  it('stays quiet when the base resolved', async () => {
    const h = harness({
      results: [{ kind: 'audit-roster', baseResolution: { resolved: true } }],
    });
    await main(['--stories', '1'], h.deps);
    assert.deepEqual(h.warn, []);
  });

  it('warns loudly on a zero-signal roll-up over a multi-Story run', async () => {
    const h = harness({
      results: [
        { kind: 'follow-up-rollup', emptyRollupSuspect: true, storyCount: 7 },
      ],
    });
    await main(['--stories', '1,2'], h.deps);
    assert.match(h.warn[0], /0 friction signals across 7 Stories/);
    assert.match(h.warn[0], /An empty roll-up is NOT evidence of a clean run/);
  });

  it('stays quiet when the roll-up is not suspect', async () => {
    const h = harness({
      results: [
        { kind: 'follow-up-rollup', emptyRollupSuspect: false, storyCount: 2 },
      ],
    });
    await main(['--stories', '1,2'], h.deps);
    assert.deepEqual(h.warn, []);
  });

  it('tolerates an envelope with no results array at all', async () => {
    const h = harness({});
    await main(['--stories', '1'], h.deps);
    assert.deepEqual(h.warn, []);
    assert.equal(h.info.length, 1);
  });
});

/**
 * Story #4949 — the roster comment names the lenses; before this it said
 * nothing about how to dispatch them, so a serial walk (or a coordinator
 * sub-agent that re-dispatched them as grandchildren) was fully compliant
 * with it. Lenses are read-only and share no write paths — the textbook
 * independent fan-out — and grandchild routing is measured-lossy, so the shape
 * is a MUST rather than a suggestion. This pins the wording: the instruction
 * lives in a GitHub comment body, which has no other gate over it.
 */
describe('audit-roster — the emitted dispatch instruction (Story #4949 AC-4)', () => {
  const US = String.fromCharCode(31);

  /** A run whose two Stories landed as squash-merges on `origin/main`. */
  const landedRunGit = {
    gitSpawn: (_cwd, ...args) => {
      if (args[0] === 'log') {
        return {
          status: 0,
          stdout: [
            `ccc${US}bbb${US}fix: second (#2)`,
            `bbb${US}aaa${US}feat: first (#1)`,
            `aaa${US}${US}chore: pre-run base`,
          ].join('\n'),
          stderr: '',
        };
      }
      if (args[0] === 'diff') {
        return { status: 0, stdout: 'lib/a.js\nlib/b.js\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };

  async function rosterBody(selectedAudits) {
    const comments = [];
    await runPlanRunEpilogue({
      planRunId: 'run-4949',
      stories: [1, 2],
      // Story #5343 — the roster is opt-in; this suite is about what the
      // comment SAYS once the operator has asked for it.
      auditRoster: true,
      provider: {
        getTicket: async (id) => ({
          id,
          title: `Story ${id}`,
          body: '',
          labels: ['type::story'],
        }),
        getTicketComments: async () => [],
        postComment: async (ticketId, payload) => {
          comments.push({ ticketId, body: payload.body });
          return { commentId: comments.length };
        },
        deleteComment: async () => {},
      },
      git: landedRunGit,
      selectAuditsFn: async () => ({ selectedAudits }),
    });
    return comments.find((c) => c.body.includes('plan-run-audit-roster')).body;
  }

  it('mandates one auditor sub-agent per lens, dispatched flat in a single turn', async () => {
    const body = await rosterBody(['audit-clean-code', 'audit-performance']);
    assert.match(
      body,
      /\*\*Dispatch shape \(MUST\): flat, parallel, one turn\.\*\*/,
    );
    assert.match(body, /one `auditor` sub-agent per lens/);
    assert.match(body, /in a SINGLE turn/);
    assert.match(
      body,
      /no nested fan-out/,
      'a coordinator that re-dispatches the lenses as grandchildren loses findings',
    );
    assert.match(body, /no serial walk/);
  });

  it('emits the instruction even when the roster selected no lenses', async () => {
    // A roster is not always non-empty, and the dispatch contract must not be
    // conditional on the count — a lens added on the next run would otherwise
    // inherit an instruction-free comment.
    const body = await rosterBody([]);
    assert.match(body, /Dispatch shape \(MUST\)/);
    assert.match(
      body,
      /_\(none — docs-only or no matching change-set lenses\)_/,
    );
  });
});
