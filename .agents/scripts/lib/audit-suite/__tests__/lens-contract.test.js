/**
 * lib/audit-suite/__tests__/lens-contract.test.js — the suite-wide findings
 * contract conformance gate (Story #4625).
 *
 * Every non-retired audit lens report must be machine-visible to the
 * `audit-to-stories` pipeline. Historically two lenses (`audit-sre`,
 * `audit-seo`) silently parsed to zero findings because their templates hid the
 * findings under a non-`Detailed Findings` heading, and `audit-privacy` lost
 * its dimension because it labelled the axis `Type:` — none of which any test
 * would have caught. This gate renders each lens's *own mandated template
 * example* through the real `parseAuditReport` and asserts the contract holds:
 *
 *   - the template parses to >= 1 finding under `## Detailed Findings`;
 *   - the finding carries a recognized severity on the shared
 *     `Critical | High | Medium | Low` scale;
 *   - the finding carries a recognized dimension key (never a report-name
 *     fallback);
 *   - the mandated `Location:` bullet is harvested into `files[]`;
 *   - the template documents the severity scale, an `Acceptance signal:` field,
 *     and the canonical `{{auditOutputDir}}/audit-<lens>-results.md` path;
 *   - the `## Scope` block is byte-identical across every lens that is not a
 *     registered deviant;
 *   - the dual-path preamble is single-sourced into `helpers/audit-dual-path.md`
 *     and referenced (not inlined) by each dual-path lens.
 *
 * The template example is deliberately the fixture: the same markdown an agent
 * is told to emit is the markdown the pipeline must be able to parse, so the
 * two can never drift.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AUDIT_LENSES } from '../../audit-to-stories/audit-lenses.js';
import {
  __testing,
  parseAuditReport,
} from '../../audit-to-stories/parse-audit-md.js';

/**
 * Registered exemption lists for the findings-contract gate (Story #4625).
 * These are conformance-gate policy, consumed only here, so they live beside
 * the assertions that key off them rather than as production exports.
 *
 * `RETIRED_LENSES` — a retired lens keeps its `audit-<lens>.md` workflow for
 * history but is exempt from the unified contract; `audit-lighthouse` is
 * retired wholesale by the accessibility Story, and the AC-4
 * `grep -L "Location:"` check keys off the same set.
 *
 * `SCOPE_BLOCK_EXEMPT_LENSES` — lenses whose `## Scope` block deliberately
 * deviates (whole-repo / target-set scans rather than a change-set filter), so
 * the byte-identity assertion skips them rather than forcing false uniformity.
 */
const RETIRED_LENSES = Object.freeze(['lighthouse']);
const SCOPE_BLOCK_EXEMPT_LENSES = Object.freeze([
  'documentation',
  'navigability',
]);
const isRetiredLens = (lens) => RETIRED_LENSES.includes(lens);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKFLOWS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'workflows',
);
const HELPERS_DIR = path.join(WORKFLOWS_DIR, 'helpers');

/** Lenses whose `## Execution strategy (dual-path)` block is single-sourced. */
const DUAL_PATH_LENSES = Object.freeze([
  'architecture',
  'clean-code',
  'documentation',
  'performance',
  'quality',
  'security',
]);

const RECOGNIZED_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const DIMENSION_KEYS = ['dimension', 'category', 'area', 'type'];

const NON_RETIRED_LENSES = AUDIT_LENSES.filter((lens) => !isRetiredLens(lens));

/**
 * @param {string} lens
 * @returns {string} raw `audit-<lens>.md` markdown.
 */
function readLens(lens) {
  return fs.readFileSync(path.join(WORKFLOWS_DIR, `audit-${lens}.md`), 'utf8');
}

/**
 * Extract the fenced ```markdown report-template block that contains the
 * `## Detailed Findings` section — the exact example an agent is told to emit.
 *
 * @param {string} md
 * @returns {string|null}
 */
function extractReportTemplate(md) {
  const lines = md.split(/\r?\n/);
  let inFence = false;
  let buf = null;
  for (const line of lines) {
    if (!inFence && /^```markdown\s*$/.test(line)) {
      inFence = true;
      buf = [];
      continue;
    }
    if (inFence && /^```\s*$/.test(line)) {
      const body = buf.join('\n');
      if (body.includes('## Detailed Findings')) return body;
      inFence = false;
      buf = null;
      continue;
    }
    if (inFence) buf.push(line);
  }
  return null;
}

/**
 * Extract the `## Scope (Story / plan-run mode)` section (heading through the
 * line before the next `##` heading) for byte-identity comparison.
 *
 * @param {string} md
 * @returns {string|null}
 */
