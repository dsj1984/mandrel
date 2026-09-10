// tests/contract/docs-reference-sync.test.js
//
// Story #4785 — keeps the reference documentation honest about the contracts
// the code actually implements.
//
// The docs in scope are read by every agent that works in this repo, and two
// of them (`architecture.md`, `data-dictionary.md`) are mandatory reads. A doc
// that instructs a `.agentrc.json` key the AJV schema rejects, or points at a
// module that no longer exists, does not merely mislead — it costs a full
// failed round-trip. These are the three machine-checkable axes:
//
//   1. Every `.agentrc.json` key quoted in a doc in scope is REACHABLE in the
//      live AGENTRC_SCHEMA. Reachability (not a full instance round-trip) is
//      the right assertion because every block in that schema is
//      `additionalProperties: false`: an unreachable key is a guaranteed
//      validation failure whatever value you give it, and a reachable one
//      cannot be rejected for existing. Keys the docs deliberately name as
//      RETIRED are listed below and are asserted to be genuinely unreachable,
//      so the allowlist cannot rot into cover for a live key.
//
//   2. Every backticked path in a doc in scope resolves on disk. Paths the
//      docs deliberately name as deleted history (or that are gitignored /
//      runtime-generated / external) are listed below with a reason, and each
//      entry is asserted to be genuinely absent so the list cannot rot either.
//
//   3. The `data-dictionary.md` rows for SignalEvent and `baselines/crap.json`
//      match the live JSON Schemas field-by-field — that file declares itself
//      a schema mirror, so drift is a contract break, not a typo.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COVERAGE_GATE } from '../../.agents/scripts/lib/config/gates/coverage.schema.js';
import { CRAP_GATE } from '../../.agents/scripts/lib/config/gates/crap.schema.js';
import { AGENTRC_SCHEMA } from '../../.agents/scripts/lib/config-settings-schema.js';
import { EVENT_KINDS } from '../../.agents/scripts/lib/signals/schema.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

/** The documentation partition this Story owns. */
const DOCS_IN_SCOPE = Object.freeze([
  'docs/architecture.md',
  'docs/data-dictionary.md',
  'docs/ci-contract.md',
  'docs/onboarding.md',
  'docs/claude-coupling-review.md',
  'docs/release-operations.md',
  'AGENTS.md',
  'README.md',
]);

const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * Yield `{ doc, line, token }` for every backticked token in the docs in
 * scope. Tokens containing whitespace are skipped — those are prose or
 * command lines, not identifiers.
 *
 * @returns {Array<{doc: string, line: number, token: string}>}
 */
