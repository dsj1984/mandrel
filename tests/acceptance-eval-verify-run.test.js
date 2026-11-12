import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  assertScoringCwd,
  assertVerifyEvidence,
  runAcceptanceEval,
  runAcceptanceEvalCli,
} from '../.agents/scripts/acceptance-eval.js';
import {
  computeVerdictFingerprint,
  scoreVerifyRuns,
} from '../.agents/scripts/lib/orchestration/acceptance-eval-decision.js';
import {
  classifyVerifyEntries,
  extractTestPaths,
  normalizeVerifyCommand,
  runScopedVerifyEntry,
} from '../.agents/scripts/lib/orchestration/verify-credit.js';

const SCOPED = 'node --test tests/a.test.js';
const config = { delivery: { acceptanceEval: { maxRounds: 2 } } };

const verdictCiting = (evidence = [{ command: SCOPED, outcome: 'pass' }]) => ({
  storyId: 6067,
  schemaVersion: 1,
  round: 1,
  criteria: [
    {
      index: 0,
      criterion: 'AC-1',
      verdict: 'met',
      evidence: 'a.test.js passes',
      verifyEvidence: evidence,
    },
  ],
});

const run = (outcome, extra = {}) => ({
  command: SCOPED,
  exitCode: outcome === 'pass' ? 0 : 1,
  outcome,
  deadPaths: [],
  ...extra,
});

function cli({ verdict, verify = [SCOPED], runEntry, appended = [] }) {
  const infos = [];
  return {
    infos,
    appended,
    deps: {
      readFileSyncImpl: () => JSON.stringify(verdict),
      resolveConfigImpl: () => config,
      readAcceptanceCountImpl: async () => verdict.criteria.length,
      readVerifyImpl: async () => verify,
      readHeadImpl: () => 'abc1234',
      runEntryImpl: runEntry ?? ((command) => run('pass', { command })),
      runAcceptanceEvalImpl: (args) =>
        runAcceptanceEval(args, {
          appendSignalFn: async ({ signal }) => {
            appended.push(signal);
            return true;
          },
          resolveRoundFn: () => ({ round: 1, replay: false }),
        }),
      logger: { info: (m) => infos.push(m), warn: () => {} },
    },
  };
}

const ARGV = ['--story', '6067', '--verdict', 'v.json', '--cwd', '/wt'];

describe('verify[] normalisation and classification', () => {
  it('strips tier tags and backticks and collapses whitespace', () => {
    assert.equal(
      normalizeVerifyCommand('`node  --test   tests/a.test.js` (unit)'),
      SCOPED,
    );
  });

  it('AC-5: requires full-suite entries as evidence but never runs them; manual entries are neither', () => {
    assert.deepEqual(
      classifyVerifyEntries(['npm test', SCOPED, 'manual: eyeball it']),
      { required: ['npm test', SCOPED], scoped: [SCOPED] },
    );
    assert.deepEqual(classifyVerifyEntries(undefined), {
      required: [],
      scoped: [],
    });
  });
});

describe('verdict evidence shape checks (no round)', () => {
  it('AC-1: names a scoped entry no criterion cites', () => {
    assert.throws(
      () => assertVerifyEvidence(verdictCiting([]), [SCOPED]),
      /no criterion's verifyEvidence cites: `node --test tests\/a\.test\.js`.*No round was consumed/,
    );
  });

  it('AC-2: refuses met over a failing item without a waiver, accepts it with one', () => {
    const failing = { command: SCOPED, outcome: 'fail' };
    assert.throws(
      () => assertVerifyEvidence(verdictCiting([failing]), [SCOPED]),
      /met criteria at index 0 carry non-pass verifyEvidence with no waiver/,
    );
    assert.doesNotThrow(() =>
      assertVerifyEvidence(
        verdictCiting([{ ...failing, waiver: 'flaky upstream' }]),
        [SCOPED],
      ),
    );
  });

  it('AC-6: scoped entries without --cwd are a usage error', () => {
    assert.throws(() => assertScoringCwd([SCOPED], null), /^Error: Usage:/);
    assert.doesNotThrow(() => assertScoringCwd([], null));
  });
});

describe('the gate runs scoped entries itself', () => {
  it('AC-4: a dead node --test path fails the entry unspawned', () => {
    const spawned = [];
    const result = runScopedVerifyEntry(
      'node --test --test-reporter spec tests/live.test.js tests/dead.test.js',
      { cwd: '/wt' },
      {
        globImpl: (p) => (p.includes('live') ? 1 : 0),
        spawnImpl: (c) => spawned.push(c),
      },
    );
    assert.equal(result.outcome, 'fail');
    assert.deepEqual(result.deadPaths, ['tests/dead.test.js']);
    assert.deepEqual(spawned, []);
  });

  it('AC-4: a vitest entry counts listed files, not the lister exit code', () => {
    const listed = [];
    const deps = {
      listVitestImpl: (p) => {
        listed.push(p);
        return p === 'src/dead' ? 0 : 2;
      },
      spawnImpl: () => 0,
    };
    const dead = runScopedVerifyEntry(
      'npx vitest run src/live src/dead',
      { cwd: '/wt' },
      deps,
    );
    assert.deepEqual(dead.deadPaths, ['src/dead']);
    assert.equal(dead.outcome, 'fail');
    const live = runScopedVerifyEntry(
      'pnpm vitest run --config v.config.ts src/live',
      { cwd: '/wt' },
      deps,
    );
    assert.deepEqual(live, {
      command: 'pnpm vitest run --config v.config.ts src/live',
      exitCode: 0,
      outcome: 'pass',
      deadPaths: [],
    });
    assert.deepEqual(listed, ['src/live', 'src/dead', 'src/live']);
  });

  it('probes only simple vitest / node --test shapes', () => {
    assert.deepEqual(extractTestPaths("npm exec vitest run 'a.test.ts' b"), {
      runner: 'vitest',
      paths: ['a.test.ts', 'b'],
    });
    assert.equal(extractTestPaths('node --test a.js && echo hi'), null);
    assert.equal(extractTestPaths('npm run sync:commands'), null);
    assert.equal(extractTestPaths('npm vitest run x'), null);
  });

  it('spawns for real in cwd and records the exit code; real globs count files', () => {
    const cwd = process.cwd();
    const live = runScopedVerifyEntry(
      'node --test tests/acceptance-eval-verify-run.test.js',
      { cwd },
      { spawnImpl: () => 0 },
    );
    assert.deepEqual(live.deadPaths, []);
    const failed = runScopedVerifyEntry('node -e "process.exitCode = 3"', {
      cwd,
    });
    assert.equal(failed.exitCode, 3);
    assert.equal(failed.outcome, 'fail');
  });
});

