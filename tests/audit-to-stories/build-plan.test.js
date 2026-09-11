import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  __testing,
  runAuditToStories,
} from '../../.agents/scripts/audit-to-stories.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

/**
 * Story #4780, AC-6 — `buildPlan` scored CRAP 110 despite 21 audit-to-stories
 * test files existing: not one of them reached the function that turns audit
 * findings into a dedup-checked plan. This file closes that gap, and covers
 * the two passes that hang off it (`runAuto`, `buildAndGateStories`).
 *
 * The provider, the classifier, and the ledger reconciler are injected
 * through `buildPlan`'s optional final `deps` parameter
 * (`.agents/rules/test-seams.md` rules 1 and 5) — plain functions, no module
 * mocking — so no GitHub lookup happens and no committed ledger is written.
 * The report glob and the report reads run against a real temp directory, so
 * `collectReportPaths` and `readReports` are exercised for real.
 */

const {
  buildPlan,
  buildAndGateStories,
  runAuto,
  meetsSeverity,
  wireEdges,
  parseIssueMap,
} = __testing;

const FIXTURES = path.join(import.meta.dirname, 'fixtures');

let workspace;
let reportGlob;
let emptyGlob;

before(() => {
  workspace = makeTempDir('audit-build-plan-');
  const reports = path.join(workspace, 'audits');
  fs.mkdirSync(reports, { recursive: true });
  for (const name of fs.readdirSync(FIXTURES)) {
    fs.copyFileSync(path.join(FIXTURES, name), path.join(reports, name));
  }
  // The fan-out report is deliberately excluded by `collectReportPaths`.
  fs.writeFileSync(
    path.join(reports, 'audit-fan-out-results.md'),
    '# Fan-out\n',
  );
  reportGlob = path.join(reports, 'audit-*-results.md');
  emptyGlob = path.join(workspace, 'nowhere', 'audit-*-results.md');
});