function backtickedTokens() {
  const out = [];
  for (const doc of DOCS_IN_SCOPE) {
    read(doc)
      .split('\n')
      .forEach((line, idx) => {
        for (const m of line.matchAll(/`([^`\n]+)`/g)) {
          const token = m[1].trim();
          if (!token || /\s/.test(token)) continue;
          out.push({ doc, line: idx + 1, token });
        }
      });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. `.agentrc.json` keys quoted in the docs must be reachable in the schema
// ---------------------------------------------------------------------------

const AGENTRC_ROOTS = new Set([
  'project',
  'github',
  'planning',
  'delivery',
  'qa',
]);

/**
 * Keys the docs in scope name **because they were retired** — each is
 * mentioned only to warn that writing it now fails AJV validation. The test
 * below asserts every entry really is unreachable, so this list can never
 * quietly excuse a live key that a future refactor moves.
 */
const DOCUMENTED_AS_RETIRED = Object.freeze([
  'delivery.maxTokenBudget',
  'delivery.preflight.*',
  'delivery.signals.hotspot',
]);

/**
 * Walk a dotted config path through the live AJV schema. Returns the first
 * segment that cannot be reached, or `null` when the whole path resolves.
 *
 * `additionalProperties` that is `true` or an object schema means the level
 * accepts arbitrary keys, so traversal continues; `false` (the repo-wide
 * default) means an unlisted key is a hard rejection.
 *
 * @param {string} dotted
 * @returns {string|null} the unreachable segment, or null
 */
function unreachableSegment(dotted) {
  let node = AGENTRC_SCHEMA;
  for (const seg of dotted.split('.')) {
    if (seg === '' || seg === '*') continue;
    while (
      node &&
      !node.properties &&
      (node.oneOf || node.allOf || node.anyOf)
    ) {
      node = (node.oneOf || node.allOf || node.anyOf).find((s) => s.properties);
    }
    if (!node || typeof node !== 'object') return seg;
    if (node.properties && Object.hasOwn(node.properties, seg)) {
      node = node.properties[seg];
      continue;
    }
    const extra = node.additionalProperties;
    if (extra === true) {
      node = {};
      continue;
    }
    if (extra && typeof extra === 'object') {
      node = extra;
      continue;
    }
    return seg;
  }
  return null;
}

describe('docs in scope — every quoted .agentrc.json key validates (Story #4785)', () => {
  it('names no config key the live AGENTRC_SCHEMA would reject', () => {
    const retired = new Set(DOCUMENTED_AS_RETIRED);
    const offenders = [];
    for (const { doc, line, token } of backtickedTokens()) {
      if (!token.includes('.')) continue;
      if (!/^[A-Za-z][A-Za-z0-9_.*-]*$/.test(token)) continue;
      if (!AGENTRC_ROOTS.has(token.split('.')[0])) continue;
      if (retired.has(token)) continue;
      const bad = unreachableSegment(token);
      if (bad)
        offenders.push(
          `${doc}:${line} — \`${token}\` (unreachable at "${bad}")`,
        );
    }
    assert.deepEqual(
      offenders,
      [],
      `docs quote .agentrc.json keys the schema rejects:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('keeps DOCUMENTED_AS_RETIRED honest — every entry is genuinely unreachable', () => {
    for (const key of DOCUMENTED_AS_RETIRED) {
      assert.ok(
        unreachableSegment(key),
        `\`${key}\` is reachable in AGENTRC_SCHEMA — drop it from DOCUMENTED_AS_RETIRED and document it as live`,
      );
    }
  });

  it('pins delivery.ci to its live keys (the skipForStoryPushes guard)', () => {
    // Story #5096 added `blockOnAdvisoryFailure` + `advisoryAllowlist`;
    // Story #5266 added `rerunAdvisory`. The pin is deliberately exact so a
    // RETIRED key (earlyPr, requireChecks, skipForStoryPushes) cannot creep
    // back unnoticed — extend it when a key genuinely goes live, never loosen
    // it to a subset check.
    const ci = AGENTRC_SCHEMA.properties.delivery.properties.ci;
    assert.deepEqual(Object.keys(ci.properties).sort(), [
      'advisoryAllowlist',
      'autoMerge',
      'blockOnAdvisoryFailure',
      'rerunAdvisory',
      'watch',
    ]);
    assert.equal(ci.additionalProperties, false);
  });
});

// ---------------------------------------------------------------------------
// 2. Every backticked path in the docs in scope resolves on disk
// ---------------------------------------------------------------------------

/** Path-ish suffixes worth resolving. Bare extensions (`.js`) are excluded. */
const PATH_SUFFIX = /[^./]\.(js|mjs|cjs|ts|tsx|json|md|yml|yaml|ndjson)$/;

/** Roots a bare path may be relative to. */
const PATH_PREFIXES = Object.freeze([
  '',
  '.agents/scripts/',
  '.agents/',
  'docs/',
  'lib/',
  'bin/',
  'tests/',
  '.github/workflows/',
]);

/**
 * Paths the docs in scope name that deliberately do NOT exist on disk. Every
 * entry carries the reason it is absent; the second test asserts each really
 * is absent, so a resurrected module cannot hide behind this list.
 */
