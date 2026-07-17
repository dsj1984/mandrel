/**
 * tests/audit-suite/selector-web-target.test.js
 *
 * Contract tests for #4579's target-applicability half.
 *
 * The keyword-boundary fix (see `selector-keyword-boundary.test.js`) killed the
 * accidental *fragment* matches, but it does not help a web lens whose keyword
 * legitimately whole-word-matches ordinary prose. `audit-seo` triggers on
 * `"meta"`, and every Story body carries a `<!-- meta: {...} -->` machine
 * comment — so SEO still selected on this repo, which is a Node CLI + prompt
 * framework with no web surface at all. The roster's instruction is that the
 * host MUST walk every listed lens, so an inapplicable entry is both wasted
 * spend and a trained-in reason to ignore the MUST.
 *
 * The gate: a lens declaring `target: "web"` in `audit-rules.json` is skipped
 * when `hasWebSurface()` finds no web surface in the consumer's checkout.
 * Absent `target` means "always applicable" — no existing lens changes.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';

import {
  _resetWebSurfaceCache,
  hasWebSurface,
  selectAudits,
} from '../../.agents/scripts/lib/audit-suite/selector.js';
import { MockProvider } from '../fixtures/mock-provider.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_ROOT = path.join(HERE, '..', '..', '.agents', 'schemas');
const rules = JSON.parse(
  readFileSync(path.join(SCHEMAS_ROOT, 'audit-rules.json'), 'utf8'),
);
const schema = JSON.parse(
  readFileSync(path.join(SCHEMAS_ROOT, 'audit-rules.schema.json'), 'utf8'),
);

/** A Story body exactly as `/plan` writes it — machine comment and all. */
const STORY_BODY_WITH_META_COMMENT = [
  '<!-- meta: {"type":"story","planRun":"run-4579"} -->',
  '',
  'Retire the dead epic merge-lock probe from the close pipeline.',
].join('\n');

function makeProvider(body) {
  return new MockProvider({
    tickets: {
      700: { id: 700, title: 'Retire the merge-lock probe', body, labels: [] },
    },
  });
}

function select({ body, changedFiles, gate = 'gate3', hasWebSurfaceFn }) {
  return selectAudits({
    ticketId: 700,
    gate,
    provider: makeProvider(body),
    changedFiles,
    hasWebSurfaceFn,
  }).then((r) => r.selectedAudits);
}

/** Build an isolated fixture project root; each test gets its own. */
function fixtureRoot(files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'mandrel-websurface-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  _resetWebSurfaceCache();
  return root;
}

// ---------------------------------------------------------------------------
// (a) The live bug: a whole-word keyword hit must NOT select a web lens on a
//     repo with no web surface.
// ---------------------------------------------------------------------------

test('selector: audit-seo is not selected on a no-web-surface repo despite a whole-word "meta" hit', async () => {
  // Sanity-check the premise first: the keyword really does match. If this
  // assertion ever fails the test below would pass vacuously.
  assert.match(STORY_BODY_WITH_META_COMMENT, /\bmeta\b/);

  const selected = await select({
    body: STORY_BODY_WITH_META_COMMENT,
    changedFiles: ['.agents/scripts/lib/orchestration/close-pipeline.js'],
    hasWebSurfaceFn: () => false,
  });

  assert.ok(
    !selected.includes('audit-seo'),
    `audit-seo selected on a no-web repo via the Story body's meta comment: ${selected}`,
  );
});

test('selector: no web lens survives the gate on a no-web-surface repo', async () => {
  const selected = await select({
    body: 'Rework the ui, seo, meta and accessibility handling of the component tree.',
    changedFiles: ['.agents/scripts/deliver.js'],
    hasWebSurfaceFn: () => false,
  });

  for (const lens of [
    'audit-seo',
    'audit-ux-ui',
    'audit-lighthouse',
    'audit-navigability',
  ]) {
    assert.ok(
      !selected.includes(lens),
      `${lens} declares target: "web" and must not select on a no-web repo: ${selected}`,
    );
  }
});

