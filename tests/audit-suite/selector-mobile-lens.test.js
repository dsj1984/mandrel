/**
 * tests/audit-suite/selector-mobile-lens.test.js — Story #5233.
 *
 * Contract tests for the `audit-mobile` lens: mobile and tablet UX is the one
 * concern the suite used to carry as a single unowned line inside
 * `audit-ux-ui` ("Check layouts at mobile, tablet, and desktop breakpoints"),
 * with no detectors, no runtime pass, and no dimension of its own.
 *
 * Two halves are locked here, because a lens that is authored but unroutable
 * is indistinguishable from one that does not exist:
 *
 *   - **Routing.** The lens selects on a responsive-surface change set through
 *     the real close-time matcher, selects on a mobile-keyword Story body
 *     through the full selector when the project has a web surface, and is
 *     dropped by the `target: "web"` gate when it does not.
 *   - **Body contract.** The four neighbouring lenses keep their concerns
 *     (accessibility owns the WCAG verdict, ux-ui the design system,
 *     performance the vitals, quality the generic test verdicts), the
 *     verification dimension keeps its coverage-vs-effectiveness split, and
 *     the runtime pass resolves its target from config rather than a
 *     hardcoded URL.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  _resetWebSurfaceCache,
  selectAudits,
  selectLocalLenses,
} from '../../.agents/scripts/lib/audit-suite/selector.js';
import { MockProvider } from '../fixtures/mock-provider.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LENS_PATH = path.resolve(
  HERE,
  '..',
  '..',
  '.agents',
  'workflows',
  'audit-mobile.md',
);
const lens = fs.readFileSync(LENS_PATH, 'utf8');

/** A Story body whose prose engages the lens's own keyword vocabulary. */
const MOBILE_STORY_BODY = [
  '<!-- meta: {"type":"story","planRun":"run-5233"} -->',
  '',
  'The dashboard header collapses badly at a phone viewport: the nav bar',
  'overflows horizontally and the filter drawer is unreachable by touch.',
].join('\n');

function select({ body, changedFiles, gate = 'gate3', hasWebSurfaceFn }) {
  const provider = new MockProvider({
    tickets: {
      700: { id: 700, title: 'Fix the collapsed header', body, labels: [] },
    },
  });
  return selectAudits({
    ticketId: 700,
    gate,
    provider,
    changedFiles,
    hasWebSurfaceFn,
  }).then((r) => r.selectedAudits);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test('selectLocalLenses: audit-mobile selects on a responsive-surface change set', () => {
  for (const file of [
    'src/styles/layout.css',
    'src/components/ui/NavBar.tsx',
    'app/dashboard/page.tsx',
    'tailwind.config.ts',
    'playwright.config.ts',
    'public/index.html',
  ]) {
    const selected = selectLocalLenses({ changedFiles: [file] });
    assert.ok(
      selected.includes('audit-mobile'),
      `audit-mobile must select on ${file}, got ${JSON.stringify(selected)}`,
    );
  }
});

test('selectLocalLenses: audit-mobile does not select on a backend-only change set', () => {
  const selected = selectLocalLenses({
    changedFiles: ['.agents/scripts/lib/audit-suite/selector.js'],
  });
  assert.ok(
    !selected.includes('audit-mobile'),
    `audit-mobile must stay off a backend-only diff, got ${JSON.stringify(selected)}`,
  );
});

test('selector: audit-mobile selects on a mobile-keyword body when a web surface exists', async () => {
  _resetWebSurfaceCache();
  const selected = await select({
    body: MOBILE_STORY_BODY,
    changedFiles: ['src/components/ui/NavBar.tsx'],
    hasWebSurfaceFn: () => true,
  });
  assert.ok(
    selected.includes('audit-mobile'),
    `audit-mobile must select on a web surface, got ${JSON.stringify(selected)}`,
  );
});

test('selector: the web-target gate drops audit-mobile on a no-web-surface repo', async () => {
  _resetWebSurfaceCache();
  const selected = await select({
    body: MOBILE_STORY_BODY,
    changedFiles: ['.agents/scripts/mandrel-deliver.js'],
    hasWebSurfaceFn: () => false,
  });
  assert.ok(
    !selected.includes('audit-mobile'),
    `audit-mobile declares target: "web" and must not select on a no-web repo: ${JSON.stringify(selected)}`,
  );
});

// ---------------------------------------------------------------------------
// Body contract
// ---------------------------------------------------------------------------

test('lens: names all four of its dimensions', () => {
  for (const dimension of [
    'Layout & Viewport',
    'Touch Ergonomics',
    'Responsive Assets',
    'Mobile Verification',
  ]) {
    assert.ok(
      lens.includes(dimension),
      `lens omits the ${dimension} dimension`,
    );
  }
});

test('lens: defers each neighbouring lens its own concern', () => {
  for (const neighbour of [
    'audit-accessibility',
    'audit-ux-ui',
    'audit-performance',
    'audit-quality',
  ]) {
    assert.ok(lens.includes(neighbour), `lens never defers to ${neighbour}`);
  }
  // The WCAG target-size verdict is the sharpest overlap: this lens measures
  // the control, the accessibility lens rules on it.
  assert.match(lens, /2\.5\.8/);
});

test('lens: splits mobile verification into coverage and effectiveness', () => {
  assert.match(lens, /\*\*Coverage —/);
  assert.match(lens, /\*\*Effectiveness —/);
  // A green mobile project whose assertions are viewport-agnostic is the
  // finding the effectiveness half exists to catch.
  assert.match(lens, /false-confidence/);
});

test('lens: discovers a responsive baseline before detecting against it', () => {
  const step0 = lens.indexOf('## Step 0');
  const step1 = lens.indexOf('## Step 1');
  assert.ok(step0 !== -1, 'lens has no Step 0 baseline discovery');
  assert.ok(step0 < step1, 'baseline discovery must precede detection');
  assert.match(lens, /no responsive baseline declared/);
});

test('lens: resolves its runtime target from config, never a hardcoded URL', () => {
  assert.match(lens, /resolveQaEnvironment/);
  assert.match(lens, /qa\.environments/);
  assert.ok(
    !/localhost:\d/.test(lens),
    'lens must not carry a hardcoded localhost target',
  );
  // Emulation is corroboration, not a device certification.
  assert.match(lens, /emulated viewport is not a device/i);
});