const UNRESOLVED_BY_DESIGN = Object.freeze({
  // --- Named as deleted history (the doc says so in the same breath) -------
  'dispatch-engine.js': 'pre-v2 entry script, deleted in the v2 cutover',
  'dispatcher.js': 'pre-v2 DAG/wave CLI, deleted in the v2 cutover',
  'epic-execute-record-wave.js':
    'in-process epic-runner stratum, deleted (#3908)',
  'wave-gate.js': 'epic-runner-era concurrency surface, deleted (#3908)',
  'lib/orchestration/concurrency.js':
    'epic-runner-era concurrency surface, deleted (#3908)',
  'lib/orchestration/context.js':
    'typed runner context classes, deleted (#3908)',
  'lib/orchestration/error-journal.js':
    'ErrorJournal, deleted with the in-process runner (#3908)',
  'analyze-execution.js': 'execution-analysis surface, deleted (Story #4545)',
  'epic-audit-prepare.js':
    'Epic audit CLI, deleted in the v2 Story-only cutover',
  'epic-audit-recheck.js':
    'Epic audit CLI, deleted in the v2 Story-only cutover',
  'render-manifest.js':
    'dispatch-manifest renderer, deleted with the Epic tier',
  'lib/orchestration/retro-heuristics.js':
    'epic-retro predicate, deleted with the Epic path',
  'check-crap.js': 'per-kind gate CLI, folded into lib/baselines/kinds/',
  'check-maintainability.js':
    'per-kind gate CLI, folded into lib/baselines/kinds/',
  'select-audits.js':
    'audit entry script, folded into lib/audit-suite/index.js',
  'run-audit-suite.js':
    'audit entry script, folded into lib/audit-suite/index.js',
  'loc-delta.js': 'operator CLI removed; the scripts README no longer lists it',
  'update-mutation-baseline.js':
    'operator CLI removed; the scripts README no longer lists it',
  'validate-docs-freshness.js':
    'Epic-keyed docs-freshness gate with zero invokers, deleted (Story #5010)',
  // --- Gitignored local overrides / runtime artifacts ----------------------
  '.agentrc.local.json': 'gitignored local config override',
  '.mcp.json': 'gitignored local MCP config',
  'traces.ndjson': 'runtime artifact written under temp/',
  'temp/test-profile.tap': 'runtime artifact written under temp/ (gitignored)',
  // --- Not this repository's files ----------------------------------------
  'src/index.ts': 'file in release-please-action v5.0.0, an external repo',
  'pnpm-lock.yaml': "a consumer project's lockfile, not this repo's",
  'libnpmpublish/lib/provenance.js':
    "a module inside the npm CLI's own bundled tree, not this repo's — cited by docs/release-operations.md as the npm 12.0.0 sigstore-resolution failure site",
});