describe('real outcomes fold into the decision', () => {
  it('AC-3: a failing cited run scores the criterion unmet → redraft, then block at the cap', async () => {
    const verdict = verdictCiting();
    const args = { storyId: 6067, verdict, config, emitSignal: false };
    const below = await runAcceptanceEval(
      { ...args, round: 1, verifyRuns: [run('fail')] },
      { resolveRoundFn: () => ({ round: 1, replay: false }) },
    );
    assert.equal(below.envelope.decision, 'redraft');
    assert.match(below.envelope.unmetCriteria[0].evidence, /exited 1/);
    const atCap = await runAcceptanceEval(
      { ...args, round: 2, verifyRuns: [run('fail')] },
      { resolveRoundFn: () => ({ round: 2, replay: false }) },
    );
    assert.equal(atCap.envelope.decision, 'block');
    assert.equal(atCap.exitCode, 1);
  });

  it('AC-2: a waiver lets met stand over a failing run and marks it waived', () => {
    const scored = scoreVerifyRuns(
      verdictCiting([{ command: SCOPED, outcome: 'fail', waiver: 'known' }]),
      [run('fail')],
    );
    assert.equal(scored.criteria[0].verdict, 'met');
    assert.equal(scored.verifyRuns[0].waived, true);
  });

  it('AC-4: the envelope names the dead path', async () => {
    const { envelope } = await runAcceptanceEval(
      {
        storyId: 6067,
        verdict: verdictCiting(),
        config,
        emitSignal: false,
        round: 1,
        verifyRuns: [run('fail', { exitCode: null, deadPaths: ['x.js'] })],
      },
      { resolveRoundFn: () => ({ round: 1, replay: false }) },
    );
    assert.deepEqual(envelope.verifyRuns[0].deadPaths, ['x.js']);
    assert.match(envelope.unmetCriteria[0].evidence, /no test file at x\.js/);
  });

  it('AC-7: changed real outcomes or HEAD change the round fingerprint', () => {
    const verdict = verdictCiting();
    const red = computeVerdictFingerprint(verdict, {
      verifyRuns: [run('fail')],
      headSha: 'aaa1111',
    });
    const green = computeVerdictFingerprint(verdict, {
      verifyRuns: [run('pass')],
      headSha: 'aaa1111',
    });
    const moved = computeVerdictFingerprint(verdict, {
      verifyRuns: [run('fail')],
      headSha: 'bbb2222',
    });
    assert.equal(new Set([red, green, moved]).size, 3);
    assert.equal(
      computeVerdictFingerprint(verdict, {}),
      computeVerdictFingerprint(verdict),
    );
  });
});

describe('the scoring CLI', () => {
  it('AC-1: refuses an unevidenced scoped entry, recording no round', async () => {
    const h = cli({ verdict: verdictCiting([]) });
    await assert.rejects(
      () => runAcceptanceEvalCli(ARGV, h.deps),
      /no criterion's verifyEvidence cites/,
    );
    assert.deepEqual(h.appended, []);
  });

  it('AC-6: refuses scoring without --cwd, recording no round', async () => {
    const h = cli({ verdict: verdictCiting() });
    await assert.rejects(
      () => runAcceptanceEvalCli(ARGV.slice(0, 4), h.deps),
      /Usage: .*pass --cwd <workCwd>/,
    );
    assert.deepEqual(h.appended, []);
  });

  it('AC-5: a full-suite-only Story needs no --cwd and spawns nothing', async () => {
    const h = cli({
      verdict: verdictCiting([{ command: 'npm test', outcome: 'pass' }]),
      verify: ['npm test'],
      runEntry: () => assert.fail('a full-suite entry was spawned'),
    });
    const envelope = await runAcceptanceEvalCli(ARGV.slice(0, 4), h.deps);
    assert.equal(envelope.decision, 'proceed');
    assert.deepEqual(envelope.verifyRuns, []);
  });

  it('AC-3: runs the scoped entry in --cwd and redrafts on its failure', async () => {
    const seen = [];
    const h = cli({
      verdict: verdictCiting(),
      runEntry: (command, ctx) => {
        seen.push([command, ctx.cwd]);
        return run('fail');
      },
    });
    const envelope = await runAcceptanceEvalCli(ARGV, h.deps);
    assert.deepEqual(seen, [[SCOPED, path.resolve('/wt')]]);
    assert.equal(envelope.decision, 'redraft');
    assert.equal(h.appended.length, 1);
  });
});
