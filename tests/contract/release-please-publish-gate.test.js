// tests/contract/release-please-publish-gate.test.js
/**
 * Contract guard for the release-please npm-publish gate (Story #4126, under
 * Epic #4118 — test-health remediation).
 *
 * This is a **fast, static, contract-tier** assertion over two shipped
 * artifacts — `.github/workflows/release-please.yml` and
 * `release-please-config.json` — that locks in the un-prefixed
 * `steps.release.outputs.release_created` publish gate so the **#3891 silent
 * no-publish regression cannot recur**.
 *
 * ## The regression this freezes out (#3891)
 *
 * release-please-action v5.0.0 names its per-package outputs via
 * `setPathOutput` (verified against the action's `src/index.ts`):
 *
 *   if (path === '.') core.setOutput(key, value)            // root: UN-prefixed
 *   else              core.setOutput(`${path}--${key}`, …)   // non-root: prefixed
 *
 * The root `mandrel` package has manifest path `.` in `release-please-config.json`,
 * so its release boolean is the **un-prefixed** `release_created`. There is **no**
 * `.--release_created` output. The initial Story #3891 wiring gated the npm
 * publish on `.--release_created`, which is `undefined` on every run — so the
 * `if:` was never true and the publish silently never fired (release-please
 * still tagged + cut the GitHub Release, masking the miss).
 *
 * ## What this test asserts (and why each assertion exists)
 *
 *   1. The config keeps the root package at manifest path `.` with
 *      `package-name: "mandrel"` and `component: ""`. This is the *premise* of
 *      the whole gate: it is only because the package sits at `.` that the
 *      output is un-prefixed. If a future edit moved the package off `.`, the
 *      correct gate string would change, so the premise is asserted explicitly.
 *   2. The `release-please` job re-exports the gate as a job output sourced from
 *      the un-prefixed `steps.release.outputs.release_created` (NOT
 *      `.--release_created`).
 *   3. The `npm-publish` job's `if:` consumes that job output (`needs.
 *      release-please.outputs.<name> == 'true'`) and the resolved expression
 *      bottoms out at `release_created`, never `releases_created` (the plural
 *      "any package released" boolean — intentionally NOT the gate) and never
 *      `.--release_created`.
 *   4. Belt-and-suspenders: the literal substring `.--release_created` appears
 *      **nowhere** in the workflow file. A single regression edit reintroducing
 *      it fails here even if the structural wiring above were somehow satisfied.
 *
 * Tier: contract (static file/config shape). It does NOT carry the
 * `.integration.test.js` suffix, so it runs in the fast per-PR tier — a
 * deliberate split from the slow real-binary update e2e
 * (`tests/e2e/update-chain.integration.test.js`).
 *
 * Security: pure local filesystem reads of two in-repo artifacts. No network,
 * no shell, no secrets.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

/** Repo root, resolved from this file (`tests/contract/` → two levels up). */
const REPO_ROOT = path.resolve(
  fileURLToPath(import.meta.url),
  '..',
  '..',
  '..',
);

const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  '.github',
  'workflows',
  'release-please.yml',
);
const CONFIG_PATH = path.join(REPO_ROOT, 'release-please-config.json');

/** The correct, drift-proof gate output key for the root package. */
const CORRECT_OUTPUT_KEY = 'release_created';
/** The #3891 bug string: the non-root prefixed form that never resolves. */
const REGRESSION_OUTPUT_KEY = '.--release_created';
/** The plural "any package released" boolean — intentionally NOT the gate. */
const PLURAL_OUTPUT_KEY = 'releases_created';

/** Read + YAML-parse the workflow once for the structural assertions. */
function loadWorkflow() {
  const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const doc = yaml.load(raw);
  return { raw, doc };
}

/** Read + JSON-parse the release-please config. */
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

describe('release-please publish gate — config premise (root package at `.`)', () => {
  it('declares the root `mandrel` package at manifest path `.` with an empty component', () => {
    const config = loadConfig();

    assert.ok(
      config.packages && typeof config.packages === 'object',
      'release-please-config.json must declare a packages map',
    );
    assert.ok(
      Object.hasOwn(config.packages, '.'),
      'the root package must be keyed at manifest path "." (the reason its ' +
        'release output is un-prefixed)',
    );

    const root = config.packages['.'];
    assert.equal(
      root['package-name'],
      'mandrel',
      'the root package-name must be "mandrel"',
    );
    assert.equal(
      root.component,
      '',
      'the root package component must be "" — a non-empty component would ' +
        'change the output naming and invalidate the un-prefixed gate',
    );
  });

  it('keeps a single package so release-please stays in single-package output-naming mode', () => {
    const config = loadConfig();
    assert.equal(
      Object.keys(config.packages).length,
      1,
      'exactly one package must be declared; a second package reintroduces ' +
        'prefixed root outputs and the publish-gate ambiguity',
    );
  });
});