after(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

const silent = { logger: { warn: () => {} } };

describe('buildPlan', () => {
  it('returns a zero envelope when the glob matches no report', async () => {
    const plan = await buildPlan(
      { glob: emptyGlob, useProvider: false },
      silent,
    );
    assert.deepEqual(plan.sourceReports, []);
    assert.deepEqual(plan.findings, []);
    assert.deepEqual(plan.groups, []);
    assert.deepEqual(plan.classifications, []);
    assert.equal(plan.severityThreshold, 'all');
    assert.deepEqual(plan.summary, {
      totalFindings: 0,
      filtered: 0,
      create: 0,
      skipOpen: 0,
      skipReoccurring: 0,
      reportFailures: [],
    });
  });

  it('parses every report under the glob, excluding the fan-out report', async () => {
    const plan = await buildPlan(
      { glob: reportGlob, useProvider: false },
      silent,
    );
    assert.ok(plan.sourceReports.length >= 3);
    assert.equal(
      plan.sourceReports.some((p) => p.endsWith('audit-fan-out-results.md')),
      false,
    );
    assert.ok(plan.summary.totalFindings > 0);
    assert.ok(plan.groups.length > 0);
  });

  it('stamps every finding with a fingerprint and tallies by severity', async () => {
    const plan = await buildPlan(
      { glob: reportGlob, useProvider: false },
      silent,
    );
    for (const finding of plan.findings) {
      assert.equal(typeof finding.fingerprint?.full, 'string');
    }
    const tally = plan.summary.tally;
    assert.equal(
      tally.critical + tally.high + tally.medium + tally.low + tally.unknown,
      plan.summary.filtered,
    );
  });

  it('filters findings below the severity threshold', async () => {
    const all = await buildPlan(
      { glob: reportGlob, useProvider: false },
      silent,
    );
    const high = await buildPlan(
      { glob: reportGlob, severity: 'high', useProvider: false },
      silent,
    );
    assert.equal(high.severityThreshold, 'high');
    assert.ok(high.summary.filtered <= all.summary.filtered);
    assert.equal(high.summary.totalFindings, all.summary.totalFindings);
    for (const finding of high.findings) {
      assert.ok(meetsSeverity(finding, 'high'));
    }
  });

  it('classifies every group as create and warns loudly under --no-provider', async () => {
    const warns = [];
    const plan = await buildPlan(
      { glob: reportGlob, useProvider: false },
      { logger: { warn: (m) => warns.push(m) } },
    );
    assert.equal(plan.summary.dedupApplied, false);
    assert.ok(plan.classifications.every((c) => c.action === 'create'));
    assert.match(warns[0], /dedup skipped \(--no-provider\)/);
    assert.match(warns[0], /may open\s+duplicates/);
  });

  it('warns loudly when the provider exposes no search port', async () => {
    const warns = [];
    const plan = await buildPlan(
      { glob: reportGlob, useProvider: true },
      {
        loadProviderImpl: async () => null,
        logger: { warn: (m) => warns.push(m) },
      },
    );
    assert.equal(plan.summary.dedupApplied, false);
    assert.match(warns[0], /dedup skipped \(no provider port\)/);
    assert.match(warns[0], /WILL open duplicates/);
  });

  it('adopts the classifier verdict when a provider resolves', async () => {
    const plan = await buildPlan(
      { glob: reportGlob, useProvider: true },
      {
        ...silent,
        loadProviderImpl: async () => ({ searchCandidates: async () => [] }),
        classifyGroupsImpl: async ({ groups }) => ({
          classifications: groups.map((g) => ({
            group: g,
            action: 'skip-open',
            matchedIssues: [{ number: 42, state: 'open' }],
            matchedFingerprints: [],
          })),
          summary: { create: 0, skipOpen: groups.length, skipReoccurring: 0 },
        }),
      },
    );
    assert.equal(plan.summary.dedupApplied, true);
    assert.equal(plan.summary.skipOpen, plan.groups.length);
    assert.ok(plan.classifications.every((c) => c.action === 'skip-open'));
  });

  it('names every group whose dedup lookup degraded', async () => {
    const warns = [];
    await buildPlan(
      { glob: reportGlob, useProvider: true },
      {
        loadProviderImpl: async () => ({}),
        classifyGroupsImpl: async ({ groups }) => ({
          classifications: groups.map((g) => ({ group: g, action: 'create' })),
          summary: {
            create: groups.length,
            skipOpen: 0,
            skipReoccurring: 0,
            dedupDegraded: {
              count: 1,
              groups: [{ group: 'auth', reason: 'HTTP 422' }],
            },
          },
        }),
        logger: { warn: (m) => warns.push(m) },
      },
    );
    assert.match(warns[0], /dedup degraded for 1 group\(s\)/);
    assert.match(warns[0], /- auth: HTTP 422/);
  });

  it('reports the ledger and flips fully-suppressed groups to skip-accepted-risk', async () => {
    const reconcileCalls = [];
    const plan = await buildPlan(
      { glob: reportGlob, useProvider: false, ledger: { path: '/led.json' } },
      {
        ...silent,
        reconcileScanLedgerImpl: (args) => {
          reconcileCalls.push(args);
          return new Set(
            args.findings.map((f) => f.fingerprint?.full).filter(Boolean),
          );
        },
      },
    );
    assert.equal(reconcileCalls[0].ledgerPath, '/led.json');
    assert.equal(reconcileCalls[0].write, true);
    assert.equal(plan.summary.ledger.path, '/led.json');
    assert.ok(plan.summary.ledger.suppressed > 0);
    assert.ok(
      plan.classifications.every((c) => c.action === 'skip-accepted-risk'),
    );
  });

  it('leaves classifications alone when the ledger suppresses nothing', async () => {
    const plan = await buildPlan(
      { glob: reportGlob, useProvider: false, ledger: { write: false } },
      { ...silent, reconcileScanLedgerImpl: () => new Set() },
    );
    assert.equal(plan.summary.ledger.suppressed, 0);
    assert.ok(plan.classifications.every((c) => c.action === 'create'));
  });

  it('honours ledger.write === false as a read-only reconcile', async () => {
    let seen;
    await buildPlan(
      { glob: reportGlob, useProvider: false, ledger: { write: false } },
      {
        ...silent,
        reconcileScanLedgerImpl: (args) => {
          seen = args;
          return new Set();
        },
      },
    );
    assert.equal(seen.write, false);
  });

  it('omits the ledger summary entirely when no ledger is requested', async () => {
    const plan = await buildPlan(
      { glob: reportGlob, useProvider: false },
      silent,
    );
    assert.equal('ledger' in plan.summary, false);
  });
});

describe('buildAndGateStories', () => {
  it('builds one gated Story per eligible group', async () => {
    const plan = await buildPlan(
      { glob: reportGlob, useProvider: false },
      silent,
    );
    const stories = buildAndGateStories(
      plan.classifications.map((c) => c.group),
      plan.edges ?? [],
    );
    assert.equal(stories.length, plan.classifications.length);
    for (const story of stories) {
      assert.equal(typeof story.title, 'string');
      assert.ok(Array.isArray(story.labels));
      assert.match(story.body, /## Acceptance/);
    }
  });

  it('accepts an empty batch', () => {
    assert.deepEqual(buildAndGateStories([], []), []);
  });
});

describe('runAuto', () => {
  it('resolves the floor, reports totals, and files nothing under --dry-run', async () => {
    const { summary, stories } = await runAuto({
      glob: reportGlob,
      severity: 'high',
      dryRun: true,
      useProvider: false,
      ledgerPath: path.join(workspace, 'ledger.json'),
    });
    assert.equal(summary.mode, 'auto');
    assert.equal(summary.dryRun, true);
    assert.equal(summary.severityFloor, 'high');
    assert.deepEqual(stories, []);
    assert.equal(summary.totals.create, summary.totals.groups);
    assert.equal(summary.totals.skipOpen, 0);
    assert.deepEqual(summary.reDetected, []);
    assert.equal(
      fs.existsSync(path.join(workspace, 'ledger.json')),
      false,
      'a dry run must not write the ledger',
    );
  });

  it('returns the create-eligible Story payloads outside --dry-run', async () => {
    const { summary, stories } = await runAuto({
      glob: reportGlob,
      severity: 'low',
      dryRun: false,
      useProvider: false,
      ledgerPath: path.join(workspace, 'ledger-write.json'),
    });
    assert.equal(summary.dryRun, false);
    assert.equal(stories.length, summary.totals.create);
    assert.equal(
      fs.existsSync(path.join(workspace, 'ledger-write.json')),
      true,
    );
  });

  it('reports an empty run without throwing', async () => {
    const { summary, stories } = await runAuto({
      glob: emptyGlob,
      severity: 'high',
      dryRun: true,
      useProvider: false,
    });
    assert.deepEqual(summary.totals, {
      findings: 0,
      filtered: 0,
      groups: 0,
      create: 0,
      skipOpen: 0,
      skipReoccurring: 0,
      suppressedByLedger: 0,
    });
    assert.deepEqual(stories, []);
  });
});

describe('runAuditToStories (sub-command dispatch)', () => {
  function harness() {
    const persisted = [];
    const written = [];
    const seen = {};
    return {
      persisted,
      written,
      seen,
      deps: {
        buildPlanImpl: async (params) => {
          seen.buildPlan = params;
          return {
            groups: ['g'],
            findings: ['f'],
            sourceReports: ['r'],
            edges: [],
          };
        },
        runAutoImpl: async (params) => {
          seen.runAuto = params;
          return { summary: { mode: 'auto' }, stories: [] };
        },
        loadPlanImpl: (planPath) => {
          seen.loadPlan = planPath;
          return {
            groups: ['g'],
            findings: ['f'],
            sourceReports: ['r'],
            edges: [{ fromGroupKey: 'a', toGroupKey: 'b' }],
            classifications: [
              { action: 'create', group: 'g1' },
              { action: 'skip-open', group: 'g2' },
            ],
          };
        },
        buildAndGateStoriesImpl: (eligible, edges) => {
          seen.gate = { eligible, edges };
          return [
            {
              title: 'T',
              labels: ['a', 'b'],
              body: 'BODY',
              groupKey: 'g1',
              dependsOn: ['g0'],
            },
          ];
        },
        buildPlanSeedMarkdownImpl: (args) => {
          seen.seed = args;
          return '# seed\n';
        },
        wireEdgesImpl: async (params) => {
          seen.wireEdges = params;
          return { storiesWired: 1, bodiesUpdated: 1, edgesDeclared: 1 };
        },
        persistImpl: (text, outPath) => persisted.push({ text, outPath }),
        stdout: { write: (s) => written.push(s) },
      },
    };
  }

  it('throws the usage error when no sub-command is given', async () => {
    await assert.rejects(
      () => runAuditToStories([], harness().deps),
      /Usage: node audit-to-stories\.js \(--scan \| --emit-plan-seed \| --emit-stories \| --wire-edges\)/,
    );
  });

  it('--wire-edges threads the plan and the parsed issue map (Story #5044)', async () => {
    const h = harness();
    await runAuditToStories(
      [
        '--wire-edges',
        '--plan',
        'plan.json',
        '--ids',
        '{"a": 101, "b": 102}',
        '--out',
        'wired.json',
      ],
      h.deps,
    );
    assert.equal(h.seen.loadPlan, 'plan.json');
    assert.deepEqual(h.seen.wireEdges.issueByGroupKey, { a: 101, b: 102 });
    assert.equal(h.seen.wireEdges.plan.edges.length, 1);
    assert.deepEqual(h.persisted.at(-1), {
      text: JSON.stringify(
        { storiesWired: 1, bodiesUpdated: 1, edgesDeclared: 1 },
        null,
        2,
      ),
      outPath: 'wired.json',
    });
  });

  it('--auto persists the summary and adds a trailing newline on stdout', async () => {
    const h = harness();
    await runAuditToStories(
      [
        '--auto',
        '--dry-run',
        '--glob',
        'g/*.md',
        '--severity',
        'high',
        '--ledger',
        'l.json',
      ],
      h.deps,
    );
    assert.deepEqual(h.seen.runAuto, {
      glob: 'g/*.md',
      severity: 'high',
      dryRun: true,
      useProvider: true,
      issuesFile: undefined,
      ledgerPath: 'l.json',
      ledgerCommit: undefined,
    });
    assert.deepEqual(JSON.parse(h.persisted[0].text), { mode: 'auto' });
    assert.equal(h.persisted[0].outPath, undefined);
    assert.deepEqual(h.written, ['\n']);
  });

  it('--auto with --out writes to the file and skips the stdout newline', async () => {
    const h = harness();
    await runAuditToStories(['--auto', '--out', 'summary.json'], h.deps);
    assert.equal(h.persisted[0].outPath, 'summary.json');
    assert.deepEqual(h.written, []);
  });

  it('--scan persists the plan envelope and honours --no-provider', async () => {
    const h = harness();
    await runAuditToStories(['--scan', '--no-provider'], h.deps);
    assert.equal(h.seen.buildPlan.useProvider, false);
    assert.equal(JSON.parse(h.persisted[0].text).groups.length, 1);
    assert.deepEqual(h.written, ['\n']);
  });

  it('--emit-plan-seed renders the seed document from a loaded plan', async () => {
    const h = harness();
    await runAuditToStories(
      ['--emit-plan-seed', '--plan', 'plan.json', '--out', 'seed.md'],
      h.deps,
    );
    assert.equal(h.seen.loadPlan, 'plan.json');
    assert.deepEqual(h.seen.seed, {
      groups: ['g'],
      findings: ['f'],
      sourceReports: ['r'],
    });
    assert.deepEqual(h.persisted[0], { text: '# seed\n', outPath: 'seed.md' });
    assert.deepEqual(h.written, []);
  });

  it('--emit-stories gates only the create-eligible groups and renders prose by default', async () => {
    const h = harness();
    await runAuditToStories(['--emit-stories', '--plan', 'plan.json'], h.deps);
    assert.deepEqual(h.seen.gate.eligible, ['g1']);
    assert.deepEqual(h.seen.gate.edges, [
      { fromGroupKey: 'a', toGroupKey: 'b' },
    ]);
    // The group edges no longer ride the body at emit time — the blockers have
    // no issue numbers yet — so the transcript surfaces them here, which is
    // what a human driving the create pass replays through --wire-edges.
    assert.match(
      h.persisted[0].text,
      /--- story 1 ---\nTitle: T\nLabels: a, b\nGroup key: g1\nDepends on group\(s\): g0\n\nBODY/,
    );
  });

  it('--emit-stories --json emits the raw Story objects', async () => {
    const h = harness();
    await runAuditToStories(
      ['--emit-stories', '--plan', 'plan.json', '--json'],
      h.deps,
    );
    assert.deepEqual(JSON.parse(h.persisted[0].text), [
      {
        title: 'T',
        labels: ['a', 'b'],
        body: 'BODY',
        groupKey: 'g1',
        dependsOn: ['g0'],
      },
    ]);
  });

  it('--auto takes precedence over --scan when both are present', async () => {
    const h = harness();
    await runAuditToStories(['--auto', '--scan'], h.deps);
    assert.ok(h.seen.runAuto);
    assert.equal(h.seen.buildPlan, undefined);
  });

  /**
   * Story #5139 — the container Epic is the DEFAULT grouping for an audit
   * sweep, so both output paths must say so. The `--json` form deliberately
   * stays a bare array (a documented shape the test above asserts); the Epic
   * is an operator decision the workflow's Phase 4 stop owns.
   */
  it('--emit-stories carries the grouping block in the prose transcript', async () => {
    const h = harness();
    await runAuditToStories(['--emit-stories', '--plan', 'plan.json'], h.deps);
    assert.match(h.persisted[0].text, /--- grouping ---/);
  });

  it('says no Epic is needed when the sweep is below the threshold', async () => {
    const h = harness();
    // One create-eligible group — under the 3-Story container threshold.
    await runAuditToStories(['--emit-stories', '--plan', 'plan.json'], h.deps);
    assert.match(h.persisted[0].text, /below the 3-Story threshold/);
  });

  it('--emit-stories --json stays a bare array (shape unchanged)', async () => {
    const h = harness();
    await runAuditToStories(
      ['--emit-stories', '--plan', 'plan.json', '--json'],
      h.deps,
    );
    assert.ok(Array.isArray(JSON.parse(h.persisted[0].text)));
  });
});

// ---------------------------------------------------------------------------
// Story #5044 — the --wire-edges second pass
// ---------------------------------------------------------------------------

describe('parseIssueMap', () => {
  it('accepts inline JSON', () => {
    assert.deepEqual(parseIssueMap('{"a": 101, "b": 102}'), { a: 101, b: 102 });
  });

  it('accepts a path to a JSON file', () => {
    const dir = makeTempDir('audit-wire-ids');
    const file = path.join(dir, 'ids.json');
    fs.writeFileSync(file, JSON.stringify({ a: 7 }));
    assert.deepEqual(parseIssueMap(file), { a: 7 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to run without ids rather than silently wiring nothing', () => {
    // A missing map would resolve every edge to undefined and report a clean
    // "0 edges declared" — a green run that wired nothing at all.
    assert.throws(
      () => parseIssueMap(undefined),
      /--wire-edges requires --ids/,
    );
  });

  it('rejects a value that is not a positive issue number', () => {
    assert.throws(
      () => parseIssueMap('{"a": "nope"}'),
      /not a positive issue number/,
    );
    assert.throws(
      () => parseIssueMap('{"a": 0}'),
      /not a positive issue number/,
    );
  });
});

describe('wireEdges', () => {
  const plan = {
    edges: [{ fromGroupKey: 'b', toGroupKey: 'a' }],
    classifications: [
      { action: 'create', group: { groupKey: 'a' } },
      { action: 'create', group: { groupKey: 'b' } },
      { action: 'skip-open', group: { groupKey: 'c' } },
    ],
  };

  // Story #5305 — the pass also records the ledger, so every case here injects
  // the record seam: the real one would write the repo's committed
  // `baselines/audit-ledger.json` from a unit test.
  const recordSeam = (sink) => (args) => {
    sink?.push(args);
    return { path: 'baselines/audit-ledger.json', written: true, filed: 0 };
  };

  it('passes only the create-eligible groups and an updateBody bound to updateTicket', async () => {
    const patched = [];
    const recorded = [];
    let seen;
    const summary = await wireEdges(
      { plan, issueByGroupKey: { a: 101, b: 102 } },
      {
        recordFiledIssuesImpl: recordSeam(recorded),
        loadProviderImpl: async () => ({
          updateTicket: (issueNumber, mutations) => {
            patched.push({ issueNumber, body: mutations.body });
            return Promise.resolve();
          },
        }),
        wireImpl: async (args) => {
          seen = args;
          await args.updateBody(102, 'NEW BODY');
          return { storiesWired: 1 };
        },
      },
    );

    assert.deepEqual(
      seen.groups.map((g) => g.groupKey),
      ['a', 'b'],
      'a skip-open group has no issue of this run to wire',
    );
    assert.deepEqual(seen.edges, plan.edges);
    assert.deepEqual(seen.issueByGroupKey, { a: 101, b: 102 });
    assert.deepEqual(patched, [{ issueNumber: 102, body: 'NEW BODY' }]);
    assert.deepEqual(
      recorded.map((r) => r.issueByGroupKey),
      [{ a: 101, b: 102 }],
      'the ledger record sees the same map the wiring does',
    );
    assert.deepEqual(summary, {
      storiesWired: 1,
      ledger: { path: 'baselines/audit-ledger.json', written: true, filed: 0 },
    });
  });

  it('fails loudly when the provider cannot rewrite a body', async () => {
    // Without updateTicket the footers never land, and the native mirroring
    // alone would leave /mandrel-deliver's body-parsing resolver blind to the order.
    await assert.rejects(
      () =>
        wireEdges(
          { plan, issueByGroupKey: { a: 101 } },
          {
            recordFiledIssuesImpl: recordSeam(),
            loadProviderImpl: async () => ({}),
          },
        ),
      /--wire-edges needs a provider exposing updateTicket/,
    );
  });
});

// Story #5281 — the two report shapes an unattended sweep meets, driven
// through `buildPlan` so the cross-check itself (not just the parser) is what
// is being asserted.
describe('buildPlan cross-check — unattended report shapes', () => {
  let dir;
  const write = (name, body) => {
    fs.writeFileSync(path.join(dir, name), body);
    return path.join(dir, 'audit-*-results.md');
  };

  before(() => {
    dir = makeTempDir('audit-cross-check-');
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes a report whose only extra headings are empty grouping headers', async () => {
    const glob = write(
      'audit-accessibility-results.md',
      [
        '## Executive Summary',
        '',
        'Severity tally: Critical 0 / High 1 / Medium 0 / Low 0',
        '',
        '## Detailed Findings',
        '',
        '### Perceivable',
        '',
        '#### `src/a.jsx` — Icon button has no accessible name',
        '',
        '- **Severity**: High',
        '- **Location**: src/a.jsx:12',
        '- **Recommendation**: Add an aria-label.',
        '',
        '### Robust',
        '',
        '_No findings._',
        '',
      ].join('\n'),
    );

    const plan = await buildPlan({ glob, useProvider: false }, silent);
    assert.deepEqual(plan.summary.reportFailures, []);
    assert.equal(plan.summary.totalFindings, 1);
  });

  it('fails a report declaring the tally twice, naming both lines', async () => {
    const glob = write(
      'audit-accessibility-results.md',
      [
        '## Executive Summary',
        '',
        'Severity tally: Critical 0 / High 1 / Medium 0 / Low 0',
        '',
        '## Detailed Findings',
        '',
        '### `src/a.jsx` — Icon button has no accessible name',
        '',
        '- **Severity**: High',
        '- **Location**: src/a.jsx:12',
        '',
        '## Remediation notes',
        '',
        'Last cycle it said Severity tally: Critical 1 / High 9 / Medium 9 / Low 9.',
        '',
      ].join('\n'),
    );

    const warnings = [];
    const plan = await buildPlan(
      { glob, useProvider: false },
      { logger: { warn: (m) => warnings.push(String(m)) } },
    );
    const failure = plan.summary.reportFailures.find(
      (f) => f.kind === 'duplicate-tally',
    );
    assert.ok(
      failure,
      `expected a duplicate-tally failure: ${JSON.stringify(plan.summary.reportFailures)}`,
    );
    assert.equal(failure.tallyLines.length, 2);
    // The operator-facing block names both declarations rather than comparing
    // the parse against an arbitrary one of them.
    const block = warnings.join('\n');
    assert.match(block, /duplicate-tally/);
    assert.match(block, /High 1 \/ Medium 0 \/ Low 0/);
    assert.match(block, /High 9 \/ Medium 9 \/ Low 9/);
  });

  it('--allow-missing-tally does not downgrade a duplicate', async () => {
    const glob = write(
      'audit-accessibility-results.md',
      [
        '## Executive Summary',
        '',
        'Severity tally: Critical 0 / High 0 / Medium 0 / Low 0',
        '',
        '## Notes',
        '',
        'Severity tally: Critical 0 / High 0 / Medium 0 / Low 0',
        '',
      ].join('\n'),
    );
    const plan = await buildPlan(
      { glob, useProvider: false, allowMissingTally: true },
      silent,
    );
    assert.deepEqual(
      plan.summary.reportFailures.map((f) => f.kind),
      ['duplicate-tally'],
    );
  });
});