function extractScopeBlock(md) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^## Scope \(Story/.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

describe('lens findings contract (Story #4625)', () => {
  for (const lens of NON_RETIRED_LENSES) {
    describe(`audit-${lens}`, () => {
      const md = readLens(lens);
      const template = extractReportTemplate(md);

      it('exposes a Detailed Findings report template', () => {
        assert.ok(
          template,
          `audit-${lens}.md has no \`\`\`markdown report template containing "## Detailed Findings"`,
        );
      });

      it('parses to >= 1 finding with a recognized severity and dimension', () => {
        const findings = parseAuditReport({
          markdown: template,
          sourceReport: `temp/audits/audit-${lens}-results.md`,
        });
        assert.ok(
          findings.length >= 1,
          `audit-${lens} template parsed to zero findings`,
        );
        const [first] = findings;
        assert.ok(
          RECOGNIZED_SEVERITIES.has(first.severity),
          `audit-${lens} finding severity "${first.severity}" is not on the Critical|High|Medium|Low scale`,
        );
        const hasDimensionKey = DIMENSION_KEYS.some((k) =>
          Object.hasOwn(first.rawFields, k),
        );
        assert.ok(
          hasDimensionKey,
          `audit-${lens} finding carries no dimension/category/area/type field — dimension would fall back to the report name`,
        );
      });

      it('harvests the mandated Location bullet into files[]', () => {
        const [first] = parseAuditReport({
          markdown: template,
          sourceReport: `temp/audits/audit-${lens}-results.md`,
        });
        assert.ok(
          first.files.length >= 1,
          `audit-${lens} finding has no files[] — the Location bullet was not extracted`,
        );
      });

      it('documents the severity scale via the shared helper', () => {
        assert.match(
          template,
          /\*\*(?:Severity|Impact):\*\*\s*\[Critical \| High \| Medium \| Low\]/,
          `audit-${lens} template does not offer the Critical|High|Medium|Low scale`,
        );
        assert.ok(
          md.includes('](helpers/audit-severity-scale.md)'),
          `audit-${lens} does not reference the shared severity-scale helper`,
        );
      });

      it('mandates an Acceptance signal field', () => {
        assert.ok(
          template.includes('**Acceptance signal:**'),
          `audit-${lens} template has no Acceptance signal field`,
        );
      });

      it('names the canonical audit output path', () => {
        assert.ok(
          md.includes(`{{auditOutputDir}}/audit-${lens}-results.md`),
          `audit-${lens} does not write the canonical output path`,
        );
      });

      it('references the shared self-cross-check helper (Story #4627)', () => {
        // Standing gate for the sequential-path false-positive guard: every
        // non-retired lens must carry the self-cross-check step, so a later
        // lens rewrite that drops it fails the suite instead of silently
        // shipping an unguarded lens. New lenses added after this Story are
        // covered because this assertion iterates NON_RETIRED_LENSES.
        assert.ok(
          md.includes('](helpers/audit-self-check.md)'),
          `audit-${lens} does not reference the self-cross-check helper (helpers/audit-self-check.md) — the sequential-path false-positive guard is missing`,
        );
      });
    });
  }

  it('shares one byte-identical scope block across all non-deviant lenses', () => {
    const exempt = new Set(SCOPE_BLOCK_EXEMPT_LENSES);
    const blocks = new Map();
    for (const lens of NON_RETIRED_LENSES) {
      if (exempt.has(lens)) continue;
      const block = extractScopeBlock(readLens(lens));
      assert.ok(block, `audit-${lens} has no "## Scope (Story ..." block`);
      blocks.set(lens, block);
    }
    const entries = [...blocks.entries()];
    const [refLens, refBlock] = entries[0];
    for (const [lens, block] of entries) {
      assert.equal(
        block,
        refBlock,
        `audit-${lens} scope block diverges from audit-${refLens}`,
      );
    }
  });

  it('single-sources the dual-path preamble into a helper', () => {
    assert.ok(
      fs.existsSync(path.join(HELPERS_DIR, 'audit-dual-path.md')),
      'helpers/audit-dual-path.md does not exist',
    );
    for (const lens of DUAL_PATH_LENSES) {
      const md = readLens(lens);
      assert.ok(
        md.includes('](helpers/audit-dual-path.md)'),
        `audit-${lens} does not reference the dual-path helper`,
      );
      assert.ok(
        !md.includes('**Strategy selection** is computed by'),
        `audit-${lens} still inlines the dual-path block body`,
      );
    }
  });

  it('ships the shared severity-scale helper', () => {
    assert.ok(
      fs.existsSync(path.join(HELPERS_DIR, 'audit-severity-scale.md')),
      'helpers/audit-severity-scale.md does not exist',
    );
  });

  it('ships the shared self-cross-check helper (Story #4627)', () => {
    assert.ok(
      fs.existsSync(path.join(HELPERS_DIR, 'audit-self-check.md')),
      'helpers/audit-self-check.md does not exist',
    );
  });
});

