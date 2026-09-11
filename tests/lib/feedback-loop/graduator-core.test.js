/**
 * tests/lib/feedback-loop/graduator-core.test.js — Story #3845
 *
 * Unit tests for the shared graduator core extracted in Story #3845. The
 * audit-results and code-review graduators are now thin shells over this
 * module; these tests pin the shared mechanism directly (the spawn
 * helper's error envelope, the path/idempotency probes, the filer, the
 * toggle factory, and the parametrized `graduate()` walk with an injected
 * parser + body builder).
 *
 * The gh/git child processes are stubbed via the `spawnImpl` seam; no real
 * network, git, or filesystem access occurs.
 */

import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import {
  createFollowUpIssue,
  graduate,
  makeIsAutoFileEnabled,
  probeMarkerExists,
  probePathStatus,
  runChild,
} from '../../../.agents/scripts/lib/feedback-loop/graduator-core.js';

/**
 * Route a spawn by command + first arg to a responder returning
 * `{ stdout, stderr, code }`. Throw inside a responder to simulate a
 * synchronous spawn failure.
 */
function makeSpawnStub(routes) {
  const calls = [];
  const fn = function spawnImpl(cmd, args) {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let result;
    if (cmd === 'git') {
      result = routes.git
        ? routes.git(args)
        : { stdout: '', stderr: '', code: 0 };
    } else if (args[0] === 'search') {
      result = routes.ghSearch
        ? routes.ghSearch(args)
        : { stdout: '[]', stderr: '', code: 0 };
    } else if (args[0] === 'issue' && args[1] === 'list') {
      result = routes.ghList
        ? routes.ghList(args)
        : { stdout: '[]', stderr: '', code: 0 };
    } else if (args[0] === 'issue' && args[1] === 'create') {
      result = routes.ghCreate
        ? routes.ghCreate(args)
        : { stdout: 'https://github.com/o/r/issues/1', stderr: '', code: 0 };
    } else if (args[0] === 'issue' && args[1] === 'edit') {
      result = routes.ghEdit
        ? routes.ghEdit(args)
        : { stdout: 'https://github.com/o/r/issues/1', stderr: '', code: 0 };
    } else {
      result = { stdout: '', stderr: '', code: 0 };
    }
    queueMicrotask(() => {
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
      child.emit('close', result.code);
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

describe('runChild', () => {
  it('captures a synchronous spawn throw as spawnError without throwing', async () => {
    const spawnImpl = () => {
      throw new Error('boom');
    };
    const res = await runChild({ cmd: 'gh', args: [], spawnImpl });
    assert.equal(res.code, null);
    assert.equal(res.spawnError.message, 'boom');
  });

  it('accumulates stdout/stderr and resolves the exit code', async () => {
    const spawnImpl = makeSpawnStub({
      git: () => ({ stdout: 'out', stderr: 'err', code: 7 }),
    });
    const res = await runChild({ cmd: 'git', args: ['x'], spawnImpl });
    assert.equal(res.stdout, 'out');
    assert.equal(res.stderr, 'err');
    assert.equal(res.code, 7);
    assert.equal(res.spawnError, null);
  });
});

describe('makeIsAutoFileEnabled', () => {
  it('binds to the supplied toggle key and defaults to true', () => {
    const reader = makeIsAutoFileEnabled('myToggle');
    assert.equal(reader(undefined), true);
    assert.equal(reader({ delivery: { feedbackLoop: {} } }), true);
    assert.equal(
      reader({ delivery: { feedbackLoop: { myToggle: false } } }),
      false,
    );
    // A different key must not disable it.
    assert.equal(
      reader({ delivery: { feedbackLoop: { otherToggle: false } } }),
      true,
    );
  });
});

describe('probePathStatus', () => {
  it('reports { exists, probeError } from the git cat-file exit code', async () => {
    const present = makeSpawnStub({ git: () => ({ code: 0 }) });
    const absent = makeSpawnStub({ git: () => ({ code: 1 }) });
    assert.deepEqual(
      await probePathStatus({ ref: 'HEAD', path: 'a', spawnImpl: present }),
      { exists: true, probeError: false },
    );
    assert.deepEqual(
      await probePathStatus({ ref: 'HEAD', path: 'a', spawnImpl: absent }),
      { exists: false, probeError: false },
    );
  });

  it('reports a spawn failure as a probe error, not a confirmed-missing file', async () => {
    const spawnImpl = () => {
      throw new Error('git missing');
    };
    assert.deepEqual(
      await probePathStatus({ ref: 'HEAD', path: 'a', spawnImpl }),
      { exists: false, probeError: true },
    );
  });
});

describe('probeMarkerExists', () => {
  it('returns true when gh search returns a non-empty array', async () => {
    const spawnImpl = makeSpawnStub({
      ghSearch: () => ({ stdout: '[{"number":5}]', code: 0 }),
    });
    assert.equal(
      await probeMarkerExists({
        marker: 'm',
        owner: 'o',
        repo: 'r',
        ghPath: 'gh',
        spawnImpl,
      }),
      true,
    );
  });

  it('degrades to false on non-zero exit', async () => {
    const spawnImpl = makeSpawnStub({ ghSearch: () => ({ code: 1 }) });
    assert.equal(
      await probeMarkerExists({
        marker: 'm',
        owner: 'o',
        repo: 'r',
        ghPath: 'gh',
        spawnImpl,
      }),
      false,
    );
  });
});

describe('createFollowUpIssue', () => {
  it('returns the trimmed URL on success', async () => {
    const spawnImpl = makeSpawnStub({
      ghCreate: () => ({ stdout: 'https://x/issues/9\n', code: 0 }),
    });
    const res = await createFollowUpIssue({
      owner: 'o',
      repo: 'r',
      title: 't',
      body: 'b',
      labels: ['l1'],
      ghPath: 'gh',
      spawnImpl,
    });
    assert.equal(res.url, 'https://x/issues/9');
    assert.equal(res.error, null);
  });

  it('captures a non-zero exit as a structured error', async () => {
    const spawnImpl = makeSpawnStub({
      ghCreate: () => ({ stdout: '', stderr: 'nope', code: 1 }),
    });
    const res = await createFollowUpIssue({
      owner: 'o',
      repo: 'r',
      title: 't',
      body: 'b',
      labels: [],
      ghPath: 'gh',
      spawnImpl,
    });
    assert.equal(res.url, null);
    assert.match(res.error, /gh issue create exited 1: nope/);
  });
});

/**
 * The pre-parsed findings every walk below files. Story #5003 made this the
 * ONLY source: the structured-comment read/parse limb (`spec.parseFindings`,
 * `spec.commentMarker`, `provider.getTicketComments`) went with the Epic-era
 * audit-results graduator.
 */
const FINDINGS = () => [
  { severity: 'low', path: 'src/x.js', summary: 'FIND', index: 0 },
];

/** Minimal spec for the parametrized graduate() walk. */
function makeSpec(overrides = {}) {
  return {
    fnName: 'testGraduate',
    isAutoFileEnabled: () => true,
    buildContentMarker: (epicId, finding) =>
      `<!-- f-${epicId}-${finding.index} -->`,
    buildLegacyMarker: (epicId, index) =>
      `<!-- legacy-f-${epicId}-${index} -->`,
    buildCrossRepoLog: ({ routedRepo }) => `xrepo ${routedRepo.repo}`,
    buildFollowUp: ({ finding, source, epicId, idMarker }) => ({
      title: `t ${finding.path}`,
      body: `${idMarker} ${source} ${epicId}`,
      labels: ['lbl'],
    }),
    ...overrides,
  };
}

describe('graduate (parametrized walk)', () => {
  const currentRepo = { owner: 'o', repo: 'r' };

  it('short-circuits when the toggle is disabled', async () => {
    let called = false;
    const spawnImpl = () => {
      called = true;
      throw new Error('unreachable');
    };
    const env = await graduate({
      epicId: 1,
      findings: FINDINGS(),
      provider: {},
      currentRepo,
      spawnImpl,
      spec: makeSpec({ isAutoFileEnabled: () => false }),
    });
    assert.deepEqual(env, {
      filed: [],
      skipped: [{ reason: 'toggle-disabled' }],
      errors: [],
    });
    assert.equal(called, false, 'nothing spawns when toggled off');
  });

  // Story #5003 — findings[] is now the only source. A caller that omits it
  // short-circuits into errors[] rather than silently filing nothing, which
  // is what the deleted structured-comment limb would have degraded to.
  it('short-circuits into errors[] when findings[] is absent', async () => {
    const env = await graduate({
      epicId: 1,
      provider: {},
      currentRepo,
      spec: makeSpec(),
    });
    assert.deepEqual(env.filed, []);
    assert.match(env.errors[0], /findings\[\] is required/);
  });

  it('files a follow-up issue using the injected parser + builder', async () => {
    const provider = {};
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: () => ({ stdout: '[]', code: 0 }),
      ghCreate: () => ({ stdout: 'https://x/issues/1', code: 0 }),
    });
    const env = await graduate({
      epicId: 42,
      findings: FINDINGS(),
      provider,
      currentRepo,
      classifier: () => 'consumer',
      spawnImpl,
      spec: makeSpec(),
    });
    assert.equal(env.filed.length, 1);
    assert.equal(env.filed[0].path, 'src/x.js');
    assert.equal(env.filed[0].url, 'https://x/issues/1');
    // The injected builder body must have been threaded through. Match
    // `issue create` specifically: since Story #4828 the walk also spawns
    // `gh label create` for a label the repo does not carry yet, and both
    // share `create` at args[1].
    const createCall = spawnImpl.calls.find(
      (c) => c.args[0] === 'issue' && c.args[1] === 'create',
    );
    const bodyIdx = createCall.args.indexOf('--body') + 1;
    assert.match(createCall.args[bodyIdx], /<!-- f-42-0 --> consumer 42/);
  });

  it('decorateRecord copies finding-specific fields onto records', async () => {
    const provider = {};
    const spawnImpl = makeSpawnStub({ git: () => ({ code: 1 }) }); // file-removed
    const env = await graduate({
      epicId: 1,
      findings: [
        {
          severity: 'low',
          path: 'src/x.js',
          summary: 's',
          index: 0,
          lens: 'audit-security',
        },
      ],
      provider,
      currentRepo,
      spawnImpl,
      spec: makeSpec({
        decorateRecord: (record, finding) => {
          record.lens = finding.lens;
          return record;
        },
      }),
    });
    assert.equal(env.skipped[0].reason, 'file-removed');
    assert.equal(env.skipped[0].lens, 'audit-security');
  });

  it('skips a framework finding as `unroutable` rather than filing it locally', async () => {
    // Story #5300 — the retired `frameworkRepo ? frameworkRepo : currentRepo`
    // fallback filed framework-owned work into the CONSUMER's tracker when
    // the key was unset. With no framework bucket the finding must be named
    // and deferred, never re-pointed at whatever repo the run stands in.
    const provider = {
      postComment: async () => {},
      getTicketComments: async () => [],
    };
    const created = [];
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghCreate: () => {
        created.push(1);
        return { stdout: 'https://x/issues/1', code: 0 };
      },
    });
    const warnings = [];
    const env = await graduate({
      epicId: 1,
      findings: FINDINGS(),
      provider,
      currentRepo,
      // No frameworkRepo — the bucket is unconfigured.
      classifier: () => 'framework',
      spawnImpl,
      logger: { warn: (m) => warnings.push(m), info() {}, debug() {} },
      spec: makeSpec(),
    });

    assert.equal(env.filed.length, 0, 'nothing may be filed in the wrong repo');
    assert.equal(created.length, 0, 'no issue create may be attempted');
    assert.equal(env.skipped[0]?.reason, 'unroutable');
    assert.ok(
      warnings.some((w) => w.includes('github.followUpRepos.framework')),
      `expected the missing key to be named; got ${JSON.stringify(warnings)}`,
    );
  });

  it('never throws — a failing cross-repo comment upsert lands in errors[]', async () => {
    // `persistCrossRepoDeferred` upserts through the ticketing helper, which
    // reads the existing comments first. A provider that faults there is the
    // failure this asserts degrades into errors[] rather than throwing —
    // Story #5003 removed the up-front `getTicketComments` precondition, so
    // this is now the walk's only provider-fault path.
    const provider = {
      postComment: async () => {},
      getTicketComments: async () => {
        throw new Error('provider down');
      },
    };
    const spawnImpl = makeSpawnStub({ git: () => ({ code: 0 }) });
    const env = await graduate({
      epicId: 1,
      findings: FINDINGS(),
      provider,
      currentRepo,
      frameworkRepo: { owner: 'other', repo: 'framework' },
      classifier: () => 'framework',
      spawnImpl,
      spec: makeSpec(),
    });
    assert.equal(env.filed.length, 0);
    assert.equal(env.skipped[0]?.reason, 'cross-repo-deferred');
    assert.match(env.errors[0], /provider down/);
  });
});

