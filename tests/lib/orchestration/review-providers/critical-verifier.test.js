/**
 * Unit tests for the fresh-context critical verifier. Every claude call goes
 * through the injected spawn seam; git reads go through `gitSpawnFn`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { vetFindings } from '../../../../.agents/scripts/lib/orchestration/review-providers/critical-verifier.js';

const MAX_VERIFIED_CRITICALS = 10;

const envelope = (verdict) => ({
  status: 0,
  stdout: JSON.stringify({ subtype: 'success', structured_output: verdict }),
  stderr: '',
});

const REFUTED = { verdict: 'refuted', evidence: null, reason: 'guarded at L3' };
const CONFIRMED = {
  verdict: 'confirmed',
  evidence: { file: 'src/a.js', line: 2, excerpt: 'x' },
  reason: 'it crashes',
};

/** A spawn stub answering each call from `answers` in turn (last repeats). */
function spawnStub(answers) {
  const calls = [];
  const fn = async (file, args, options) => {
    calls.push({ file, args, options });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fn, calls };
}

/** `git show` succeeds with three lines for `src/a.js` only. */
const gitSpawnFn = (_cwd, cmd, spec) =>
  cmd === 'show' && spec === 'HEAD1:src/a.js'
    ? { status: 0, stdout: 'a\nb\nc\n', stderr: '' }
    : { status: 128, stdout: '', stderr: 'missing' };

const critical = (title, extra = {}) => ({
  severity: 'critical',
  title,
  body: `${title} body`,
  file: 'src/a.js',
  line: 2,
  ...extra,
});

function run(findings, answers, extra = {}) {
  const spawn = spawnStub(answers);
  const { depth, ...seams } = extra;
  const out = vetFindings({
    findings,
    reviewInput: { baseRef: 'origin/main', headRef: 'HEAD1', depth },
    opts: {
      cwd: '/repo',
      gitSpawnFn,
      verifier: {
        spawnFn: spawn.fn,
        probeFn: () => true,
        platform: 'linux',
        ...seams,
      },
    },
    degradations: [],
  });
  return out.then((result) => ({ ...result, calls: spawn.calls }));
}

test('AC-1: a refuted critical is downgraded with the verifier reason', async () => {
  const out = await run([critical('Bug')], [envelope(REFUTED)]);
  assert.equal(out.findings[0].severity, 'suggestion');
  assert.equal(out.findings[0].unverified, 'guarded at L3');
  assert.equal(out.findings[0].title, 'Bug');
  assert.deepEqual(out.degradations, []);
  assert.deepEqual(out.verification, {
    attempted: 1,
    confirmed: 0,
    refuted: 1,
    uncertain: 0,
    errored: 0,
  });
});

test('AC-2: a confirmation with evidence at head keeps the critical', async () => {
  const out = await run([critical('Bug')], [envelope(CONFIRMED)]);
  assert.equal(out.findings[0].severity, 'critical');
  assert.equal(out.findings[0].unverified, undefined);
  assert.equal(out.verification.confirmed, 1);
  assert.deepEqual(out.degradations, []);
});

test('AC-3: an error, a timeout, a throw or unparseable output stays blocking and degrades', async () => {
  for (const answer of [
    { status: 1, stdout: '', stderr: 'boom' },
    { status: 1, stdout: '', stderr: 'spawnSync claude ETIMEDOUT' },
    new Error('spawn failed'),
    { status: 0, stdout: 'not json', stderr: '' },
  ]) {
    const out = await run([critical('Bug')], [answer]);
    assert.equal(out.findings[0].severity, 'critical');
    assert.equal(out.verification.errored, 1);
    assert.equal(out.degradations.length, 1);
    assert.equal(out.degradations[0].tool, 'critical-verifier');
    assert.equal(out.degradations[0].gate, 'codeReview');
    assert.match(out.degradations[0].reason, /"Bug" \(src\/a\.js:2\)/);
  }
});

test('AC-3: a missing claude CLI spawns nothing and leaves the critical blocking', async () => {
  const out = await run([critical('Bug')], [envelope(REFUTED)], {
    probeFn: () => false,
  });
  assert.equal(out.calls.length, 0);
  assert.equal(out.findings[0].severity, 'critical');
  assert.match(out.degradations[0].reason, /claude CLI not found/);
});

test('AC-3: a confirmation whose evidence is absent at head counts as uncertain and degrades', async () => {
  for (const evidence of [
    { file: 'src/gone.js', line: 1 },
    { file: 'src/a.js', line: 9 },
    null,
  ]) {
    const out = await run(
      [critical('Bug')],
      [envelope({ ...CONFIRMED, evidence })],
    );
    assert.equal(out.findings[0].severity, 'critical');
    assert.equal(out.verification.uncertain, 1);
    assert.equal(out.verification.confirmed, 0);
    assert.match(out.degradations[0].reason, /"Bug".*evidence not found/);
  }
});

