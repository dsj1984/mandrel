/**
 * tests/audit-suite/web-lens-tool-first.test.js — Story #4630.
 *
 * Locks the tool-first refactor of the three web lenses (seo, ux-ui,
 * navigability) so a later doc-shuffle cannot silently revert them:
 *
 *   - AC-1: audit-seo carries the framework metadata-detection matrix
 *           (`generateMetadata`) and opens with the indexability gate.
 *   - AC-2: audit-rules filePatterns cover framework surfaces, so a JSX/TSX
 *           route diff selects the seo lens (and a component/css diff the ux-ui
 *           lens) through the real selector.
 *   - AC-3: audit-ux-ui mandates the design-system SSOT discovery Step 0
 *           (style-guide) and the mechanical detector battery.
 *   - AC-4: audit-navigability instructs running + triaging nav-registry-diff.js.
 *   - AC-5: audit-navigability enumerates the orphan-verification exemption
 *           taxonomy (dynamic children, system routes, inbound references).
 *   - AC-6: audit-navigability attributes the plan gate to planning.navigation
 *           and no longer to delivery.quality.navigability.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { selectLocalLenses } from '../../.agents/scripts/lib/audit-suite/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = path.resolve(HERE, '..', '..', '.agents', 'workflows');

/** Count non-overlapping occurrences of a literal substring. */
function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

const readLens = (lens) =>
  fs.readFileSync(path.join(WORKFLOWS, `audit-${lens}.md`), 'utf8');

describe('audit-seo — framework metadata detection (AC-1)', () => {
  const md = readLens('seo');

  it('names generateMetadata in the detection matrix', () => {
    assert.ok(countOccurrences(md, 'generateMetadata') >= 1);
  });

  it('opens with an indexability gate before the detection steps', () => {
    const gateIdx = md.indexOf('Indexability gate');
    const step1Idx = md.indexOf('## Step 1');
    assert.ok(gateIdx !== -1, 'no indexability gate section');
    assert.ok(
      gateIdx < step1Idx,
      'the indexability gate must precede the detection matrix',
    );
    assert.match(md, /SEO not applicable/);
  });

  it('names a mechanism-identification step and per-framework probes', () => {
    assert.match(md, /Identify the meta mechanism/);
    for (const mechanism of [
      'next/head',
      'react-helmet',
      '@unhead/vue',
      'svelte:head',
      '.astro',
    ]) {
      assert.ok(
        md.includes(mechanism),
        `detection matrix omits the ${mechanism} probe`,
      );
    }
  });

  it('defers measured Core Web Vitals to the performance lens', () => {
    assert.match(md, /audit-performance/);
  });
});

describe('audit-ux-ui — discovered-baseline auditing (AC-3)', () => {
  const md = readLens('ux-ui');

  it('references the style-guide SSOT (grep -i style-guide >= 1)', () => {
    assert.ok(countOccurrences(md.toLowerCase(), 'style-guide') >= 1);
  });

  it('mandates a design-system SSOT discovery Step 0 before detection', () => {
    const step0 = md.indexOf('Discover the design-system SSOT');
    const step1 = md.indexOf('## Step 1');
    assert.ok(step0 !== -1, 'no design-system discovery Step 0');
    assert.ok(step0 < step1, 'Step 0 must precede the detector battery');
  });

  it('names the mechanical detector battery', () => {
    assert.match(md, /Mechanical detector battery/);
    assert.match(md, /Hardcoded Values/);
    assert.match(md, /Inline-style census/);
    assert.match(md, /focus-visible/);
  });
});

describe('audit-navigability — deterministic diff + exemptions (AC-4/5/6)', () => {
  const md = readLens('navigability');

  it('instructs running and triaging nav-registry-diff.js (AC-4)', () => {
    assert.match(md, /nav-registry-diff\.js/);
    assert.match(md, /[Tt]riage/);
  });

  it('enumerates the orphan-verification exemption taxonomy (AC-5)', () => {
    assert.match(md, /Dynamic-segment children of a surfaced parent/);
    assert.match(md, /System routes/);
    assert.match(md, /Inbound in-app references/);
  });

  it('attributes the plan gate to planning.navigation (AC-6)', () => {
    assert.ok(
      countOccurrences(md, 'planning.navigation') >= 1,
      'lens must name planning.navigation',
    );
    assert.equal(
      countOccurrences(md, 'delivery.quality.navigability'),
      0,
      'lens must not attribute config to delivery.quality.navigability',
    );
  });
});

describe('selector routes web lenses on framework surfaces (AC-2)', () => {
  it('selects audit-seo on a Next app-router JSX/TSX route diff', () => {
    for (const file of [
      'app/blog/[slug]/page.tsx',
      'pages/about.jsx',
      'src/routes/dashboard.tsx',
      'app/sitemap.ts',
    ]) {
      const selected = selectLocalLenses({ changedFiles: [file] });
      assert.ok(
        selected.includes('audit-seo'),
        `audit-seo must select on ${file}, got ${JSON.stringify(selected)}`,
      );
    }
  });

  it('selects audit-ux-ui on a component / design-token diff', () => {
    for (const file of [
      'src/components/ui/Button.tsx',
      'src/styles/base.css',
      'tailwind.config.ts',
      'design-system/tokens.css',
    ]) {
      const selected = selectLocalLenses({ changedFiles: [file] });
      assert.ok(
        selected.includes('audit-ux-ui'),
        `audit-ux-ui must select on ${file}, got ${JSON.stringify(selected)}`,
      );
    }
  });

  it('does not select the web lenses on a backend-only diff', () => {
    const selected = selectLocalLenses({
      changedFiles: ['.agents/scripts/lib/orchestration/close-pipeline.js'],
    });
    assert.ok(!selected.includes('audit-seo'));
    assert.ok(!selected.includes('audit-ux-ui'));
  });
});