/**
 * Story #4657 — the idempotency probe repair. The wrapped `<!-- … -->`
 * marker form never matched the search index; these pin the delimiter
 * normalization (via the exported `probeMarkerExists` seam), the strong-read
 * confirmation on the would-file path, and the preserved degrade-toward-
 * filing posture (via the exported `graduate` seam). The delimiter stripper
 * and the strong-read helper are internal to the module and exercised
 * through those two public seams rather than imported directly.
 */
describe('probeMarkerExists — query normalization (AC-1)', () => {
  it('never sends comment delimiters to the search index', async () => {
    const spawnImpl = makeSpawnStub({
      ghSearch: () => ({ stdout: '[]', code: 0 }),
    });
    await probeMarkerExists({
      marker: '<!-- retro-proposal-followup: epic-1-abc -->',
      owner: 'o',
      repo: 'r',
      ghPath: 'gh',
      spawnImpl,
    });
    const searchCall = spawnImpl.calls.find((c) => c.args[0] === 'search');
    assert.ok(searchCall, 'a gh search issues call was made');
    for (const arg of searchCall.args) {
      assert.ok(
        !arg.includes('<!--') && !arg.includes('-->'),
        `no search arg carries comment delimiters: ${arg}`,
      );
    }
    // And the query is the bare marker text the index actually matches.
    assert.ok(
      searchCall.args.includes('retro-proposal-followup: epic-1-abc'),
      'the undelimited marker text is the query',
    );
  });
});