describe('release-please publish gate — workflow wiring', () => {
  it('re-exports the gate from the un-prefixed steps.release.outputs.release_created', () => {
    const { doc } = loadWorkflow();

    const releaseJob = doc.jobs?.['release-please'];
    assert.ok(releaseJob, 'workflow must define a `release-please` job');
    assert.ok(
      releaseJob.outputs && typeof releaseJob.outputs === 'object',
      '`release-please` job must declare outputs that re-export the gate',
    );

    // Find the job output whose expression carries the release-created signal.
    const outputEntries = Object.entries(releaseJob.outputs);
    const gateEntry = outputEntries.find(([, expr]) =>
      String(expr).includes(CORRECT_OUTPUT_KEY),
    );
    assert.ok(
      gateEntry,
      'a `release-please` job output must source ' +
        `\`steps.release.outputs.${CORRECT_OUTPUT_KEY}\``,
    );

    const [gateOutputName, gateExpr] = gateEntry;
    const exprStr = String(gateExpr);

    // It must reference the un-prefixed steps.<id>.outputs.release_created…
    assert.match(
      exprStr,
      /steps\.release\.outputs\.release_created/,
      `the gate output (${gateOutputName}) must read ` +
        'steps.release.outputs.release_created',
    );
    // …and must NOT use the #3891 prefixed form…
    assert.ok(
      !exprStr.includes(REGRESSION_OUTPUT_KEY),
      `the gate output must not read the #3891 \`${REGRESSION_OUTPUT_KEY}\` ` +
        'form (it never resolves → silent no-publish)',
    );
    // …and must NOT use the plural "any package released" boolean.
    assert.ok(
      !new RegExp(`outputs\\.${PLURAL_OUTPUT_KEY}\\b`).test(exprStr),
      `the gate output must not read the plural \`${PLURAL_OUTPUT_KEY}\` ` +
        '("any package released") — the singular release_created is the gate',
    );

    // Expose the resolved job-output name for the npm-publish assertion below.
    assert.equal(typeof gateOutputName, 'string');
  });

  it('gates the npm-publish job `if:` on that release-please job output', () => {
    const { doc } = loadWorkflow();

    const releaseJob = doc.jobs?.['release-please'];
    const publishJob = doc.jobs?.['npm-publish'];
    assert.ok(publishJob, 'workflow must define an `npm-publish` job');

    // Resolve the gate job-output name from the release-please job.
    const gateOutputName = Object.entries(releaseJob.outputs).find(([, expr]) =>
      String(expr).includes(CORRECT_OUTPUT_KEY),
    )?.[0];
    assert.ok(gateOutputName, 'gate job output must exist on release-please');

    // The publish job must depend on release-please…
    const needs = Array.isArray(publishJob.needs)
      ? publishJob.needs
      : [publishJob.needs];
    assert.ok(
      needs.includes('release-please'),
      '`npm-publish` must `needs: release-please` to consume its output',
    );

    // …and gate its `if:` on the resolved gate output == 'true'.
    const ifExpr = String(publishJob.if ?? '');
    assert.ok(
      ifExpr.length > 0,
      '`npm-publish` must carry an `if:` gate (an ungated publish defeats ' +
        'the release gate)',
    );
    assert.ok(
      ifExpr.includes(`needs.release-please.outputs.${gateOutputName}`),
      `\`npm-publish\` if: must consume needs.release-please.outputs.${gateOutputName}`,
    );
    assert.match(
      ifExpr,
      /==\s*'true'/,
      "`npm-publish` if: must compare the gate output to 'true'",
    );

    // The if: must never reference the #3891 prefixed form directly.
    assert.ok(
      !ifExpr.includes(REGRESSION_OUTPUT_KEY),
      `\`npm-publish\` if: must not reference the #3891 \`${REGRESSION_OUTPUT_KEY}\` form`,
    );
  });

  it('references the #3891 regression string `.--release_created` in no live workflow expression', () => {
    // Belt-and-suspenders scan: a single edit reintroducing the prefixed
    // output in an *active* line — even a copy/paste that bypassed the
    // structural wiring above — fails here. Full-line `#` comments are
    // stripped first because the file legitimately *documents* the bug
    // string in its header comment (naming the thing it must never use);
    // flagging that explanatory prose would be a false positive. Any
    // occurrence in YAML keys/values/expressions remains caught.
    const { raw } = loadWorkflow();

    const liveLines = raw
      .split('\n')
      // Drop whole-line comments (leading-whitespace-then-`#`). Inline
      // trailing comments are not stripped — a `${{ … }}` expression with a
      // trailing comment still counts as live, which is the safe direction.
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

    assert.ok(
      !liveLines.includes(REGRESSION_OUTPUT_KEY),
      `release-please.yml must not use the literal "${REGRESSION_OUTPUT_KEY}" ` +
        'in any live line — it is the #3891 silent-no-publish bug string and ' +
        'never resolves for a root package at manifest path "." (it may only ' +
        'appear in documentation comments)',
    );
  });
});