describe('audit-performance lens rework (Story #4631)', () => {
  const md = readLens('performance');

  it('AC-1: measures before judging — mandates cpu-prof and an Evidence field', () => {
    assert.ok(
      md.includes('cpu-prof'),
      'performance lens names no `node --cpu-prof` measurement command',
    );
    assert.ok(
      /##\s+Step 0/.test(md) && /measure/i.test(md),
      'performance lens has no mandatory measurement Step 0',
    );
    assert.ok(
      md.includes('**Evidence:**'),
      'performance lens template has no per-finding Evidence field',
    );
    assert.ok(
      /measured/.test(md) && /estimated/.test(md),
      'performance lens does not require a measured-or-estimated tag',
    );
  });

  it('AC-2: interleaving is a first-class dimension covering the concurrency defect classes', () => {
    assert.ok(
      /TOCTOU/i.test(md),
      'performance lens does not cover TOCTOU / check-then-act',
    );
    for (const concern of [
      /unawaited|floating/i,
      /read-modify-write/i,
      /temp-file/i,
      /idempoten/i,
      /shared-cache poisoning/i,
    ]) {
      assert.ok(
        concern.test(md),
        `performance lens omits a required concurrency concern: ${concern}`,
      );
    }
  });

  it('AC-3: dimensions adapt to the detected repo profile', () => {
    assert.ok(
      /profile/i.test(md) && /inapplicable/i.test(md),
      'performance lens does not branch on repo profile / declare inapplicable dimensions',
    );
    // Web-only dimension must be gated, not universal.
    assert.ok(
      /web only/i.test(md),
      'performance lens does not gate the payload/bundle dimension to web repos',
    );
  });

  it('AC-4: runs trend instead of amnesia — per-run baseline + delta reporting', () => {
    assert.ok(
      /perf-baseline\.json/.test(md),
      'performance lens does not mandate a per-run perf baseline artifact',
    );
    assert.ok(
      /(delta|diff)/i.test(md) && /baseline/i.test(md),
      'performance lens does not report deltas vs the previous baseline',
    );
    assert.ok(
      /suppress/i.test(md) && /unchanged/i.test(md),
      'performance lens does not suppress unchanged known findings',
    );
    assert.ok(
      /regress/i.test(md) && /High/.test(md),
      'performance lens does not make a regression vs baseline an automatic High',
    );
  });

  it("re-homes lighthouse's measured CWV material into the web branch", () => {
    assert.ok(
      /median-of-3/i.test(md) && /per-route/i.test(md),
      'performance lens web branch does not carry the per-route / median-of-3 CWV protocol',
    );
  });
});

describe('parseAuditReport findings-contract units (Story #4625)', () => {
  const wrap = (block) => `# Report\n\n## Detailed Findings\n\n${block}\n`;

  it('recognizes the Critical severity level', () => {
    const [f] = parseAuditReport({
      markdown: wrap(
        '### `src/a.js` — leak\n\n- **Dimension:** Injection\n- **Severity:** Critical\n- **Location:** `src/a.js:5`\n',
      ),
      sourceReport: 'audit-security-results.md',
    });
    assert.equal(f.severity, 'critical');
  });

  it('derives a per-finding dimension from a Dimension: label (no report-name fallback)', () => {
    const [f] = parseAuditReport({
      markdown: wrap(
        '### `src/log.js` — leaky log\n\n- **Dimension:** Leaky Log\n- **Impact:** High\n- **Location:** `src/log.js:9`\n',
      ),
      sourceReport: 'temp/audits/audit-privacy-results.md',
    });
    assert.equal(f.dimension, 'leaky log');
    assert.notEqual(f.dimension, 'privacy');
  });

  it('accepts the legacy Type: label via the dimension alias list', () => {
    const [f] = parseAuditReport({
      markdown: wrap(
        '### `src/log.js` — over-collection\n\n- **Type:** Data Over-collection\n- **Impact:** Medium\n- **Location:** `src/log.js:3`\n',
      ),
      sourceReport: 'temp/audits/audit-privacy-results.md',
    });
    assert.equal(f.dimension, 'data over-collection');
  });

  it('harvests Location into files[] ahead of prose scraping', () => {
    const files = __testing.deriveLocationFiles({
      location: '`src/deep/x.js:42`',
    });
    assert.deepEqual(files, ['src/deep/x.js']);
  });
});