describe('graduate — dedup dispatch (Story #4657)', () => {
  const currentRepo = { owner: 'o', repo: 'r' };

  // The content marker the minimal spec embeds, in wrapped form.
  const wrappedMarker = (epicId, index) => `<!-- f-${epicId}-${index} -->`;

  it('AC-2: identifies the marker via the undelimited search query', async () => {
    const provider = {};
    // Match ONLY on the undelimited marker text — a wrapped query never hits.
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: (args) => ({
        stdout: args[2] === 'f-42-0' ? '[{"number":3}]' : '[]',
        code: 0,
      }),
    });
    const env = await graduate({
      epicId: 42,
      findings: FINDINGS(),
      provider,
      currentRepo,
      classifier: () => 'consumer',
      spawnImpl,
      spec: makeSpec(),
    });
    assert.equal(env.filed.length, 0, 'no filing when already present');
    assert.equal(env.skipped[0]?.reason, 'already-filed');
    // The search query carried no delimiters.
    const searchCall = spawnImpl.calls.find((c) => c.args[0] === 'search');
    assert.equal(searchCall.args[2], 'f-42-0');
    // No create was attempted.
    assert.ok(!spawnImpl.calls.some((c) => c.args[1] === 'create'));
  });

  it('AC-3: legacy ordinal markers get the same normalization', async () => {
    const provider = {};
    // Content marker absent; the legacy marker is present — matched only in
    // its undelimited form.
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: (args) => ({
        stdout: args[2] === 'legacy-f-1-0' ? '[{"number":4}]' : '[]',
        code: 0,
      }),
    });
    const env = await graduate({
      epicId: 1,
      findings: FINDINGS(),
      provider,
      currentRepo,
      classifier: () => 'consumer',
      spawnImpl,
      spec: makeSpec(),
    });
    assert.equal(env.filed.length, 0);
    assert.equal(env.skipped[0]?.reason, 'already-filed');
    const legacySearch = spawnImpl.calls.find(
      (c) => c.args[0] === 'search' && c.args[2] === 'legacy-f-1-0',
    );
    assert.ok(legacySearch, 'the legacy marker was probed undelimited');
    assert.ok(
      !legacySearch.args.some((a) => a.includes('<!--') || a.includes('-->')),
      'the legacy query carried no delimiters',
    );
  });

  it('AC-4: a duplicate inside the search-index window is caught by the strong read', async () => {
    const provider = {};
    // Search index misses it (empty), but the strongly-consistent issue list
    // returns a body carrying the marker.
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: () => ({ stdout: '[]', code: 0 }),
      ghList: () => ({
        stdout: JSON.stringify([
          { number: 7, body: `x ${wrappedMarker(42, 0)} y` },
        ]),
        code: 0,
      }),
    });
    const env = await graduate({
      epicId: 42,
      findings: FINDINGS(),
      provider,
      currentRepo,
      classifier: () => 'consumer',
      spawnImpl,
      spec: makeSpec(),
    });
    assert.equal(env.filed.length, 0, 'the window duplicate is not re-filed');
    assert.equal(env.skipped[0]?.reason, 'already-filed');
    assert.ok(
      !spawnImpl.calls.some(
        (c) => c.args[0] === 'issue' && c.args[1] === 'create',
      ),
      'createFollowUpIssue was never spawned',
    );
    // The strong read is a strongly-consistent (`--state all`), label-scoped
    // `gh issue list` — scoped by the labels the follow-up would carry.
    const listCall = spawnImpl.calls.find(
      (c) => c.args[0] === 'issue' && c.args[1] === 'list',
    );
    assert.ok(listCall, 'a gh issue list strong read ran');
    assert.ok(
      listCall.args.includes('--state') && listCall.args.includes('all'),
    );
    assert.ok(
      listCall.args.includes('--label') && listCall.args.includes('lbl'),
    );
  });

  it('AC-5: the strong read runs only on the would-file path', async () => {
    const provider = {};
    // Search already reports a match → no gh issue list spawn. The match
    // carries no `state`, which since Story #4837 is deliberately NOT read as
    // open: an unknown state never authorizes an edit, so this stays a skip.
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: () => ({ stdout: '[{"number":1}]', code: 0 }),
    });
    const env = await graduate({
      epicId: 42,
      findings: FINDINGS(),
      provider,
      currentRepo,
      classifier: () => 'consumer',
      spawnImpl,
      spec: makeSpec(),
    });
    assert.equal(env.skipped[0]?.reason, 'already-filed');
    assert.ok(
      !spawnImpl.calls.some(
        (c) => c.args[0] === 'issue' && c.args[1] === 'list',
      ),
      'no gh issue list spawn when the search probe already matched',
    );
  });

  it('AC-7: an undecidable probe still files rather than swallowing', async () => {
    const provider = {};
    // Both read probes error; only the create succeeds.
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: () => {
        throw new Error('search down');
      },
      ghList: () => {
        throw new Error('list down');
      },
      ghCreate: () => ({ stdout: 'https://x/issues/11', code: 0 }),
    });
    const env = await graduate({
      epicId: 42,
      findings: FINDINGS(),
      provider,
      currentRepo,
      classifier: () => 'consumer',
      spawnImpl,
      spec: makeSpec(),
    });
    assert.equal(env.filed.length, 1, 'degrade-toward-filing preserved');
    assert.equal(env.filed[0].url, 'https://x/issues/11');
  });
});

