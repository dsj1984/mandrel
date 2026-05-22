/**
 * tests/contract/lifecycle/doc-drift-check.test.js — Story #2895 / Task #2905
 *
 * Contract: `.agents/scripts/check-lifecycle-doc-drift.js` MUST
 *   1. Extract listener subscription arrays from
 *      `this.events = Object.freeze([...])` literal patterns and treat
 *      array bodies that contain dynamic expressions (e.g.
 *      `Object.keys(...)`) as wildcard subscriptions.
 *   2. Resolve identifier-form entries against top-level
 *      `const NAME = '<literal>';` declarations in the same file so
 *      listeners that reference an event-name constant still classify
 *      as literal subscriptions.
 *   3. Parse the `docs/LIFECYCLE.md` listener-model table and surface
 *      per-listener `event-drift`, `missing-row`, `unknown-row`, and
 *      `wildcard-mismatch` findings.
 *   4. Exit zero against the post-fix repo state.
 *   5. Exit non-zero when a synthetic listener fixture introduces a
 *      subscription that the doc table does not name.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  checkLifecycleDocDrift,
  collectStringConstants,
  diffListenerEvents,
  extractCodeEvents,
  formatFinding,
  kebabToPascal,
  loadCodeListeners,
  parseListenerTable,
} from '../../../.agents/scripts/check-lifecycle-doc-drift.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'check-lifecycle-doc-drift.js',
);
const LISTENERS_DIR = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'lib',
  'orchestration',
  'lifecycle',
  'listeners',
);
const DOC_PATH = path.join(REPO_ROOT, 'docs', 'LIFECYCLE.md');

describe('check-lifecycle-doc-drift — pure helpers', () => {
  it('converts kebab basenames to PascalCase', () => {
    assert.equal(kebabToPascal('acceptance-reconciler'), 'AcceptanceReconciler');
    assert.equal(kebabToPascal('automerge-armer'), 'AutomergeArmer');
    assert.equal(kebabToPascal('cleaner'), 'Cleaner');
  });

  it('extracts literal subscription arrays', () => {
    const src = `
      class X {
        constructor() {
          this.events = Object.freeze(['epic.close.end']);
        }
      }
    `;
    assert.deepEqual(extractCodeEvents(src), {
      kind: 'literals',
      events: ['epic.close.end'],
    });
  });

  it('extracts multi-line literal arrays', () => {
    const src = `
      this.events = Object.freeze([
        'wave.start',
        'wave.end',
      ]);
    `;
    assert.deepEqual(extractCodeEvents(src), {
      kind: 'literals',
      events: ['wave.start', 'wave.end'],
    });
  });

  it('treats dynamic expressions as wildcard', () => {
    const src = `
      this.events = Object.freeze(Object.keys(SOMETHING));
    `;
    assert.deepEqual(extractCodeEvents(src), { kind: 'wildcard' });
  });

  it('resolves identifier entries via top-level string constants', () => {
    const src = `
      export const FOO_EVENT = 'foo.event';
      class X {
        constructor() {
          this.events = Object.freeze([FOO_EVENT]);
        }
      }
    `;
    assert.deepEqual(extractCodeEvents(src), {
      kind: 'literals',
      events: ['foo.event'],
    });
  });

  it('treats unresolved identifier entries as wildcard', () => {
    const src = `
      this.events = Object.freeze([UNKNOWN_THING]);
    `;
    assert.deepEqual(extractCodeEvents(src), { kind: 'wildcard' });
  });

  it('returns wildcard when the pattern is absent', () => {
    const src = `class X { register(bus) { bus.on('*', () => {}); } }`;
    assert.deepEqual(extractCodeEvents(src), { kind: 'wildcard' });
  });

  it('collects exported and non-exported top-level string constants', () => {
    const src = [
      "const FOO = 'foo';",
      "export const BAR = 'bar';",
      "const NOT_A_STRING = 42;",
    ].join('\n');
    const out = collectStringConstants(src);
    assert.equal(out.get('FOO'), 'foo');
    assert.equal(out.get('BAR'), 'bar');
    assert.equal(out.has('NOT_A_STRING'), false);
  });

  it('parses the listener-model table from a minimal LIFECYCLE.md', () => {
    const md = [
      '## 4. Listener model',
      '',
      '| Listener | Subscribes to | Side effect |',
      '| --- | --- | --- |',
      '| `Alpha` | `foo.bar`, `baz.qux` | does a thing. |',
      '| `Beta` | `*` (wildcard) | does another thing. |',
      '',
      '## 5. next section',
    ].join('\n');
    const rows = parseListenerTable(md);
    assert.equal(rows.size, 2);
    assert.deepEqual([...rows.get('Alpha').events].sort(), ['baz.qux', 'foo.bar']);
    assert.equal(rows.get('Alpha').hasWildcard, false);
    assert.equal(rows.get('Beta').hasWildcard, true);
  });

  it('diffs code-only and doc-only event sets', () => {
    const diff = diffListenerEvents({
      code: { kind: 'literals', events: ['a.b', 'c.d'] },
      doc: { events: new Set(['a.b', 'e.f']), hasWildcard: false },
    });
    assert.deepEqual(diff.codeOnly, ['c.d']);
    assert.deepEqual(diff.docOnly, ['e.f']);
    assert.equal(diff.wildcardMismatch, false);
  });

  it('flags wildcard-mismatch when code is dynamic but doc has no `*`', () => {
    const diff = diffListenerEvents({
      code: { kind: 'wildcard' },
      doc: { events: new Set(['a.b']), hasWildcard: false },
    });
    assert.equal(diff.wildcardMismatch, true);
  });
});

describe('check-lifecycle-doc-drift — repo state', () => {
  it('exits 0 against the current listener tree and LIFECYCLE.md', () => {
    const findings = checkLifecycleDocDrift();
    assert.deepEqual(
      findings,
      [],
      `expected zero findings, got:\n${findings.map(formatFinding).join('\n')}`,
    );
  });

  it('CLI invocation against the live repo exits 0', () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /\[lifecycle-doc-drift\] clean/);
  });
});

describe('check-lifecycle-doc-drift — fixture drift detection', () => {
  it('flags a fixture listener whose event is missing from the doc', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'lifecycle-drift-'));
    try {
      const listenersDir = path.join(tmp, 'listeners');
      mkdirSync(listenersDir, { recursive: true });
      // Mirror the canonical listener-class shape so the parser
      // recognises the subscription array.
      writeFileSync(
        path.join(listenersDir, 'fake-rogue.js'),
        [
          'export class FakeRogue {',
          '  constructor() {',
          "    this.events = Object.freeze(['rogue.event']);",
          '  }',
          '}',
        ].join('\n'),
        'utf8',
      );
      // Doc table contains a placeholder row that does NOT mention
      // `rogue.event` — the drift the script must catch.
      const docPath = path.join(tmp, 'LIFECYCLE.md');
      writeFileSync(
        docPath,
        [
          '## 4. Listener model',
          '',
          '| Listener | Subscribes to | Side effect |',
          '| --- | --- | --- |',
          '| `FakeRogue` | `other.event` | placeholder side effect. |',
          '',
        ].join('\n'),
        'utf8',
      );
      const findings = checkLifecycleDocDrift({
        listenersDir,
        docPath,
      });
      const drift = findings.find(
        (f) => f.kind === 'event-drift' && f.listener === 'FakeRogue',
      );
      assert.ok(drift, `expected event-drift for FakeRogue, got ${JSON.stringify(findings)}`);
      assert.deepEqual(drift.codeOnly, ['rogue.event']);
      assert.deepEqual(drift.docOnly, ['other.event']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('flags a fixture listener with no doc row at all', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'lifecycle-drift-'));
    try {
      const listenersDir = path.join(tmp, 'listeners');
      mkdirSync(listenersDir, { recursive: true });
      writeFileSync(
        path.join(listenersDir, 'ghost-listener.js'),
        [
          'export class GhostListener {',
          '  constructor() {',
          "    this.events = Object.freeze(['ghost.event']);",
          '  }',
          '}',
        ].join('\n'),
        'utf8',
      );
      const docPath = path.join(tmp, 'LIFECYCLE.md');
      writeFileSync(
        docPath,
        [
          '## 4. Listener model',
          '',
          '| Listener | Subscribes to | Side effect |',
          '| --- | --- | --- |',
          '',
        ].join('\n'),
        'utf8',
      );
      const findings = checkLifecycleDocDrift({
        listenersDir,
        docPath,
      });
      const missing = findings.find(
        (f) => f.kind === 'missing-row' && f.listener === 'GhostListener',
      );
      assert.ok(missing, `expected missing-row, got ${JSON.stringify(findings)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('CLI invocation against a drift fixture exits non-zero', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'lifecycle-drift-cli-'));
    try {
      // Build a self-contained repo skeleton the CLI can run against by
      // pointing it at a fixture listenersDir + docPath. The script's
      // default discovery uses the live repo, so we exercise the
      // exported `checkLifecycleDocDrift` here and assert the same
      // exit semantics via a small driver script.
      const driver = path.join(tmp, 'driver.mjs');
      const fixtureListeners = path.join(tmp, 'listeners');
      const fixtureDoc = path.join(tmp, 'LIFECYCLE.md');
      mkdirSync(fixtureListeners, { recursive: true });
      writeFileSync(
        path.join(fixtureListeners, 'driftling.js'),
        [
          'export class Driftling {',
          '  constructor() {',
          "    this.events = Object.freeze(['drift.event']);",
          '  }',
          '}',
        ].join('\n'),
        'utf8',
      );
      writeFileSync(
        fixtureDoc,
        [
          '## 4. Listener model',
          '',
          '| Listener | Subscribes to | Side effect |',
          '| --- | --- | --- |',
          '',
        ].join('\n'),
        'utf8',
      );
      writeFileSync(
        driver,
        [
          `import { checkLifecycleDocDrift, formatFinding } from ${JSON.stringify(pathToFileURL(SCRIPT_PATH).href)};`,
          `const findings = checkLifecycleDocDrift({ listenersDir: ${JSON.stringify(fixtureListeners)}, docPath: ${JSON.stringify(fixtureDoc)} });`,
          `if (findings.length === 0) process.exit(0);`,
          `for (const f of findings) process.stderr.write(formatFinding(f) + "\\n");`,
          `process.exit(1);`,
        ].join('\n'),
        'utf8',
      );
      const result = spawnSync(process.execPath, [driver], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 1, `expected exit 1, stdout: ${result.stdout}`);
      assert.match(result.stderr, /Driftling/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('check-lifecycle-doc-drift — listener loader', () => {
  it('skips index.js but loads every other listener file', () => {
    const listeners = loadCodeListeners(LISTENERS_DIR);
    const names = listeners.map((l) => l.pascalName).sort();
    assert.ok(!names.includes('Index'), `loader should skip index.js (got ${names.join(',')})`);
    assert.ok(names.includes('AcceptanceReconciler'));
    assert.ok(names.includes('AutomergeArmer'));
  });

  it('every listener with a literal subscription appears in the doc table', () => {
    const docRows = parseListenerTable(readFileSync(DOC_PATH, 'utf8'));
    const listeners = loadCodeListeners(LISTENERS_DIR);
    for (const { pascalName } of listeners) {
      assert.ok(
        docRows.has(pascalName),
        `${pascalName} is implemented under listeners/ but missing from LIFECYCLE.md listener table`,
      );
    }
  });
});
