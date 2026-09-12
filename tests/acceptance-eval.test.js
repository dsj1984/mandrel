import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertCriteriaCoverage,
  collectFullSuiteVerifyCommands,
  readStoryAcceptanceCount,
  reconcileExpectedCriteria,
  resolveExpectedCriteria,
  runAcceptanceEval,
  runAcceptanceEvalCli,
  validateVerdict,
} from '../.agents/scripts/acceptance-eval.js';
import { runCoverageCapture } from '../.agents/scripts/coverage-capture.js';
import {
  computeVerdictFingerprint,
  resolveAcceptanceEvalRound,
} from '../.agents/scripts/lib/orchestration/acceptance-eval-decision.js';
import {
  isFullSuiteCommand,
  parseVerifyEntry,
  planVerifyExecution,
  resolveVerifyCredit,
} from '../.agents/scripts/lib/orchestration/verify-credit.js';

/**
 * Story #4780 — `main` scored CRAP 69.1: the gate's whole error table
 * (missing flags, unreadable verdict, non-JSON verdict, storyId mismatch,
 * block) was unreached, on the CLI that decides whether a Story may close.
 *
 * The verdict reader, config resolver, decision core, and log sink are
 * injected through the optional final `deps` parameter
 * (`.agents/rules/test-seams.md` rules 1 and 5) — no file is written, no
 * signal is appended, and nothing is module-mocked.
 */

const verdictFixture = (overrides = {}) => ({
  storyId: 4780,
  schemaVersion: 1,
  round: 1,
  criteria: [
    {
      index: 0,
      criterion: 'AC-1 holds',
      verdict: 'met',
      evidence: 'npm test exits 0',
    },
  ],
  ...overrides,
});

function harness({ verdict = verdictFixture(), envelope, exitCode = 0 } = {}) {
  const infos = [];
  const seen = [];
  return {
    infos,
    seen,
    deps: {
      readFileSyncImpl: () => JSON.stringify(verdict),
      resolveConfigImpl: () => ({
        delivery: { acceptanceEval: { maxRounds: 2 } },
      }),
      // Story #5313: the gate reads the acceptance[] count off the Story
      // body; the harness stands in a host with no readable ticket unless a
      // test overrides it.
      readAcceptanceCountImpl: async () => null,
      validateVerdictImpl: (v) => v,
      runAcceptanceEvalImpl: async (args) => {
        seen.push(args);
        return {
          envelope: envelope ?? {
            storyId: args.storyId,
            decision: 'proceed',
            round: 1,
            cap: 2,
            unmetCriteria: [],
          },
          exitCode,
        };
      },
      logger: { info: (m) => infos.push(m) },
    },
  };
}

describe('validateVerdict', () => {
  it('returns the same reference for a well-formed verdict', () => {
    const verdict = verdictFixture();
    assert.equal(validateVerdict(verdict), verdict);
  });

  it('throws a detailed schema error for a malformed verdict', () => {
    assert.throws(
      () => validateVerdict({ storyId: 'not-a-number' }),
      /verdict failed schema validation/,
    );
  });

  it('reads the schema through the injected io seam', () => {
    assert.throws(
      () =>
        validateVerdict(verdictFixture(), {
          schemaPath: '/fake/schema.json',
          io: { readFileSync: () => JSON.stringify({ type: 'string' }) },
        }),
      /verdict failed schema validation/,
    );
  });

  it('does not memoise the compiled validator across differing schemas', () => {
    // A module-level cache would make this second call reuse the first
    // schema and pass — the regression guard for test-seams rule 3.
    validateVerdict(verdictFixture());
    assert.throws(
      () =>
        validateVerdict(verdictFixture(), {
          schemaPath: '/fake/schema.json',
          io: { readFileSync: () => JSON.stringify({ type: 'array' }) },
        }),
      /verdict failed schema validation/,
    );
  });
});

