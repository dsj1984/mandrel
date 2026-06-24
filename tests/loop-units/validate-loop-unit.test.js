import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkLoopUnits,
  collectLoopUnitFiles,
  isLoopUnitFile,
} from '../../.agents/scripts/check-loop-units.js';
import {
  DEFAULT_SCHEMA_PATH,
  LoopUnitParseError,
  parseFrontmatter,
  validateLoopUnit,
} from '../../.agents/scripts/lib/loop-units/validate-loop-unit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

const fixture = (name) => path.join(FIXTURES, name);

test('loop-unit schema compiles as a valid JSON Schema', () => {
  // A load + AJV-compile check: validateLoopUnit on a known-good unit
  // exercises the full Ajv2020 compile path; if the schema were not a
  // valid JSON Schema, compilation would throw here.
  const result = validateLoopUnit(fixture('valid-self-paced.md'));
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.issues, []);
  // And the schema file itself parses as JSON.
  const raw = fs.readFileSync(DEFAULT_SCHEMA_PATH, 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
});

test('a valid self-paced loop unit (with verify) passes validation', () => {
  const result = validateLoopUnit(fixture('valid-self-paced.md'));
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.data.loop.cadence, 'self-paced');
  assert.strictEqual(result.data.loop.verify, 'npm run docs:check');
});

test('a valid interval loop unit with no verify passes validation', () => {
  // verify is conditionally required only for self-paced; interval/cron
  // omit it freely.
  const result = validateLoopUnit(fixture('valid-interval-no-verify.md'));
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.data.loop.cadence, 'interval');
  assert.strictEqual(result.data.loop.verify, undefined);
});

test('verify-as-array is accepted', () => {
  const data = parseFrontmatter(
    [
      '---',
      'loop:',
      '  cadence: cron',
      '  goal: nightly sweep',
      '  verify:',
      '    - npm run lint',
      '    - npm test',
      '---',
      '',
      '# body',
    ].join('\n'),
  );
  assert.deepStrictEqual(data.loop.verify, ['npm run lint', 'npm test']);
});

test('a self-paced loop unit missing verify fails, naming the missing field', () => {
  const result = validateLoopUnit(fixture('malformed-missing-verify.md'));
  assert.strictEqual(result.valid, false);
  assert.ok(result.issues.length > 0, 'expected at least one issue');
  // The message must name the missing field so the operator can act on it.
  const joined = result.issues.map((i) => `${i.path} ${i.message}`).join('\n');
  assert.match(joined, /verify/, 'issue should name the missing verify field');
});

test('a loop unit missing the required goal fails, naming goal', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-unit-'));
  try {
    const file = path.join(tmp, 'missing-goal.md');
    fs.writeFileSync(
      file,
      ['---', 'loop:', '  cadence: interval', '---', '', '# body'].join('\n'),
    );
    const result = validateLoopUnit(file);
    assert.strictEqual(result.valid, false);
    const joined = result.issues
      .map((i) => `${i.path} ${i.message}`)
      .join('\n');
    assert.match(joined, /goal/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an invalid cadence enum value fails validation', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-unit-'));
  try {
    const file = path.join(tmp, 'bad-cadence.md');
    fs.writeFileSync(
      file,
      ['---', 'loop:', '  cadence: hourly', '  goal: do a thing', '---'].join(
        '\n',
      ),
    );
    const result = validateLoopUnit(file);
    assert.strictEqual(result.valid, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a file with no frontmatter throws LoopUnitParseError', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-unit-'));
  try {
    const file = path.join(tmp, 'no-frontmatter.md');
    fs.writeFileSync(file, '# just a heading, no frontmatter\n');
    assert.throws(() => validateLoopUnit(file), LoopUnitParseError);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkLoopUnits reports a clean pass for an absent directory', () => {
  const absent = path.join(os.tmpdir(), `loop-units-absent-${Date.now()}`);
  const result = checkLoopUnits(absent);
  assert.deepStrictEqual(result.files, []);
  assert.deepStrictEqual(result.failures, []);
});

test('checkLoopUnits reports a clean pass for an empty directory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-units-empty-'));
  try {
    assert.deepStrictEqual(collectLoopUnitFiles(tmp), []);
    const result = checkLoopUnits(tmp);
    assert.deepStrictEqual(result.failures, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkLoopUnits surfaces an invalid unit with its file path and field', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-units-bad-'));
  try {
    const file = path.join(tmp, 'broken.md');
    fs.copyFileSync(fixture('malformed-missing-verify.md'), file);
    const result = checkLoopUnits(tmp);
    assert.strictEqual(result.failures.length, 1);
    assert.strictEqual(result.failures[0].file, file);
    const joined = result.failures[0].issues
      .map((i) => `${i.path} ${i.message}`)
      .join('\n');
    assert.match(joined, /verify/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isLoopUnitFile excludes README.md (any case) but accepts other *.md', () => {
  assert.strictEqual(isLoopUnitFile('README.md'), false);
  assert.strictEqual(isLoopUnitFile('readme.md'), false);
  assert.strictEqual(isLoopUnitFile('fix-failing-tests.md'), true);
  assert.strictEqual(isLoopUnitFile('notes.txt'), false);
});

test('collectLoopUnitFiles skips the directory README so the gate ignores it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-units-readme-'));
  try {
    // A README with no loop frontmatter must not be treated as a unit.
    fs.writeFileSync(
      path.join(tmp, 'README.md'),
      '# Loops\n\nNamespace docs, not a loop unit.\n',
      'utf8',
    );
    fs.copyFileSync(
      fixture('valid-self-paced.md'),
      path.join(tmp, 'fix-failing-tests.md'),
    );
    const collected = collectLoopUnitFiles(tmp).map((p) => path.basename(p));
    assert.deepStrictEqual(collected, ['fix-failing-tests.md']);
    // And the gate is a clean pass — the README is never validated.
    const result = checkLoopUnits(tmp);
    assert.deepStrictEqual(result.failures, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