/**
 * Story #4837 — a recurrence updates the issue it already filed.
 *
 * Dedup used to mean "do not file a second issue this run". With an
 * anchor-free identity it means one issue per finding over time, so the
 * loop's job on every subsequent sighting is to keep that issue current
 * rather than to fall silent (or, before the identity fix, to open issue
 * N+1 whose only new information was that the count went up).
 */
describe('graduate — recurrence updates the open follow-up (Story #4837)', () => {
  const currentRepo = { owner: 'o', repo: 'r' };
  const provider = {};

  it('edits the existing open issue in place and never creates a second one', async () => {
    // Arrange — the search index already holds an OPEN follow-up.
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: () => ({
        stdout: JSON.stringify([
          { number: 4836, state: 'open', url: 'https://x/issues/4836' },
        ]),
        code: 0,
      }),
      // `gh issue edit` echoes the edited issue's URL, as the real CLI does.
      ghEdit: () => ({ stdout: 'https://x/issues/4836\n', code: 0 }),
    });

    // Act.
    const env = await graduate({
      epicId: 42,
      findings: FINDINGS(),
      provider,
      currentRepo,
      classifier: () => 'consumer',
      spawnImpl,
      spec: makeSpec(),
    });

    // Assert — one live write, and it was an edit of #4836.
    assert.equal(env.filed.length, 1);
    assert.equal(env.filed[0].action, 'updated');
    assert.equal(env.filed[0].issueNumber, 4836);
    assert.equal(env.filed[0].url, 'https://x/issues/4836');
    assert.ok(
      !spawnImpl.calls.some(
        (c) => c.args[0] === 'issue' && c.args[1] === 'create',
      ),
      'no second issue was created for a finding already filed',
    );
    const editCall = spawnImpl.calls.find(
      (c) => c.args[0] === 'issue' && c.args[1] === 'edit',
    );
    assert.ok(editCall, 'the existing issue was edited');
    assert.equal(editCall.args[2], '4836');
    const bodyIdx = editCall.args.indexOf('--body') + 1;
    assert.match(
      editCall.args[bodyIdx],
      /<!-- f-42-0 --> consumer 42/,
      'the edit writes the freshly rendered body, not the stale one',
    );
  });

  it('leaves a CLOSED follow-up alone — decided is not reopened, nor re-filed', async () => {
    // Arrange — the only match is closed (the #4833/#4834 shape).
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: () => ({
        stdout: JSON.stringify([
          { number: 4834, state: 'closed', url: 'https://x/issues/4834' },
        ]),
        code: 0,
      }),
    });

    // Act.
    const env = await graduate({
      epicId: 42,
      findings: FINDINGS(),
      provider,
      currentRepo,
      classifier: () => 'consumer',
      spawnImpl,
      spec: makeSpec(),
    });

    // Assert — nothing was written at all.
    assert.equal(env.filed.length, 0);
    assert.equal(env.skipped[0]?.reason, 'already-filed');
    assert.ok(
      !spawnImpl.calls.some(
        (c) =>
          c.args[0] === 'issue' &&
          (c.args[1] === 'edit' || c.args[1] === 'create'),
      ),
      'a closed follow-up is neither edited nor duplicated',
    );
  });

  it('updates a match the eventually-consistent search missed but the strong read found', async () => {
    // Arrange — search index cold; the strongly-consistent list has it open.
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: () => ({ stdout: '[]', code: 0 }),
      ghList: () => ({
        stdout: JSON.stringify([
          {
            number: 51,
            body: 'preamble <!-- f-42-0 --> tail',
            state: 'OPEN',
            url: 'https://x/issues/51',
          },
        ]),
        code: 0,
      }),
    });

    // Act.
    const env = await graduate({
      epicId: 42,
      findings: FINDINGS(),
      provider,
      currentRepo,
      classifier: () => 'consumer',
      spawnImpl,
      spec: makeSpec(),
    });

    // Assert.
    assert.equal(env.filed.length, 1);
    assert.equal(env.filed[0].action, 'updated');
    assert.equal(env.filed[0].issueNumber, 51);
    assert.ok(
      !spawnImpl.calls.some(
        (c) => c.args[0] === 'issue' && c.args[1] === 'create',
      ),
    );
  });

  it('accepts any of the spec-supplied match tokens as proof of a prior filing', async () => {
    // Arrange — the stored body carries an OLD marker shape only. Without a
    // match-token seam, a marker-format change re-files the whole backlog.
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: () => ({ stdout: '[]', code: 0 }),
      ghList: () => ({
        stdout: JSON.stringify([
          {
            number: 88,
            body: '<!-- legacy-shape-42-0 -->',
            state: 'open',
            url: 'https://x/issues/88',
          },
        ]),
        code: 0,
      }),
    });

    // Act.
    const env = await graduate({
      epicId: 42,
      findings: FINDINGS(),
      provider,
      currentRepo,
      classifier: () => 'consumer',
      spawnImpl,
      spec: makeSpec({
        buildMatchTokens: ({ contentMarker }) => [
          contentMarker,
          '<!-- legacy-shape-42-0 -->',
        ],
      }),
    });

    // Assert.
    assert.equal(env.filed[0]?.issueNumber, 88);
    assert.ok(
      !spawnImpl.calls.some(
        (c) => c.args[0] === 'issue' && c.args[1] === 'create',
      ),
      'the pre-cutover filing was recognized, not duplicated',
    );
  });

  it('a failed edit lands in errors[] rather than throwing', async () => {
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: () => ({
        stdout: JSON.stringify([
          { number: 9, state: 'open', url: 'https://x/issues/9' },
        ]),
        code: 0,
      }),
      ghEdit: () => ({ stdout: '', stderr: 'nope', code: 1 }),
    });
    const env = await graduate({
      epicId: 42,
      findings: FINDINGS(),
      provider,
      currentRepo,
      classifier: () => 'consumer',
      spawnImpl,
      spec: makeSpec(),
    });
    assert.equal(env.filed.length, 0);
    assert.match(env.errors[0], /gh issue edit exited 1: nope/);
  });
});