test('selector: end-to-end on THIS repo, the real probe drops audit-seo (no seam)', async () => {
  _resetWebSurfaceCache();
  // No injected probe: this is the #4579 report reproduced verbatim — a real
  // Story body on the real (web-surface-free) mandrel checkout.
  const selected = await select({
    body: STORY_BODY_WITH_META_COMMENT,
    changedFiles: ['.agents/scripts/lib/audit-suite/selector.js'],
  });

  assert.ok(!selected.includes('audit-seo'), `got: ${selected}`);
  assert.ok(!selected.includes('audit-ux-ui'), `got: ${selected}`);
  assert.ok(!selected.includes('audit-lighthouse'), `got: ${selected}`);
  assert.ok(!selected.includes('audit-navigability'), `got: ${selected}`);
  // …while the applicable lenses still select, so this is a targeted gate and
  // not a roster-wide silencing.
  assert.ok(selected.includes('audit-clean-code'), `got: ${selected}`);
  assert.ok(selected.includes('audit-architecture'), `got: ${selected}`);
});

test('selector: THIS repo has no web surface — the real probe agrees', () => {
  _resetWebSurfaceCache();
  // No routeGlobs in .agentrc.json, no web-framework dep, no tracked
  // .html/.css/.jsx/.tsx. If this ever flips, the roster on this repo is
  // supposed to change and the fixture-driven tests above are no longer the
  // whole story.
  assert.equal(hasWebSurface({ config: null }), false);
});

// ---------------------------------------------------------------------------
// (b) A web lens IS selected when the probe finds a web surface — each signal
//     driven independently.
// ---------------------------------------------------------------------------

test('probe signal 1: configured navigability routeGlobs mark the project web-capable', () => {
  const root = fixtureRoot({ 'package.json': JSON.stringify({ name: 'cli' }) });
  const config = {
    delivery: { quality: { navigability: { routeGlobs: ['app/routes/**'] } } },
  };
  assert.equal(hasWebSurface({ config, projectRoot: root }), true);
});

test('probe signal 2: a declared web-framework dependency marks the project web-capable', () => {
  const root = fixtureRoot({
    'package.json': JSON.stringify({
      name: 'consumer',
      dependencies: { react: '^18.0.0', mandrel: '^2.0.0' },
    }),
  });
  assert.equal(hasWebSurface({ config: null, projectRoot: root }), true);
});

test('probe signal 2: a scoped web-framework dependency matches segment-wise', () => {
  const root = fixtureRoot({
    'package.json': JSON.stringify({
      name: 'consumer',
      devDependencies: { '@angular/core': '^17.0.0' },
    }),
  });
  assert.equal(hasWebSurface({ config: null, projectRoot: root }), true);
});

test('probe signal 3: a tracked .html file marks the project web-capable', () => {
  const root = fixtureRoot({
    'package.json': JSON.stringify({ name: 'consumer' }),
    'public/index.html': '<!doctype html><title>x</title>',
  });
  assert.equal(hasWebSurface({ config: null, projectRoot: root }), true);
});

test('probe: a .css under a test directory is NOT a web surface', () => {
  const root = fixtureRoot({
    'package.json': JSON.stringify({ name: 'cli' }),
    'tests/fixtures/snapshot.css': 'body{}',
    'src/index.js': 'export default 1;',
  });
  assert.equal(hasWebSurface({ config: null, projectRoot: root }), false);
});

test('probe: a Node-only consumer is not web-capable', () => {
  const root = fixtureRoot({
    'package.json': JSON.stringify({
      name: 'cli',
      dependencies: { picomatch: '^4.0.0' },
      devDependencies: { '@biomejs/biome': '^1.0.0' },
    }),
    'bin/cli.js': '#!/usr/bin/env node\n',
  });
  assert.equal(hasWebSurface({ config: null, projectRoot: root }), false);
});

test('selector: a web lens IS selected when the probe finds a web surface', async () => {
  const selected = await select({
    body: STORY_BODY_WITH_META_COMMENT,
    changedFiles: ['app/routes/index.tsx'],
    hasWebSurfaceFn: () => true,
  });

  assert.ok(
    selected.includes('audit-seo'),
    `audit-seo must still select on a real web project: ${selected}`,
  );
});

// ---------------------------------------------------------------------------
// (c) A lens with no `target` key is unaffected by the gate.
// ---------------------------------------------------------------------------

