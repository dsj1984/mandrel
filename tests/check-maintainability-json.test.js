import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Ajv from 'ajv';
import {
  buildMaintainabilityReport,
  MI_REPORT_KERNEL_VERSION,
} from '../.agents/scripts/check-maintainability.js';

/**
 * Schema-conformance for the MI parity envelope. MI is the `fixGuidance`-less
 * peer of check-crap's `--json` output — agent workflows consume both through
 * a single parser, so `{ kernelVersion, summary, violations }` must stay
 * structurally aligned.
 */

const SCHEMA_PATH = path.resolve('.agents/schemas/mi-report.schema.json');

function loadValidator() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  return ajv.compile(schema);
}

test('buildMaintainabilityReport — empty envelope validates against mi-report.schema.json', () => {
  const validate = loadValidator();
  const envelope = buildMaintainabilityReport(
    {},
    { regressions: 0, newFiles: 0, improvements: 0, regressedFiles: [] },
    { scope: 'diff', diffRef: 'main' },
  );
  assert.ok(
    validate(envelope),
    `empty envelope failed schema: ${JSON.stringify(validate.errors)}`,
  );
  assert.strictEqual(envelope.kernelVersion, MI_REPORT_KERNEL_VERSION);
  assert.strictEqual(envelope.violations.length, 0);
  assert.strictEqual(envelope.summary.total, 0);
  assert.strictEqual(envelope.summary.scope, 'diff');
  assert.strictEqual(envelope.summary.diffRef, 'main');
});

test('buildMaintainabilityReport — defaults scope=diff diffRef=null when scopeInfo omitted', () => {
  const validate = loadValidator();
  const envelope = buildMaintainabilityReport({}, {});
  assert.ok(validate(envelope), JSON.stringify(validate.errors));
  assert.strictEqual(envelope.summary.scope, 'diff');
  assert.strictEqual(envelope.summary.diffRef, null);
});

test('buildMaintainabilityReport — full-scope nulls diffRef', () => {
  const validate = loadValidator();
  const envelope = buildMaintainabilityReport(
    {},
    {},
    { scope: 'full', diffRef: 'main' },
  );
  assert.ok(validate(envelope), JSON.stringify(validate.errors));
  assert.strictEqual(envelope.summary.scope, 'full');
  assert.strictEqual(envelope.summary.diffRef, null);
});

test('buildMaintainabilityReport — regression envelope validates and omits fixGuidance', () => {
  const validate = loadValidator();
  const scores = {
    'lib/a.js': 70.1,
    'lib/b.js': 82.3,
  };
  const stats = {
    regressions: 1,
    newFiles: 0,
    improvements: 0,
    regressedFiles: [
      { file: 'lib/a.js', current: 70.1, baseline: 75.0, drop: 4.9 },
    ],
  };
  const envelope = buildMaintainabilityReport(scores, stats);
  assert.ok(
    validate(envelope),
    `envelope failed schema: ${JSON.stringify(validate.errors)}`,
  );
  assert.strictEqual(envelope.summary.total, 2);
  assert.strictEqual(envelope.summary.regressions, 1);
  assert.strictEqual(envelope.violations.length, 1);
  const [v] = envelope.violations;
  assert.strictEqual(v.kind, 'regression');
  assert.strictEqual(v.file, 'lib/a.js');
  assert.strictEqual(v.current, 70.1);
  assert.strictEqual(v.baseline, 75.0);
  assert.strictEqual(v.drop, 4.9);
  assert.ok(
    !Object.hasOwn(v, 'fixGuidance'),
    'MI violations must not carry fixGuidance',
  );
});

test('buildMaintainabilityReport — tolerates missing stats fields', () => {
  const envelope = buildMaintainabilityReport({}, {});
  const validate = loadValidator();
  assert.ok(validate(envelope), JSON.stringify(validate.errors));
  assert.strictEqual(envelope.summary.regressions, 0);
  assert.strictEqual(envelope.summary.newFiles, 0);
  assert.strictEqual(envelope.summary.improvements, 0);
  assert.deepStrictEqual(envelope.violations, []);
});