describe('docs in scope — every backticked path resolves (Story #4785)', () => {
  const tracked = execFileSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  const trackedSet = new Set(tracked);
  const trackedBasenames = new Set(tracked.map((p) => path.posix.basename(p)));

  // Resolution is against the **tracked** tree, not the working directory: a
  // gitignored local override (`.agentrc.local.json`, `.mcp.json`) that
  // happens to exist on this machine must not make a doc reference look
  // resolved for everyone else.
  const resolves = (token) =>
    PATH_PREFIXES.some((prefix) =>
      trackedSet.has(path.posix.normalize(prefix + token)),
    ) || trackedBasenames.has(path.posix.basename(token));

  it('points at no module, script, or schema that is absent from the repo', () => {
    const offenders = [];
    const seen = new Set();
    for (const { doc, line, token } of backtickedTokens()) {
      // Skip glob/brace/placeholder forms and `@`-import directives.
      if (/[*{}<>@]/.test(token)) continue;
      if (!PATH_SUFFIX.test(token)) continue;
      const clean = token.replace(/[.,;:)]+$/, '').replace(/:\d+$/, '');
      if (Object.hasOwn(UNRESOLVED_BY_DESIGN, clean)) continue;
      const key = `${doc}|${clean}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!resolves(clean)) offenders.push(`${doc}:${line} — \`${clean}\``);
    }
    assert.deepEqual(
      offenders,
      [],
      `docs point at paths that do not resolve on disk:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('keeps UNRESOLVED_BY_DESIGN honest — every entry is genuinely absent', () => {
    for (const [token, reason] of Object.entries(UNRESOLVED_BY_DESIGN)) {
      assert.equal(
        resolves(token),
        false,
        `\`${token}\` now resolves on disk (${reason}) — drop it from UNRESOLVED_BY_DESIGN`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3. data-dictionary.md mirrors the live schemas
// ---------------------------------------------------------------------------

const dataDictionary = () => read('docs/data-dictionary.md');

const signalEventSchema = () =>
  JSON.parse(read('.agents/schemas/signal-event.schema.json'));

const crapSchema = () =>
  JSON.parse(read('.agents/schemas/baselines/crap.schema.json'));

const baselineEnvelopeSchema = () =>
  JSON.parse(read('.agents/schemas/baselines/baseline-envelope.schema.json'));

describe('data-dictionary.md — SignalEvent row mirrors the live schema (Story #4785)', () => {
  it('documents `source` as the framework|consumer string enum, not an object', () => {
    const schema = signalEventSchema();
    assert.equal(schema.properties.source.type, 'string');
    assert.deepEqual(schema.properties.source.enum, ['framework', 'consumer']);

    const md = dataDictionary();
    const row = md.split('\n').find((l) => l.trim().startsWith('| `source`'));
    assert.ok(row, 'no `source` row found in data-dictionary.md');
    assert.match(
      row,
      /`string` enum/,
      '`source` row must document a string enum',
    );
    assert.match(
      row,
      /`framework`/,
      '`source` row must name the framework value',
    );
    assert.match(
      row,
      /`consumer`/,
      '`source` row must name the consumer value',
    );
    assert.doesNotMatch(
      row,
      /`\{ tool: string/,
      '`source` row still documents the deleted `{ tool }` provenance object',
    );
  });

  it('documents `emitter` as the provenance object that replaced `source.tool`', () => {
    const schema = signalEventSchema();
    assert.equal(schema.properties.emitter.type, 'object');
    assert.ok(Object.hasOwn(schema.properties.emitter.properties, 'tool'));

    const md = dataDictionary();
    const row = md.split('\n').find((l) => l.trim().startsWith('| `emitter`'));
    assert.ok(row, 'data-dictionary.md omits the `emitter` field entirely');
    assert.match(row, /`object`/);
    assert.match(row, /tool/);
  });

  it('states the kind-enum count that the schema and EVENT_KINDS agree on', () => {
    const schemaKinds = signalEventSchema().properties.kind.enum;
    const constantKinds = Object.values(EVENT_KINDS);
    assert.deepEqual(
      [...schemaKinds].sort(),
      [...constantKinds].sort(),
      'signal-event.schema.json and EVENT_KINDS have drifted apart',
    );
    assert.equal(
      schemaKinds.length,
      13,
      'kind enum size changed — update the doc',
    );

    const md = dataDictionary();
    assert.match(
      md,
      /kind` enum holds \*\*thirteen\*\* values/,
      'data-dictionary.md must state the live kind-enum count (thirteen)',
    );
    for (const kind of schemaKinds) {
      assert.ok(
        md.includes(`\`${kind}\``),
        `data-dictionary.md never names the \`${kind}\` kind`,
      );
    }
    assert.doesNotMatch(
      md,
      /taxonomy of seven record kinds/,
      'data-dictionary.md still undercounts the kind taxonomy as seven',
    );
  });

  it('marks Required exactly for the schema-required fields (ts, kind)', () => {
    const required = signalEventSchema().required;
    assert.deepEqual([...required].sort(), ['kind', 'ts']);

    // Every SignalEvent row in the table, keyed by field name.
    // Bound the slice at the next `## ` heading rather than a named one: the
    // sections that followed SignalEvent were archived in Story #4924, and a
    // missing sentinel would silently widen the slice over the neighbouring
    // FrictionEvent table (whose Required column mirrors a different schema).
    const md = dataDictionary();
    const start = md.indexOf('## SignalEvent');
    assert.notEqual(start, -1, 'data-dictionary.md lost its SignalEvent table');
    const nextHeading = md.indexOf('\n## ', start + 1);
    const section = md.slice(
      start,
      nextHeading === -1 ? md.length : nextHeading,
    );
    // Cells may carry escaped pipes inside a type expression, which would
    // shift every column index if split naively. The Required column never
    // contains one, so neutralising them before the split is enough.
    const rows = section
      .split('\n')
      .filter((l) => /^\|\s*`\w/.test(l.trim()))
      .map((l) =>
        l
          .replace(/\\\|/g, '/')
          .split('|')
          .map((c) => c.trim()),
      );

    assert.ok(rows.length >= 8, 'SignalEvent table looks truncated');
    for (const cells of rows) {
      const field = cells[1].replace(/`/g, '');
      const requiredCell = cells[3].replace(/\*/g, '');
      const expected = required.includes(field) ? 'Yes' : 'No';
      assert.equal(
        requiredCell,
        expected,
        `SignalEvent row \`${field}\`: doc says Required=${requiredCell}, schema says ${expected}`,
      );
    }
  });
});

describe('data-dictionary.md — crap.json row mirrors the live schema (Story #4785)', () => {
  it('names the two stamps the floors gate compares against', () => {
    assert.ok(Object.hasOwn(crapSchema().properties, 'scoringSemantics'));
    assert.ok(Object.hasOwn(crapSchema().properties, 'rollup'));

    const md = dataDictionary();
    assert.match(
      md,
      /`scoringSemantics`/,
      'crap.json row omits `scoringSemantics`',
    );
    assert.match(md, /`rollup`/, 'crap.json row omits `rollup`');
  });

  it('documents the rollup axes the floors are checked against', () => {
    const axes = crapSchema().properties.rollup.properties['*'].required;
    assert.deepEqual([...axes].sort(), ['max', 'methodsAbove20', 'p50', 'p95']);
    const md = dataDictionary();
    for (const axis of axes) {
      assert.ok(
        md.includes(axis),
        `crap.json row never names the \`${axis}\` rollup axis`,
      );
    }
  });

  it('keys rows on `path` — the artefact has no `file` key', () => {
    const rowProps = Object.keys(crapSchema().properties.rows.items.properties);
    // `coordinateSystem` (Story #4866) is optional and written only for a row
    // that kept transpiled coordinates — the four REQUIRED keys are the
    // artefact's shape, and `path` is still the key field.
    assert.deepEqual(crapSchema().properties.rows.items.required.sort(), [
      'crap',
      'method',
      'path',
      'startLine',
    ]);
    assert.deepEqual(rowProps.sort(), [
      // `anonymous` (Story #4969) is optional on the same terms as
      // `coordinateSystem`: written only for a row whose `method` is a derived
      // scope-path identity rather than a name the source carries.
      'anonymous',
      'coordinateSystem',
      'crap',
      'method',
      'path',
      'startLine',
    ]);
    assert.equal(
      crapSchema().properties.rows.items.additionalProperties,
      false,
    );

    const md = dataDictionary();
    const row = md.split('\n').find((l) => l.includes('`baselines/crap.json`'));
    assert.ok(row, 'no `baselines/crap.json` row found');
    assert.match(row, /`\{ path, method, startLine, crap \}`/);
    assert.doesNotMatch(
      row,
      /\{ file, method, startLine, crap \}/,
      'crap.json row still keys rows on the non-existent `file` property',
    );
  });

  it('does not claim an `escomplexVersion` key the envelope forbids', () => {
    const envelope = baselineEnvelopeSchema();
    assert.equal(envelope.additionalProperties, false);
    assert.ok(!Object.hasOwn(envelope.properties, 'escomplexVersion'));
    assert.ok(!Object.hasOwn(crapSchema().properties, 'escomplexVersion'));

    const md = dataDictionary();
    const row = md.split('\n').find((l) => l.includes('`baselines/crap.json`'));
    assert.match(
      row,
      /no `escomplexVersion` key/,
      'the crap.json row must say the envelope has no `escomplexVersion`',
    );
  });

  it('puts coveragePath on the coverage gate, not the crap gate', () => {
    // The live gate schemas are the authority: both are additionalProperties:
    // false, so the key exists on exactly one of them.
    assert.ok(!Object.hasOwn(CRAP_GATE.properties, 'coveragePath'));
    assert.equal(CRAP_GATE.additionalProperties, false);
    assert.ok(Object.hasOwn(COVERAGE_GATE.properties, 'coveragePath'));

    const md = dataDictionary();
    const crapConfigRow = md
      .split('\n')
      .find((l) => l.includes('`delivery.quality.gates.crap`'));
    assert.ok(crapConfigRow, 'no `delivery.quality.gates.crap` row found');
    assert.doesNotMatch(
      crapConfigRow,
      /coveragePath/,
      'the gates.crap config row still lists the retired `coveragePath` key',
    );
    for (const key of Object.keys(CRAP_GATE.properties)) {
      assert.ok(
        crapConfigRow.includes(`${key}`),
        `the gates.crap config row omits the live \`${key}\` key`,
      );
    }
    assert.match(
      md,
      /gates\.coverage\.coveragePath/,
      'data-dictionary.md must say coveragePath lives on the coverage gate',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. ci-contract.md names the LIVE required-check contexts
// ---------------------------------------------------------------------------

describe('ci-contract.md — required-check contexts match the ruleset (Story #4785)', () => {
  const liveContexts = () => {
    const ruleset = JSON.parse(read('.github/ruleset.json'));
    const rule = ruleset.rules.find((r) => r.type === 'required_status_checks');
    return rule.parameters.required_status_checks.map((c) => c.context);
  };

  it('names every live context and no context the ruleset does not declare', () => {
    const md = read('docs/ci-contract.md');
    for (const context of liveContexts()) {
      assert.ok(
        md.includes(`\`${context}\``),
        `ci-contract.md never names the live required check \`${context}\``,
      );
    }
  });

  it('does not present the .agentrc.json requiredChecks names as contexts', () => {
    // The failure this guards is the one that motivated Story #4785: telling an
    // operator to require `lint` / `test` produces contexts no workflow reports,
    // and removing the ruleset to unstick it leaves `trust-ci` ungated.
    const agentrc = JSON.parse(read('.agentrc.json'));
    const localLabels = agentrc.github.branchProtection.requiredChecks.map(
      (c) => c.name,
    );
    const contexts = new Set(liveContexts());
    const notContexts = localLabels.filter((name) => !contexts.has(name));
    assert.ok(
      notContexts.length > 0,
      'expected at least one requiredChecks label that is not a live context',
    );

    const md = read('docs/ci-contract.md');
    assert.match(
      md,
      /`requiredChecks` names are NOT check contexts/,
      'ci-contract.md must state outright that the .agentrc.json names are local labels',
    );
    for (const label of notContexts) {
      assert.ok(
        md.includes(`there is no \`${label}\` context`) ||
          md.includes(`no \`${label}\` context`),
        `ci-contract.md must say there is no \`${label}\` check context`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The distribution surface is stated identically in all three doors
// ---------------------------------------------------------------------------

describe('distribution surface — one claim, three docs (Story #4785)', () => {
  /** Directory entries of package.json `files`, minus the negated patterns. */
  const shippedDirs = () =>
    JSON.parse(read('package.json'))
      .files.filter((f) => !f.startsWith('!'))
      .filter((f) => f.endsWith('/'))
      .map((f) => f.replace(/\/$/, ''));

  it('publishes exactly .agents/, bin/, lib/ — the set the docs must agree on', () => {
    assert.deepEqual(shippedDirs().sort(), ['.agents', 'bin', 'lib']);
  });

  it('is claimed identically by AGENTS.md, README.md, and onboarding.md', () => {
    for (const doc of ['AGENTS.md', 'README.md', 'docs/onboarding.md']) {
      const md = read(doc);
      for (const dir of shippedDirs()) {
        assert.ok(
          md.includes(`\`${dir}/\``),
          `${doc} never names the shipped directory \`${dir}/\``,
        );
      }
      assert.doesNotMatch(
        md,
        /Only `\.agents\/` is distributed to consumers/,
        `${doc} still claims only .agents/ ships, contradicting package.json files`,
      );
    }
  });

  it('lists bin/ and lib/ in both repository-layout trees', () => {
    for (const doc of ['docs/architecture.md', 'docs/onboarding.md']) {
      const md = read(doc);
      // The layout tree is the fenced block that opens with the repo root.
      const start = md.indexOf('\nmandrel/\n');
      assert.ok(start > 0, `${doc} has no repository-layout tree`);
      const tree = md.slice(start, md.indexOf('\n```', start));
      for (const dir of ['bin/', 'lib/']) {
        assert.ok(
          tree.includes(`├── ${dir}`),
          `${doc}'s repository-layout tree omits a top-level ${dir} entry`,
        );
      }
    }
  });
});