/**
 * Story #4837 — the blast-radius guard.
 *
 * Issues #4833 and #4834 were created against the live `dsj1984/mandrel`
 * tracker by a development run of this walk, from fixture findings anchored
 * to `epic-101` / `epic-777`. Nothing distinguished that from a real close,
 * so the only thing between a test and the production tracker was the author
 * remembering to stub `spawnImpl`.
 *
 * Every case below is a REFUSAL case, deliberately: a test asserting that a
 * production-shaped context is allowed would, if the guard were wrong, be
 * the very live call this Story exists to prevent. The allow path is covered
 * throughout this file instead — every suite above injects `spawnImpl` and
 * files successfully, which is exactly the sanctioned seam.
 *
 * `maxFilingsPerRun: 0` bounds the blast radius further: were the guard to
 * fail to fire, the cap short-circuits before any label mint or issue create,
 * so a broken guard surfaces as a `cap-reached` reason (a failing assertion)
 * rather than as a written issue.
 */
describe('graduate — live-API guard fails closed (Story #4837)', () => {
  const currentRepo = { owner: 'o', repo: 'r' };
  const provider = {};

  /** Run the walk with NO injected spawn seam. */
  const walkWithoutSeam = (overrides) =>
    graduate({
      epicId: 42,
      findings: FINDINGS(),
      provider,
      currentRepo,
      classifier: () => 'consumer',
      maxFilingsPerRun: 0,
      spec: makeSpec(),
      ...overrides,
    });

  it('refuses this very suite: a node:test context with the real spawn files nothing', async () => {
    const warnings = [];
    const env = await walkWithoutSeam({
      logger: { warn: (m) => warnings.push(m) },
    });
    assert.equal(env.filed.length, 0);
    assert.equal(
      env.skipped[0]?.reason,
      'live-api-guard',
      'the guard decides before the walk spends a single child process',
    );
    assert.match(warnings[0] ?? '', /live GitHub API/);
  });

  it('refuses an explicitly test-flagged context', async () => {
    const env = await walkWithoutSeam({
      env: { NODE_TEST_CONTEXT: 'child' },
      execArgv: [],
    });
    assert.equal(env.skipped[0]?.reason, 'live-api-guard');
  });

  it('refuses a --test runner process', async () => {
    const env = await walkWithoutSeam({ env: {}, execArgv: ['--test'] });
    assert.equal(env.skipped[0]?.reason, 'live-api-guard');
  });

  it('refuses a development context that declared itself via NODE_ENV', async () => {
    const env = await walkWithoutSeam({
      env: { NODE_ENV: 'development' },
      execArgv: [],
    });
    assert.equal(env.skipped[0]?.reason, 'live-api-guard');
  });

  it('refuses a suite environment stamped NODE_ENV=test', async () => {
    // `lib/test-env.js` stamps this on every process the runner spawns.
    const env = await walkWithoutSeam({
      env: { NODE_ENV: 'test' },
      execArgv: [],
    });
    assert.equal(env.skipped[0]?.reason, 'live-api-guard');
  });

  it('fails CLOSED on an unreadable env — undecidable is not production', async () => {
    const env = await walkWithoutSeam({ env: null, execArgv: [] });
    assert.equal(env.skipped[0]?.reason, 'live-api-guard');
  });

  it('fails CLOSED when execArgv cannot be read', async () => {
    const env = await walkWithoutSeam({ env: {}, execArgv: null });
    assert.equal(env.skipped[0]?.reason, 'live-api-guard');
  });

  it('fails CLOSED when reading the env throws', async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('env unreadable');
        },
      },
    );
    const env = await walkWithoutSeam({ env: hostile, execArgv: [] });
    assert.equal(env.skipped[0]?.reason, 'live-api-guard');
  });

  it('an injected spawn seam is always allowed — it cannot reach the API', async () => {
    const spawnImpl = makeSpawnStub({
      git: () => ({ code: 0 }),
      ghSearch: () => ({ stdout: '[]', code: 0 }),
      ghCreate: () => ({ stdout: 'https://x/issues/2', code: 0 }),
    });
    const env = await graduate({
      epicId: 42,
      findings: FINDINGS(),
      provider,
      currentRepo,
      classifier: () => 'consumer',
      spawnImpl,
      spec: makeSpec(),
    });
    assert.equal(env.filed[0]?.action, 'created');
  });

  it('the refusal is per-finding and decorated, never a silent empty envelope', async () => {
    const env = await walkWithoutSeam({
      findings: [
        { severity: 'low', path: 'src/a.js', summary: 's', index: 0 },
        { severity: 'low', path: 'src/b.js', summary: 's', index: 1 },
      ],
    });
    assert.equal(env.skipped.length, 2);
    assert.deepEqual(
      env.skipped.map((s) => s.path),
      ['src/a.js', 'src/b.js'],
    );
  });
});