describe('runAcceptanceEvalCli', () => {
  it('refuses a missing or non-numeric --story', async () => {
    for (const argv of [
      ['--verdict', 'v.json'],
      ['--story', 'x', '--verdict', 'v.json'],
    ]) {
      await assert.rejects(
        () => runAcceptanceEvalCli(argv, harness().deps),
        /Usage: node acceptance-eval\.js --story <id> --verdict <path>/,
      );
    }
  });

  it('refuses a missing --verdict', async () => {
    await assert.rejects(
      () => runAcceptanceEvalCli(['--story', '4780'], harness().deps),
      /--verdict <path> is required/,
    );
  });

  it('names the unreadable verdict file', async () => {
    const h = harness();
    h.deps.readFileSyncImpl = () => {
      throw new Error('ENOENT: no such file');
    };
    await assert.rejects(
      () =>
        runAcceptanceEvalCli(
          ['--story', '4780', '--verdict', 'v.json'],
          h.deps,
        ),
      /cannot read verdict file at v\.json: ENOENT/,
    );
  });

  it('names a verdict file that is not valid JSON', async () => {
    const h = harness();
    h.deps.readFileSyncImpl = () => '{ not json';
    await assert.rejects(
      () =>
        runAcceptanceEvalCli(
          ['--story', '4780', '--verdict', 'v.json'],
          h.deps,
        ),
      /verdict file is not valid JSON/,
    );
  });

  it('refuses a verdict whose embedded storyId disagrees with --story', async () => {
    const h = harness({ verdict: verdictFixture({ storyId: 1234 }) });
    await assert.rejects(
      () =>
        runAcceptanceEvalCli(
          ['--story', '4780', '--verdict', 'v.json'],
          h.deps,
        ),
      /verdict storyId \(1234\) does not match --story 4780/,
    );
  });

  it('tolerates a verdict with no embedded storyId', async () => {
    const h = harness({ verdict: verdictFixture({ storyId: undefined }) });
    const envelope = await runAcceptanceEvalCli(
      ['--story', '4780', '--verdict', 'v.json'],
      h.deps,
    );
    assert.equal(envelope.decision, 'proceed');
  });

  it('prints the envelope as one JSON line and returns it on proceed', async () => {
    const h = harness();
    const envelope = await runAcceptanceEvalCli(
      ['--story', '4780', '--verdict', 'v.json'],
      h.deps,
    );
    assert.equal(h.infos.length, 1);
    assert.deepEqual(JSON.parse(h.infos[0]), envelope);
    assert.equal(h.seen[0].emitSignal, true);
  });

  it('suppresses the signal emit under --no-signal', async () => {
    const h = harness();
    await runAcceptanceEvalCli(
      ['--story', '4780', '--verdict', 'v.json', '--no-signal'],
      h.deps,
    );
    assert.equal(h.seen[0].emitSignal, false);
  });

  it('throws naming every unmet criterion when the decision is block', async () => {
    const h = harness({
      exitCode: 1,
      envelope: {
        storyId: 4780,
        decision: 'block',
        round: 2,
        cap: 2,
        unmetCriteria: [
          { index: 3, criterion: 'AC-3', verdict: 'not-met', evidence: null },
          { index: 5, criterion: 'AC-5', verdict: 'unclear', evidence: null },
        ],
      },
    });
    await assert.rejects(
      () =>
        runAcceptanceEvalCli(
          ['--story', '4780', '--verdict', 'v.json'],
          h.deps,
        ),
      (err) => {
        assert.match(
          err.message,
          /round cap \(2\) reached with criteria still unmet/,
        );
        assert.match(err.message, /#3 \(not-met\), #5 \(unclear\)/);
        assert.match(err.message, /Transition the Story to agent::blocked/);
        return true;
      },
    );
    // The envelope is still printed before the throw — the loop's record of
    // why it blocked must survive the non-zero exit.
    assert.equal(JSON.parse(h.infos[0]).decision, 'block');
  });
});

/**
 * Story #4951 — one round = N parallel cluster critics → ONE merged verdict →
 * ONE gate call.
 *
 * The round counter is Story-scoped, so a gate call per cluster spends a whole
 * round per cluster. `--expected-criteria` is the guard: a verdict that does
 * not cover every `acceptance[]` item is refused before the scoring path is
 * ever entered, which the `seen` spy makes observable — an empty `seen` means
 * the round ledger was never read or appended.
 */
describe('--expected-criteria — the merge contract (Story #4951)', () => {
  const clusterVerdict = (count) =>
    verdictFixture({
      criteria: Array.from({ length: count }, (_, index) => ({
        index,
        criterion: `AC-${index + 1} holds`,
        verdict: 'met',
        evidence: 'npm test exits 0',
      })),
    });

  it('resolves an absent flag to null so the assertion is opt-in', () => {
    assert.equal(resolveExpectedCriteria(null), null);
    assert.equal(resolveExpectedCriteria(undefined), null);
    assert.equal(resolveExpectedCriteria('4'), 4);
  });

  it('refuses a non-positive or non-numeric --expected-criteria', () => {
    for (const raw of ['0', '-2', 'four', '']) {
      assert.throws(
        () => resolveExpectedCriteria(raw),
        /--expected-criteria must be a positive integer/,
        `--expected-criteria ${raw} should be refused`,
      );
    }
  });

  it('AC-5: refuses a digit-prefixed value instead of truncating it (Story #4959)', () => {
    // `Number.parseInt` stops at the first non-digit, so each of these used to
    // resolve to a plausible-looking count. The guard exists to reject a
    // wrong-sized verdict — accepting a malformed count is the one failure it
    // cannot afford, because the resulting number is silently believed.
    for (const raw of ['4abc', '4.9', '4 5', '0x10', '1e3', ' 4a ']) {
      assert.throws(
        () => resolveExpectedCriteria(raw),
        /--expected-criteria must be a positive integer/,
        `--expected-criteria ${raw} should be refused, not coerced`,
      );
    }
    // Surrounding whitespace on an otherwise clean integer stays acceptable.
    assert.equal(resolveExpectedCriteria(' 12 '), 12);
  });

  it('passes a verdict covering exactly the expected criteria', () => {
    assert.doesNotThrow(() => assertCriteriaCoverage(clusterVerdict(4), 4));
  });

  it('is a no-op when no expectation was given', () => {
    assert.doesNotThrow(() => assertCriteriaCoverage(clusterVerdict(1), null));
  });

  it('scores a merged full-coverage verdict as one round', async () => {
    const h = harness({ verdict: clusterVerdict(4) });
    const envelope = await runAcceptanceEvalCli(
      [
        '--story',
        '4780',
        '--verdict',
        'merged.json',
        '--expected-criteria',
        '4',
      ],
      h.deps,
    );
    assert.equal(envelope.decision, 'proceed');
    assert.equal(h.seen.length, 1, 'the gate scores the merged verdict once');
  });

  it('rejects an unmerged cluster verdict before scoring, consuming no round', async () => {
    const h = harness({ verdict: clusterVerdict(2) });
    await assert.rejects(
      () =>
        runAcceptanceEvalCli(
          [
            '--story',
            '4780',
            '--verdict',
            'cluster-1.json',
            '--expected-criteria',
            '4',
          ],
          h.deps,
        ),
      (err) => {
        assert.match(
          err.message,
          /verdict covers 2 criteria but the Story's acceptance\[\] count is 4/,
        );
        assert.match(err.message, /ONE merged verdict -> ONE gate call/);
        assert.match(err.message, /No round was consumed/);
        return true;
      },
    );
    assert.deepEqual(h.seen, [], 'the scoring path must never be entered');
    assert.deepEqual(
      h.infos,
      [],
      'no envelope is printed for a refused verdict',
    );
  });

  it('skips the assertion (and says so) when neither the body nor the flag is readable', async () => {
    const warnings = [];
    const h = harness({ verdict: clusterVerdict(2) });
    h.deps.logger = { info: () => {}, warn: (m) => warnings.push(m) };
    const envelope = await runAcceptanceEvalCli(
      ['--story', '4780', '--verdict', 'cluster-1.json'],
      h.deps,
    );
    assert.equal(envelope.decision, 'proceed');
    assert.equal(h.seen.length, 1);
    assert.equal(
      warnings.some((w) => /coverage assertion is skipped/.test(w)),
      true,
      'a skipped assertion must be stated, never silent',
    );
  });
});

/**
 * Story #5313 — the gate reads the Story's `acceptance[]` count itself. The
 * flag becomes redundant: a shorter verdict is refused before scoring with
 * NO `--expected-criteria` passed, and an inline-owned verdict is one file
 * scored in one call.
 */
describe('the derived acceptance[] count (Story #5313)', () => {
  const clusterVerdict = (count) =>
    verdictFixture({
      criteria: Array.from({ length: count }, (_, index) => ({
        index,
        criterion: `AC-${index + 1}`,
        verdict: 'met',
        evidence: 'ok',
      })),
    });

  it('readStoryAcceptanceCount parses the count off the ticket body', async () => {
    const body = [
      '## Goal',
      'g',
      '',
      '## Acceptance',
      '- [ ] AC-1: one',
      '- [ ] AC-2: two',
      '- [ ] AC-3: three',
      '',
      '## Verify',
      '- npm test (unit)',
    ].join('\n');
    const count = await readStoryAcceptanceCount(
      { storyId: 4780, config: {} },
      { createProviderFn: () => ({ getTicket: async () => ({ body }) }) },
    );
    assert.equal(count, 3);
  });

  it('readStoryAcceptanceCount is total — every failure reads as null', async () => {
    for (const createProviderFn of [
      () => {
        throw new Error('no provider');
      },
      () => ({
        getTicket: async () => {
          throw new Error('gh missing');
        },
      }),
      () => ({ getTicket: async () => ({ body: null }) }),
      () => ({ getTicket: async () => ({ body: '## Goal\nno acceptance' }) }),
    ]) {
      assert.equal(
        await readStoryAcceptanceCount(
          { storyId: 4780, config: {} },
          { createProviderFn },
        ),
        null,
      );
    }
  });

  it('reconcileExpectedCriteria prefers the derived count and refuses a disagreeing flag', () => {
    assert.equal(reconcileExpectedCriteria({ derived: 4, flagged: null }), 4);
    assert.equal(reconcileExpectedCriteria({ derived: 4, flagged: 4 }), 4);
    assert.equal(reconcileExpectedCriteria({ derived: null, flagged: 4 }), 4);
    assert.equal(
      reconcileExpectedCriteria({ derived: null, flagged: null }),
      null,
    );
    assert.throws(
      () => reconcileExpectedCriteria({ derived: 4, flagged: 2 }),
      /--expected-criteria 2 disagrees with the Story's acceptance\[\] count \(4\)/,
    );
  });

  it('AC-4: rejects a shorter verdict before scoring with NO flag passed', async () => {
    const h = harness({ verdict: clusterVerdict(2) });
    h.deps.readAcceptanceCountImpl = async ({ storyId }) => {
      assert.equal(storyId, 4780);
      return 4;
    };
    await assert.rejects(
      () =>
        runAcceptanceEvalCli(
          ['--story', '4780', '--verdict', 'cluster-1.json'],
          h.deps,
        ),
      /verdict covers 2 criteria but the Story's acceptance\[\] count is 4/,
    );
    assert.deepEqual(h.seen, [], 'the scoring path must never be entered');
  });

  it('AC-4: an inline-owned verdict covering every item is scored in ONE call', async () => {
    const h = harness({ verdict: clusterVerdict(4) });
    h.deps.readAcceptanceCountImpl = async () => 4;
    const envelope = await runAcceptanceEvalCli(
      ['--story', '4780', '--verdict', 'inline.json'],
      h.deps,
    );
    assert.equal(envelope.decision, 'proceed');
    assert.equal(h.seen.length, 1, 'one verdict file, one gate call');
  });

  it('the redundant flag is accepted when it agrees and refused when it does not', async () => {
    const agree = harness({ verdict: clusterVerdict(4) });
    agree.deps.readAcceptanceCountImpl = async () => 4;
    await runAcceptanceEvalCli(
      ['--story', '4780', '--verdict', 'v.json', '--expected-criteria', '4'],
      agree.deps,
    );
    assert.equal(agree.seen.length, 1);

    const disagree = harness({ verdict: clusterVerdict(4) });
    disagree.deps.readAcceptanceCountImpl = async () => 4;
    await assert.rejects(
      () =>
        runAcceptanceEvalCli(
          [
            '--story',
            '4780',
            '--verdict',
            'v.json',
            '--expected-criteria',
            '3',
          ],
          disagree.deps,
        ),
      /disagrees with the Story's acceptance\[\] count/,
    );
    assert.deepEqual(disagree.seen, []);
  });
});

/**
 * Story #4874 — reading a verdict is not a round.
 *
 * The round is counted off the Story's signal ledger, and every invocation
 * used to append one, so simply *re-reading* an existing verdict consumed
 * the cap and could turn a `redraft` into a `block` with no work in
 * between. These exercise the real ledger resolver (its `readFile` seam
 * injected) through `runAcceptanceEval`, so the replay guard is tested
 * end-to-end rather than stubbed away.
 */
describe('runAcceptanceEval — replay guard (Story #4874)', () => {
  const config = { delivery: { acceptanceEval: { maxRounds: 2 } } };

  const redraftVerdict = {
    storyId: 4874,
    schemaVersion: 1,
    round: 1,
    criteria: [
      { index: 0, criterion: 'AC-1', verdict: 'met', evidence: 'test passes' },
      { index: 1, criterion: 'AC-2', verdict: 'unmet', evidence: 'no test' },
    ],
  };

  const reworkedVerdict = {
    ...redraftVerdict,
    criteria: [
      redraftVerdict.criteria[0],
      { index: 1, criterion: 'AC-2', verdict: 'unmet', evidence: 'still red' },
    ],
  };

  /** A ledger holding exactly one prior round for `verdict`. */
  const ledgerFor = (verdict, round = 1) =>
    `${JSON.stringify({
      kind: 'acceptance-eval',
      storyId: 4874,
      details: {
        round,
        verdictFingerprint: computeVerdictFingerprint(verdict),
      },
    })}\n`;

  const depsOver = (ledgerText, appended) => ({
    resolveRoundFn: (args) =>
      resolveAcceptanceEvalRound({
        ...args,
        readFile: () => ledgerText,
        signalsPathResolver: () => '/fake/signals.ndjson',
      }),
    appendSignalFn: async ({ signal }) => {
      appended.push(signal);
      return true;
    },
  });

  it('does not advance the round when an existing verdict is re-read', async () => {
    const appended = [];
    const { envelope } = await runAcceptanceEval(
      {
        storyId: 4874,
        verdict: redraftVerdict,
        config,
        emitSignal: true,
      },
      depsOver(ledgerFor(redraftVerdict), appended),
    );
    assert.equal(envelope.round, 1);
    assert.equal(envelope.replay, true);
  });

  it('appends no signal on a replay, so observation is free', async () => {
    const appended = [];
    const { envelope } = await runAcceptanceEval(
      {
        storyId: 4874,
        verdict: redraftVerdict,
        config,
        emitSignal: true,
      },
      depsOver(ledgerFor(redraftVerdict), appended),
    );
    assert.deepEqual(appended, []);
    assert.equal(envelope.signalEmitted, false);
  });

  it('keeps a redraft a redraft however many times it is read', async () => {
    const ledger = ledgerFor(redraftVerdict);
    for (let i = 0; i < 4; i += 1) {
      const appended = [];
      const { envelope, exitCode } = await runAcceptanceEval(
        {
          storyId: 4874,
          verdict: redraftVerdict,
          config,
          emitSignal: true,
        },
        depsOver(ledger, appended),
      );
      assert.equal(envelope.decision, 'redraft');
      assert.equal(envelope.capReached, false);
      assert.equal(exitCode, 0);
    }
  });

  it('advances the round for a genuine re-evaluation after new work', async () => {
    const appended = [];
    const { envelope, exitCode } = await runAcceptanceEval(
      {
        storyId: 4874,
        verdict: reworkedVerdict,
        config,
        emitSignal: true,
      },
      depsOver(ledgerFor(redraftVerdict), appended),
    );
    assert.equal(envelope.round, 2);
    assert.equal(envelope.replay, false);
    assert.equal(envelope.decision, 'block');
    assert.equal(exitCode, 1);
    assert.equal(appended.length, 1);
    assert.equal(
      appended[0].details.verdictFingerprint,
      computeVerdictFingerprint(reworkedVerdict),
    );
  });

  it('scores the first evaluation as round 1 against an empty ledger', async () => {
    const appended = [];
    const { envelope } = await runAcceptanceEval(
      { storyId: 4874, verdict: redraftVerdict, config, emitSignal: true },
      depsOver('', appended),
    );
    assert.equal(envelope.round, 1);
    assert.equal(envelope.replay, false);
    assert.equal(appended.length, 1);
  });
});

/**
 * Story #5174 — the delivery already runs the full suite once. What it did not
 * do was tell anyone, so a `verify[]` entry that names the same suite spawned
 * it again and the close gate chain spawned it a third time. These cover the
 * read side of the credit and the shape warning that keeps `verify[]` honest.
 */
describe('verify[] credit — the suite is paid for once (#5174)', () => {
  const credited = (command, over = {}) =>
    resolveVerifyCredit(
      { command, storyId: 5174, worktree: '/abs/worktree', cwd: '/abs/repo' },
      {
        resolveConfigImpl: () => ({}),
        getQualityImpl: () => ({
          crap: {
            enabled: true,
            coveragePath: 'coverage/coverage-final.json',
            targetDirs: ['.agents/scripts'],
          },
        }),
        readPackageScriptsImpl: () => ({ 'test:coverage': 'node --test' }),
        hasNpmScriptImpl: () => true,
        isCoverageFreshImpl: () => ({ fresh: true, reason: 'fresh' }),
        ...over,
      },
    );

  it('classifies whole-suite runners and leaves scoped commands alone', () => {
    // A false positive here is the dangerous direction: it would report a
    // SCOPED command as already covered and never run it, which is how a gate
    // stops gating. So anything carrying its own path argument is scoped.
    for (const full of [
      'npm test',
      'npm run test',
      'pnpm test',
      'pnpm run test',
      'yarn test',
      'npm run test:coverage',
      'node --test',
    ]) {
      assert.equal(
        isFullSuiteCommand(full),
        true,
        `${full} is the whole suite`,
      );
    }
    for (const scoped of [
      'npm test -- tests/acceptance-eval.test.js',
      'node --test tests/acceptance-eval.test.js',
      'npm run lint',
      'node .agents/scripts/check-context-budget.js',
      '',
    ]) {
      assert.equal(isFullSuiteCommand(scoped), false, `${scoped} is scoped`);
    }
  });

  // AC-10 (Story #5278) — a positional path is not the only way to narrow a
  // run. Node's filter flags select a fraction of the suite while the argv
  // still reads as a bare `node --test`, so crediting one against the
  // full-suite stamp reports a filtered run as the whole thing.
  it('AC-10: a narrowing filter flag makes the command scoped, not full', () => {
    for (const narrowed of [
      'node --test --test-name-pattern=close',
      'node --test --test-name-pattern close',
      'node --test --test-skip-pattern=slow',
      'node --test --test-only',
      'npm test -- --test-name-pattern=close',
    ]) {
      assert.equal(
        isFullSuiteCommand(narrowed),
        false,
        `${narrowed} runs a fraction of the suite`,
      );
    }
  });

  it('AC-10: a non-narrowing flag still reads as the whole suite', () => {
    for (const full of [
      'node --test --experimental-test-coverage',
      'node --test --test-reporter=tap',
      'node --test --experimental-test-module-mocks',
    ]) {
      assert.equal(isFullSuiteCommand(full), true, `${full} is the suite`);
    }
  });

  it('strips the Story body tier tag before classifying', () => {
    // verify[] lines are written `<command> (<tier>)`. Left attached, the tag
    // makes every entry look like it carries an argument — i.e. scoped — and
    // the credit would never fire on a real Story body.
    assert.deepEqual(parseVerifyEntry('npm test (unit)'), {
      command: 'npm test',
      tier: 'unit',
    });
    assert.equal(
      isFullSuiteCommand(parseVerifyEntry('npm test (unit)').command),
      true,
    );
  });

  it('reports a full-suite entry as credited against a fresh capture stamp', () => {
    const verdict = credited('npm test');
    assert.equal(verdict.fullSuite, true);
    assert.equal(verdict.credited, true);
    assert.equal(verdict.spawn, false);
    assert.equal(verdict.mode, 'capture');
    assert.equal(verdict.reason, 'capture-stamp-fresh');
    assert.match(verdict.warning, /scoped entries plus the single credited/);
  });

  it('runs the command for real when the stamp is stale — credit never manufactures a pass', () => {
    const verdict = credited('npm test', {
      isCoverageFreshImpl: () => ({ fresh: false, reason: 'stale' }),
    });
    assert.equal(verdict.credited, false);
    assert.equal(verdict.spawn, true);
    assert.equal(verdict.reason, 'stale');
  });

  it('falls back to the evidence record when no capture stamp is configured', () => {
    const seen = [];
    const verdict = resolveVerifyCredit(
      {
        command: 'npm test',
        storyId: 5174,
        worktree: '/abs/wt',
        cwd: '/abs/repo',
      },
      {
        resolveConfigImpl: () => ({}),
        getQualityImpl: () => ({ crap: { enabled: false } }),
        readPackageScriptsImpl: () => ({}),
        hasNpmScriptImpl: () => false,
        hashCommandConfigImpl: (input) => {
          seen.push(input);
          return 'hash-1';
        },
        shouldSkipImpl: (input) => {
          seen.push(input);
          return { skip: true, reason: 'evidence-match' };
        },
        gitSpawnFn: () => ({ status: 0, stdout: 'abc1234\n' }),
      },
    );
    assert.equal(verdict.mode, 'evidence');
    assert.equal(verdict.credited, true);
    assert.equal(verdict.spawn, false);
    // Keyed on the WORKTREE tree, matching how the crediting invocation is
    // documented — a main-checkout cwd would hash to a different config.
    assert.equal(seen[0].cwd, '/abs/wt');
    assert.equal(seen[1].currentSha, 'abc1234');
    assert.equal(seen[1].gateName, 'test');
  });

  it('plans a whole verify[] array in one pass', () => {
    const plan = planVerifyExecution(
      ['npm run lint (validate)', 'npm test (unit)'],
      { storyId: 5174, worktree: '/abs/wt', cwd: '/abs/repo' },
      {
        resolveConfigImpl: () => ({}),
        getQualityImpl: () => ({
          crap: { enabled: true, coveragePath: 'c.json', targetDirs: ['x'] },
        }),
        readPackageScriptsImpl: () => ({ 'test:coverage': 'x' }),
        hasNpmScriptImpl: () => true,
        isCoverageFreshImpl: () => ({ fresh: true, reason: 'fresh' }),
      },
    );
    assert.deepEqual(
      plan.map((p) => [p.command, p.spawn, p.tier]),
      [
        ['npm run lint', true, 'validate'],
        ['npm test', false, 'unit'],
      ],
    );
  });
});

describe('the gate warns on a misshapen verify[] (#5174)', () => {
  const verdictWith = (commands) => ({
    storyId: 5174,
    schemaVersion: 1,
    round: 1,
    criteria: [
      {
        index: 0,
        criterion: 'AC-1 holds',
        verdict: 'met',
        evidence: 'suite green',
        verifyEvidence: commands.map((command) => ({
          command,
          outcome: 'pass',
        })),
      },
    ],
  });

  it('collects the offending commands, de-duplicated, in first-seen order', () => {
    const found = collectFullSuiteVerifyCommands(
      verdictWith(['npm run lint', 'npm test', 'npm test', 'pnpm run test']),
    );
    assert.deepEqual(found, ['npm test', 'pnpm run test']);
  });

  it('says nothing about a verify[] that is all scoped entries', () => {
    assert.deepEqual(
      collectFullSuiteVerifyCommands(
        verdictWith(['npm run lint', 'node --test tests/x.test.js']),
      ),
      [],
    );
  });

  it('emits the warning naming the intended shape, and still scores the round', async () => {
    const warns = [];
    const infos = [];
    const envelope = await runAcceptanceEvalCli(
      ['--story', '5174', '--verdict', '/tmp/verdict.json'],
      {
        readFileSyncImpl: () => JSON.stringify(verdictWith(['npm test'])),
        resolveConfigImpl: () => ({
          delivery: { acceptanceEval: { maxRounds: 2 } },
        }),
        readAcceptanceCountImpl: async () =>
          verdictWith(['npm test']).criteria.length,
        runAcceptanceEvalImpl: async () => ({
          envelope: { storyId: 5174, decision: 'proceed', unmetCriteria: [] },
          exitCode: 0,
        }),
        logger: {
          info: (m) => infos.push(m),
          warn: (m) => warns.push(m),
        },
      },
    );
    assert.equal(envelope.decision, 'proceed');
    assert.equal(warns.length, 1);
    assert.match(warns[0], /npm test/);
    assert.match(
      warns[0],
      /scoped entries plus the single credited full-suite run/,
    );
    // A warning, never a refusal: the round still scores.
    assert.equal(infos.length, 1);
  });

  it('reports the offenders on the envelope so a caller can act on them', async () => {
    const { envelope } = await runAcceptanceEval({
      storyId: 5174,
      verdict: verdictWith(['npm test', 'npm run lint']),
      config: { delivery: { acceptanceEval: { maxRounds: 2 } } },
      emitSignal: false,
    });
    assert.deepEqual(envelope.fullSuiteVerifyCommands, ['npm test']);
  });
});

describe('the happy path spends ONE full-suite spawn per Story (#5174)', () => {
  /**
   * The documented worker transcript, in order. This is the artifact the
   * ordering contract is really about: exactly one entry may be a whole-suite
   * spawn, and it must sit after the last fix commit and before the push.
   */
  const TRANSCRIPT = [
    'node .agents/scripts/single-story-init.js --story 5174',
    'npm run lint',
    'node --test tests/acceptance-eval.test.js',
    'git commit -m "feat: implement (refs #5174)"',
    'node .agents/scripts/acceptance-eval.js --story 5174 --verdict v.json',
    'node .agents/scripts/coverage-capture.js --cwd /abs/wt',
    'git push origin story-5174',
  ];

  it('runs the whole suite exactly once, after the last commit and before the push', () => {
    const suiteRuns = TRANSCRIPT.filter(
      (line) =>
        isFullSuiteCommand(line) || line.includes('coverage-capture.js --cwd'),
    );
    assert.equal(suiteRuns.length, 1, 'exactly one full-suite spawn per Story');

    const suiteAt = TRANSCRIPT.indexOf(suiteRuns[0]);
    const lastCommitAt = TRANSCRIPT.reduce(
      (acc, line, i) => (line.startsWith('git commit') ? i : acc),
      -1,
    );
    const pushAt = TRANSCRIPT.findIndex((line) => line.startsWith('git push'));
    assert.ok(
      lastCommitAt < suiteAt && suiteAt < pushAt,
      'the credited run must sit between the last fix commit and the push, or its stamp describes a tree that is not the one pushed',
    );
  });

  it('leaves the close coverage-capture gate nothing to do', () => {
    // What the single spawn buys: close consults the stamp the worker wrote
    // and exits fresh, instead of paying for the identical suite again.
    const logs = [];
    const exit = runCoverageCapture(
      ['node', 'coverage-capture.js', '--cwd', '/abs/wt'],
      {
        resolveConfigImpl: () => ({}),
        getQualityImpl: () => ({
          crap: {
            enabled: true,
            coveragePath: 'coverage/coverage-final.json',
            targetDirs: ['.agents/scripts'],
          },
          coverage: { enabled: true },
        }),
        readPackageScriptsImpl: () => ({ 'test:coverage': 'node --test' }),
        hasNpmScriptImpl: () => true,
        isCoverageFreshImpl: () => ({ fresh: true, reason: 'fresh' }),
        runCaptureImpl: () => {
          throw new Error('close re-ran the suite the worker already credited');
        },
        logger: {
          info: (m) => logs.push(m),
          warn: (m) => logs.push(m),
          error: (m) => logs.push(m),
        },
      },
    );
    assert.equal(exit, 0);
    assert.ok(
      logs.some((l) => /skipping capture/i.test(l)),
      `close must report the skip; got ${JSON.stringify(logs)}`,
    );
  });
});

describe('verify[] credit — the fail-closed edges (#5174)', () => {
  const evidenceDeps = (over = {}) => ({
    resolveConfigImpl: () => ({}),
    getQualityImpl: () => ({ crap: { enabled: false } }),
    readPackageScriptsImpl: () => ({}),
    hasNpmScriptImpl: () => false,
    hashCommandConfigImpl: () => 'hash-1',
    shouldSkipImpl: () => ({ skip: false, reason: 'no-record' }),
    gitSpawnFn: () => ({ status: 0, stdout: 'abc1234\n' }),
    ...over,
  });

  it('spawns rather than credits when HEAD cannot be read', () => {
    // No SHA means no key to check the evidence record against. The only safe
    // answer is to run the command — a credit here would be a guess.
    const verdict = resolveVerifyCredit(
      { command: 'npm test', storyId: 5174, worktree: '/abs/wt' },
      evidenceDeps({ gitSpawnFn: () => ({ status: 128, stdout: '' }) }),
    );
    assert.equal(verdict.credited, false);
    assert.equal(verdict.spawn, true);
    assert.equal(verdict.reason, 'no-head');
  });

  it('spawns when the evidence record does not match the current HEAD', () => {
    const verdict = resolveVerifyCredit(
      { command: 'npm test', storyId: 5174, worktree: '/abs/wt' },
      evidenceDeps({
        shouldSkipImpl: () => ({ skip: false, reason: 'sha-mismatch' }),
      }),
    );
    assert.equal(verdict.credited, false);
    assert.equal(verdict.reason, 'sha-mismatch');
  });

  it('reports an unreadable freshness verdict as unknown, never as fresh', () => {
    const verdict = resolveVerifyCredit(
      { command: 'npm test', storyId: 5174, worktree: '/abs/wt' },
      {
        resolveConfigImpl: () => ({}),
        getQualityImpl: () => ({
          crap: { enabled: true, coveragePath: 'c.json', targetDirs: ['x'] },
        }),
        readPackageScriptsImpl: () => ({ 'test:coverage': 'x' }),
        hasNpmScriptImpl: () => true,
        isCoverageFreshImpl: () => undefined,
      },
    );
    assert.equal(verdict.credited, false);
    assert.equal(verdict.spawn, true);
    assert.equal(verdict.reason, 'unknown');
  });

  it('survives a Story body that quotes the command or omits the tier', () => {
    assert.deepEqual(parseVerifyEntry('`npm test`'), {
      command: 'npm test',
      tier: null,
    });
    assert.deepEqual(parseVerifyEntry(undefined), { command: '', tier: null });
  });

  it('treats a missing verify[] array as nothing to plan', () => {
    assert.deepEqual(planVerifyExecution(undefined, { worktree: '/x' }), []);
  });
});
