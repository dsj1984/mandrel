import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  bodyReferencesParam,
  checkFile,
  discoverFeatures,
  discoverStepDefs,
  extractPlaceholders,
  maskDocStrings,
  parseOutlines,
  parseStepDefs,
  resolveBinding,
  runCheck,
  substitutePlaceholders,
} from '../../.agents/scripts/check-gherkin-placeholders.js';

/**
 * Unit coverage for the Gherkin placeholder-reference lint validator.
 *
 * Strategy: build a minimal fake repo in tmpdir with a `tests/features/`
 * tree of `.feature` files and a `tests/steps/` tree of step definitions,
 * then drive `runCheck` with that repo root. The three AC scenarios live
 * first (tautological step-def → non-zero, correct step-def → zero, wired
 * into the gate is covered by the package.json scripts assertion), followed
 * by helper-level tests pinning the parser, binder, and consumption checks.
 *
 * No tracked `.feature` file is added to the repo — this project is
 * acceptance::n-a; every fixture is constructed inline in a temp dir.
 */

function makeFakeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-gherkin-ph-'));
  fs.mkdirSync(path.join(root, 'tests', 'features'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests', 'steps'), { recursive: true });
  return root;
}

function write(root, relPath, body) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

const CORRECT_FEATURE = `@domain-billing
Feature: Invoice export access

  Scenario Outline: <user-role> access to invoice exports
    Given a signed-in <user-role>
    When they request an invoice export
    Then the export is <export-outcome>

    Examples:
      | user-role     | export-outcome |
      | account-owner | delivered      |
      | viewer        | denied         |
`;

// --- AC scenario (a): tautological step-def → non-zero --------------------

test('runCheck (a) tautological step-def: a placeholder never asserted exits non-zero', () => {
  const root = makeFakeRepo();
  write(root, 'tests/features/exports.feature', CORRECT_FEATURE);
  // The `<export-outcome>` placeholder threads into the Then step, but the
  // bound step definition asserts a constant and never reads the captured
  // value — a tautological matrix.
  write(
    root,
    'tests/steps/exports.steps.ts',
    [
      "Given('a signed-in {string}', (role) => {",
      '  this.role = role;',
      '});',
      "When('they request an invoice export', () => {",
      '  this.result = exportInvoices();',
      '});',
      "Then('the export is {string}', (expectedOutcome) => {",
      '  expect(true).toBe(true);',
      '});',
    ].join('\n'),
  );

  const result = runCheck({ repoRoot: root });
  assert.equal(
    result.exitCode,
    1,
    `expected a violation; got ${JSON.stringify(result.violations, null, 2)}`,
  );
  const v = result.violations.find((x) => x.kind === 'unconsumed-placeholder');
  assert.ok(
    v,
    `expected unconsumed-placeholder; got ${JSON.stringify(result.violations)}`,
  );
  assert.equal(v.file, 'tests/features/exports.feature');
  assert.match(v.message, /export-outcome/);
});

// --- AC scenario (b): correct step-def → zero -----------------------------

test('runCheck (b) correct step-def: every placeholder asserted exits 0', () => {
  const root = makeFakeRepo();
  write(root, 'tests/features/exports.feature', CORRECT_FEATURE);
  write(
    root,
    'tests/steps/exports.steps.ts',
    [
      "Given('a signed-in {string}', (role) => {",
      '  this.role = role;',
      '  signInAs(role);',
      '});',
      "When('they request an invoice export', () => {",
      '  this.result = exportInvoices();',
      '});',
      "Then('the export is {string}', (expectedOutcome) => {",
      '  expect(this.result.status).toBe(expectedOutcome);',
      '});',
    ].join('\n'),
  );

  const result = runCheck({ repoRoot: root });
  assert.equal(
    result.exitCode,
    0,
    `unexpected violations: ${JSON.stringify(result.violations, null, 2)}`,
  );
  assert.equal(result.violations.length, 0);
  assert.equal(result.scanned, 1);
});

test('runCheck (b2) regex-literal step-def reading its capture exits 0', () => {
  const root = makeFakeRepo();
  write(root, 'tests/features/exports.feature', CORRECT_FEATURE);
  write(
    root,
    'tests/steps/exports.steps.js',
    [
      'Given(/^a signed-in (.+)$/, (role) => {',
      '  signInAs(role);',
      '});',
      "When('they request an invoice export', () => {",
      '  ctx.result = exportInvoices();',
      '});',
      'Then(/^the export is (.+)$/, (expectedOutcome) => {',
      '  assert.equal(ctx.result.status, expectedOutcome);',
      '});',
    ].join('\n'),
  );

  const result = runCheck({ repoRoot: root });
  assert.equal(
    result.exitCode,
    0,
    `unexpected violations: ${JSON.stringify(result.violations, null, 2)}`,
  );
});

test('runCheck (b3) regex-literal tautological step-def is flagged', () => {
  const root = makeFakeRepo();
  write(root, 'tests/features/exports.feature', CORRECT_FEATURE);
  write(
    root,
    'tests/steps/exports.steps.js',
    [
      'Given(/^a signed-in (.+)$/, (role) => {',
      '  signInAs(role);',
      '});',
      "When('they request an invoice export', () => {",
      '  ctx.result = exportInvoices();',
      '});',
      'Then(/^the export is (.+)$/, () => {',
      '  assert.ok(true);',
      '});',
    ].join('\n'),
  );

  const result = runCheck({ repoRoot: root });
  assert.equal(result.exitCode, 1);
  assert.ok(
    result.violations.some(
      (v) =>
        v.kind === 'unconsumed-placeholder' && /export-outcome/.test(v.message),
    ),
  );
});

// --- Discovery ------------------------------------------------------------

test('discoverFeatures: finds nested .feature files and ignores others', () => {
  const root = makeFakeRepo();
  write(root, 'tests/features/a.feature', '# a\n');
  write(root, 'tests/features/nested/b.feature', '# b\n');
  write(root, 'tests/features/readme.md', '# not a feature\n');
  const files = discoverFeatures(root, ['tests/features']);
  const rels = files.map((f) =>
    path.relative(root, f).split(path.sep).join('/'),
  );
  assert.deepEqual(rels, [
    'tests/features/a.feature',
    'tests/features/nested/b.feature',
  ]);
});

test('discoverStepDefs: finds .ts/.js step files, skips node_modules', () => {
  const root = makeFakeRepo();
  write(root, 'tests/steps/x.steps.ts', 'Given();\n');
  write(root, 'tests/steps/y.steps.js', 'When();\n');
  write(root, 'tests/steps/node_modules/dep.js', 'Then();\n');
  const files = discoverStepDefs(root, ['tests/steps']);
  const rels = files.map((f) =>
    path.relative(root, f).split(path.sep).join('/'),
  );
  assert.ok(rels.includes('tests/steps/x.steps.ts'));
  assert.ok(rels.includes('tests/steps/y.steps.js'));
  assert.equal(rels.includes('tests/steps/node_modules/dep.js'), false);
});

// --- Parsing --------------------------------------------------------------

test('parseOutlines: collects only Scenario Outline blocks with their steps + headers', () => {
  const src = [
    'Feature: f',
    '',
    '  Scenario: plain one',
    '    Given a plain step',
    '',
    '  Scenario Outline: outline one',
    '    Given a <role>',
    '    Then the result is <outcome>',
    '    Examples:',
    '      | role | outcome |',
    '      | a    | b       |',
  ].join('\n');
  const outlines = parseOutlines(maskDocStrings(src));
  assert.equal(outlines.length, 1);
  assert.equal(outlines[0].steps.length, 2);
  assert.ok(outlines[0].exampleHeaders.has('role'));
  assert.ok(outlines[0].exampleHeaders.has('outcome'));
});

test('extractPlaceholders: pulls <names> from step text', () => {
  assert.deepEqual(extractPlaceholders('the export is <export-outcome>'), [
    'export-outcome',
  ]);
  assert.deepEqual(extractPlaceholders('no placeholders here'), []);
});

test('maskDocStrings: blanks triple-quoted doc-strings while preserving lines', () => {
  const src = 'Given x\n"""\n<not-a-placeholder>\n"""\nThen y\n';
  const masked = maskDocStrings(src);
  assert.equal(masked.split('\n').length, src.split('\n').length);
  assert.equal(masked.includes('<not-a-placeholder>'), false);
  assert.ok(masked.includes('Given x'));
  assert.ok(masked.includes('Then y'));
});

// --- Step-def parsing & binding -------------------------------------------

test('parseStepDefs: parses cucumber-expression and regex-literal steps', () => {
  const src = [
    "Given('the {actor} has {int} invoices', (actor, count) => { use(actor, count); });",
    'When(/^they pay (\\d+)$/, (amount) => { pay(amount); });',
  ].join('\n');
  const defs = parseStepDefs(src);
  assert.equal(defs.length, 2);
  assert.deepEqual(defs[0].paramNames, ['actor', 'int']);
  assert.deepEqual(defs[1].paramNames, ['$1']);
});

test('substitutePlaceholders: replaces <ph> with ordered stand-in tokens', () => {
  const { substituted, order } = substitutePlaceholders(
    'a <role> sees <outcome>',
  );
  assert.deepEqual(order, ['role', 'outcome']);
  assert.match(substituted, /zphz0zqz/);
  assert.match(substituted, /zphz1zqz/);
});

test('resolveBinding: maps a placeholder to the capturing step-def parameter', () => {
  const defs = parseStepDefs(
    "Then('the export is {string}', (expectedOutcome) => { expect(s).toBe(expectedOutcome); });",
  );
  const binding = resolveBinding('the export is <export-outcome>', defs);
  assert.ok(binding);
  assert.equal(binding.captures.length, 1);
  assert.equal(binding.captures[0].placeholder, 'export-outcome');
  // The capture binds to the handler's positional formal parameter — the
  // channel a captured Examples value reaches an assertion through — not the
  // cucumber type name (`string`).
  assert.equal(binding.captures[0].paramName, 'expectedOutcome');
});

test('bodyReferencesParam: true when body names the param, false for tautology', () => {
  assert.equal(
    bodyReferencesParam('expect(x).toBe(expectedOutcome);', 'expectedOutcome'),
    true,
  );
  assert.equal(
    bodyReferencesParam('expect(true).toBe(true);', 'expectedOutcome'),
    false,
  );
  // positional capture
  assert.equal(bodyReferencesParam('assert.equal(a, b);', '$1'), true);
  assert.equal(bodyReferencesParam('assert.ok(true);', '$1'), false);
});

// --- Edge cases -----------------------------------------------------------

test('checkFile: a placeholder used in a step but absent from Examples is not flagged', () => {
  const root = makeFakeRepo();
  // `<ghost>` has no Examples column → out of this validator's lane.
  const feature = [
    'Feature: f',
    '  Scenario Outline: o',
    '    Given a <role>',
    '    Then a <ghost> appears',
    '    Examples:',
    '      | role |',
    '      | a    |',
  ].join('\n');
  const abs = write(root, 'tests/features/o.feature', feature);
  const defs = parseStepDefs(
    "Given('a {string}', (r) => { use(r); });\nThen('a {string} appears', () => { expect(true).toBe(true); });",
  );
  const violations = checkFile(abs, root, defs);
  assert.equal(
    violations.find((v) => /ghost/.test(v.message)),
    undefined,
  );
});

test('runCheck: empty feature tree exits 0 with zero scanned', () => {
  const root = makeFakeRepo();
  const result = runCheck({ repoRoot: root });
  assert.equal(result.exitCode, 0);
  assert.equal(result.scanned, 0);
});

test('package.json wires the check into the docs:check gate', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  );
  assert.match(pkg.scripts['docs:check'], /check-gherkin-placeholders\.js/);
});