test('selector: a target-less lens still selects on a no-web-surface repo', async () => {
  const selected = await select({
    body: 'Harden the auth flow: rate-limit the login endpoint.',
    changedFiles: ['.agents/scripts/lib/orchestration/run-epilogue.js'],
    hasWebSurfaceFn: () => false,
  });

  // audit-clean-code (filePatterns `**/*`), audit-architecture (lib glob) and
  // audit-security (whole-word "auth") declare no `target` — absent means
  // always-applicable, so the gate must not touch them.
  for (const lens of [
    'audit-clean-code',
    'audit-architecture',
    'audit-security',
  ]) {
    assert.ok(
      selected.includes(lens),
      `${lens} declares no target and must be unaffected by the web gate: ${selected}`,
    );
  }
});

test('selector: the probe is not consulted when no web lens clears its gate', async () => {
  let probeCalls = 0;
  // gate1 lists no `target: "web"` lens, so a Node-only project must not pay
  // the filesystem scan at all.
  await select({
    body: 'Refactor the dispatcher.',
    changedFiles: ['.agents/scripts/deliver.js'],
    gate: 'gate1',
    hasWebSurfaceFn: () => {
      probeCalls += 1;
      return false;
    },
  });
  assert.equal(probeCalls, 0);
});

test('selector: the probe is resolved at most once per call', async () => {
  let probeCalls = 0;
  await select({
    body: 'ui seo meta accessibility route tree',
    changedFiles: ['.agents/scripts/deliver.js'],
    hasWebSurfaceFn: () => {
      probeCalls += 1;
      return false;
    },
  });
  // Four `target: "web"` lenses clear gate3; the probe must be memoized.
  assert.equal(probeCalls, 1);
});

// ---------------------------------------------------------------------------
// (d) Fail-open: an indeterminate probe treats the project as web-capable.
//     A wasted lens run is recoverable; silently dropped coverage is not.
// ---------------------------------------------------------------------------

test('probe: an unparseable package.json is indeterminate and fails open', () => {
  const root = fixtureRoot({ 'package.json': '{ this is not json' });
  assert.equal(hasWebSurface({ config: null, projectRoot: root }), true);
});

test('probe: an unreadable project root is indeterminate and fails open', () => {
  const root = path.join(tmpdir(), 'mandrel-websurface-does-not-exist-4579');
  _resetWebSurfaceCache();
  // No package.json (ENOENT — determinate "no declaration") and no readable
  // root for the scan (indeterminate) ⇒ fail open.
  assert.equal(hasWebSurface({ config: null, projectRoot: root }), true);
});

test('probe: an absent package.json alone does not fail open — the scan decides', () => {
  const root = fixtureRoot({ 'src/index.js': 'export default 1;' });
  // ENOENT is determinate: there is no declaration, so there is no signal.
  // The file scan then finds no web asset, and the project is Node-only.
  assert.equal(hasWebSurface({ config: null, projectRoot: root }), false);
});

// ---------------------------------------------------------------------------
// Manifest + schema contract for the `target` key.
// ---------------------------------------------------------------------------

test('audit-rules.json declares target: "web" on exactly the web lenses', () => {
  const webLenses = Object.entries(rules.audits)
    .filter(([, entry]) => entry.target === 'web')
    .map(([lens]) => lens)
    .sort();

  assert.deepEqual(webLenses, [
    'audit-lighthouse',
    'audit-navigability',
    'audit-seo',
    'audit-ux-ui',
  ]);
});

test('audit-rules.json validates against its schema with the target key present', () => {
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(schema);
  assert.equal(
    validate(rules),
    true,
    `validation errors: ${JSON.stringify(validate.errors, null, 2)}`,
  );
});

test('schema: target is optional (absent means always-applicable)', () => {
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(schema);
  assert.equal(
    validate({
      version: 1,
      audits: {
        'audit-thing': { triggers: { gates: ['gate1'] }, scope: 'local' },
      },
    }),
    true,
    'a lens entry with no target must still validate',
  );
});

test('schema: target rejects a value outside the enum', () => {
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(schema);
  assert.equal(
    validate({
      version: 1,
      audits: {
        'audit-thing': {
          triggers: { gates: ['gate1'] },
          scope: 'local',
          target: 'mobile',
        },
      },
    }),
    false,
    'an unregistered target value must fail validation',
  );
});
