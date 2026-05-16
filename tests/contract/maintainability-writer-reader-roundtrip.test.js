/**
 * Contract — Story #2117.
 *
 * Pins the maintainability baseline writer/reader round-trip. Regression
 * boundary: `lib/maintainability-utils.js:saveBaseline` previously emitted
 * a legacy flat `{ path: mi }` map that `lib/baselines/reader.js` then
 * rejected against `baselines/maintainability.schema.json`. The fix routes
 * `saveBaseline` through the shared envelope writer; this contract test
 * ensures any future regression of that wiring fails here, *before* the
 * close-validation `check-baselines` gate breaks the next merge.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { loadFile as loadBaselineFile } from '../../.agents/scripts/lib/baselines/reader.js';
import { saveBaseline } from '../../.agents/scripts/lib/maintainability-utils.js';

describe('maintainability writer/reader round-trip', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mandrel-mi-roundtrip-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('saveBaseline output passes the schema-aware reader without schema errors', () => {
    const baselinePath = path.join(dir, 'maintainability.json');
    saveBaseline(
      {
        'src/a.js': 95.5,
        'src/b.js': 80,
        'src/c.js': 70.25,
      },
      baselinePath,
    );

    const envelope = loadBaselineFile(baselinePath, {
      kind: 'maintainability',
    });

    assert.ok(Array.isArray(envelope.rows));
    assert.equal(envelope.rows.length, 3);
    assert.deepEqual(envelope.rows.map((r) => r.path).sort(), [
      'src/a.js',
      'src/b.js',
      'src/c.js',
    ]);
    assert.ok(envelope.rollup && Object.hasOwn(envelope.rollup, '*'));
    assert.equal(typeof envelope.kernelVersion, 'string');
    assert.equal(typeof envelope.generatedAt, 'string');
  });

  it('an empty baseline still produces a schema-valid envelope', () => {
    const baselinePath = path.join(dir, 'empty.json');
    saveBaseline({}, baselinePath);
    const envelope = loadBaselineFile(baselinePath, {
      kind: 'maintainability',
    });
    assert.deepEqual(envelope.rows, []);
    assert.ok(Object.hasOwn(envelope.rollup, '*'));
  });
});
