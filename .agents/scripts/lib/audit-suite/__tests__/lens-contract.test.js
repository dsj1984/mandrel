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