test('AC-4: findings below critical are never sent to the verifier', async () => {
  const findings = [
    { severity: 'high', title: 'H', body: 'h' },
    { severity: 'suggestion', title: 'S', body: 's' },
  ];
  const out = await run(findings, [envelope(REFUTED)]);
  assert.equal(out.calls.length, 0);
  assert.deepEqual(out.findings, findings);
  assert.equal(out.verification.attempted, 0);
});

test('AC-5: the prompt carries only its own finding and the refs', async () => {
  const out = await run(
    [
      critical('Alpha bug'),
      { severity: 'high', title: 'Beta risk', body: 'beta body' },
      critical('Gamma bug', { file: 'src/g.js' }),
    ],
    [envelope(CONFIRMED)],
  );
  assert.equal(out.calls.length, 2);
  const [first, second] = out.calls.map((c) => c.options.input);
  assert.match(first, /Alpha bug/);
  assert.match(first, /origin\/main\.\.\.HEAD1/);
  for (const banned of [
    /Gamma bug/,
    /Beta risk/,
    /diff --git/,
    /acceptance/i,
  ]) {
    assert.doesNotMatch(first, banned);
  }
  assert.match(second, /Gamma bug/);
  assert.doesNotMatch(second, /Alpha bug/);
  assert.equal(out.calls[0].options.cwd, '/repo');
});

test('AC-6: the invocation grants no edit tool and Bash only for three git reads', async () => {
  const out = await run([critical('Bug')], [envelope(REFUTED)]);
  const { file, args } = out.calls[0];
  assert.equal(file, 'claude');
  assert.ok(args.includes('--print'));
  const tools = args[args.indexOf('--tools') + 1];
  assert.equal(tools, 'Read,Grep,Glob,Bash');
  const allowed = args.slice(args.indexOf('--allowedTools') + 1);
  assert.deepEqual(allowed, [
    'Read',
    'Grep',
    'Glob',
    'Bash(git show:*)',
    'Bash(git grep:*)',
    'Bash(git log:*)',
  ]);
  assert.ok(!args.some((a) => /Edit|Write/.test(a)));
});

test('AC-7: at deep depth three verifiers vote and one refutation does not downgrade', async () => {
  const one = await run(
    [critical('Bug')],
    [
      envelope(REFUTED),
      envelope(CONFIRMED),
      envelope({ verdict: 'uncertain', evidence: null, reason: 'unsure' }),
    ],
    { depth: 'deep' },
  );
  assert.equal(one.calls.length, 3);
  assert.equal(one.findings[0].severity, 'critical');
  assert.deepEqual(one.verification, {
    attempted: 3,
    confirmed: 1,
    refuted: 1,
    uncertain: 1,
    errored: 0,
  });
  const two = await run(
    [critical('Bug')],
    [envelope(REFUTED), envelope(REFUTED), envelope(CONFIRMED)],
    { depth: 'deep' },
  );
  assert.equal(two.findings[0].severity, 'suggestion');
});

test('bounds: criticals past the cap stand unverified and are named', async () => {
  const findings = Array.from({ length: MAX_VERIFIED_CRITICALS + 2 }, (_, i) =>
    critical(`Bug ${i}`),
  );
  let inFlight = 0;
  let peak = 0;
  const spawnFn = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    return envelope(REFUTED);
  };
  const out = await run(findings, [], { spawnFn });
  assert.equal(peak, 3);
  assert.equal(out.verification.attempted, MAX_VERIFIED_CRITICALS);
  assert.equal(out.findings.filter((f) => f.severity === 'critical').length, 2);
  assert.equal(out.degradations.length, 1);
  assert.match(out.degradations[0].reason, /"Bug 10".*"Bug 11"/);
});

test('a verdict in the result text counts; an unknown verdict is an error', async () => {
  const fromText = await run(
    [critical('Bug')],
    [
      {
        status: 0,
        stdout: JSON.stringify({
          subtype: 'success',
          result: JSON.stringify(REFUTED),
        }),
        stderr: '',
      },
    ],
  );
  assert.equal(fromText.verification.refuted, 1);
  const unknown = await run(
    [critical('Bug')],
    [envelope({ verdict: 'maybe', reason: 'x' })],
  );
  assert.match(unknown.degradations[0].reason, /did not parse/);
});

test('the prompt tells the verifier to read code at the head ref', async () => {
  const out = await run([critical('Bug')], [envelope(REFUTED)]);
  assert.match(out.calls[0].options.input, /git show HEAD1:<path>/);
});
