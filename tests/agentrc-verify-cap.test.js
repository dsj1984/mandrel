// tests/agentrc-verify-cap.test.js
/**
 * Story #3024 / Task #3038 — `delivery.deliverRunner.verifyConcurrencyCap`
 * config key.
 *
 * Confirms:
 *   - The JSON Schema (`agentrc.schema.json`) accepts the key as a
 *     positive integer and rejects non-integer / sub-1 values.
 *   - The mirror schema (`config-settings-schema.js`) accepts the key.
 *   - `getRunners(config)` exposes `verifyConcurrencyCap` with default 4
 *     when `.agentrc.json` omits it, and forwards a configured value.
 *   - The resolved cap flows into each `waveParallelism` row emitted by
 *     `computeEpicPerfReport` (via `coerceWaveParallelismRow`).
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import Ajv from 'ajv/dist/2020.js';

import { getRunners } from '../.agents/scripts/lib/config/runners.js';
import {
  coerceWaveParallelismRow,
  computeEpicPerfReport,
} from '../.agents/scripts/lib/observability/perf-aggregator.js';
import { AGENTRC_SCHEMA } from '../.agents/scripts/lib/config-settings-schema.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

async function loadAgentRcSchema() {
  const path = `${REPO_ROOT}.agents/schemas/agentrc.schema.json`;
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

/** Compile a validator targeted at the `deliverRunner` $def in isolation
 * so the test exercises the verify-cap shape without dragging in every
 * unrelated `required` constraint on the root agentrc shape. */
function compileDeliverRunnerValidator(rootSchema) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema(rootSchema, 'agentrc.schema.json');
  return ajv.compile({ $ref: 'agentrc.schema.json#/$defs/deliverRunner' });
}

describe('delivery.deliverRunner.verifyConcurrencyCap (Story #3024)', () => {
  it('agentrc.schema.json accepts verifyConcurrencyCap as a positive integer', async () => {
    const schema = await loadAgentRcSchema();
    const validate = compileDeliverRunnerValidator(schema);
    const ok = validate({ verifyConcurrencyCap: 4 });
    assert.ok(
      ok,
      `schema should accept cap=4, errors: ${JSON.stringify(validate.errors)}`,
    );
    assert.equal(validate({ verifyConcurrencyCap: 16 }), true);
    assert.equal(
      validate({
        concurrencyCap: 3,
        progressReportIntervalSec: 120,
        verifyConcurrencyCap: 8,
      }),
      true,
      'all three keys together should validate',
    );
  });

  it('agentrc.schema.json rejects non-integer / sub-1 verifyConcurrencyCap', async () => {
    const schema = await loadAgentRcSchema();
    const validate = compileDeliverRunnerValidator(schema);
    assert.equal(
      validate({ verifyConcurrencyCap: 0 }),
      false,
      'cap=0 should fail (minimum: 1)',
    );
    assert.equal(
      validate({ verifyConcurrencyCap: 1.5 }),
      false,
      'cap=1.5 should fail (integer)',
    );
    assert.equal(
      validate({ verifyConcurrencyCap: 'four' }),
      false,
      'cap="four" should fail (integer)',
    );
  });

  it('config-settings-schema mirror exposes verifyConcurrencyCap on deliverRunner', () => {
    const deliverRunner =
      AGENTRC_SCHEMA?.properties?.delivery?.properties?.deliverRunner;
    assert.ok(deliverRunner, 'delivery.deliverRunner sub-schema present');
    const prop = deliverRunner.properties?.verifyConcurrencyCap;
    assert.ok(prop, 'verifyConcurrencyCap should be a declared property');
    assert.equal(prop.type, 'integer');
    assert.equal(prop.minimum, 1);
  });

  it('getRunners defaults verifyConcurrencyCap to 4 when omitted', () => {
    const runners = getRunners({});
    assert.equal(runners.deliverRunner.verifyConcurrencyCap, 4);
  });

  it('getRunners defaults verifyConcurrencyCap to 4 when delivery is missing entirely', () => {
    const runners = getRunners(null);
    assert.equal(runners.deliverRunner.verifyConcurrencyCap, 4);
  });

  it('getRunners forwards a configured verifyConcurrencyCap', () => {
    const runners = getRunners({
      delivery: { deliverRunner: { verifyConcurrencyCap: 8 } },
    });
    assert.equal(runners.deliverRunner.verifyConcurrencyCap, 8);
  });

  it('coerceWaveParallelismRow stamps verifyConcurrencyCap on the row', () => {
    const row = coerceWaveParallelismRow({
      waveIndex: 0,
      wallClockMs: 1000,
      summedStoryMs: 1500,
      utilisation: 0.75,
      capBinding: true,
      verifyConcurrencyCap: 6,
    });
    assert.equal(row.verifyConcurrencyCap, 6);
  });

  it('coerceWaveParallelismRow falls back to 4 when cap is missing or invalid', () => {
    const row = coerceWaveParallelismRow({
      waveIndex: 0,
      wallClockMs: 1000,
      summedStoryMs: 500,
      utilisation: 0.25,
      capBinding: false,
    });
    assert.equal(row.verifyConcurrencyCap, 4);

    const row2 = coerceWaveParallelismRow({
      waveIndex: 1,
      wallClockMs: 100,
      summedStoryMs: 100,
      utilisation: 1,
      capBinding: false,
      verifyConcurrencyCap: 0,
    });
    assert.equal(row2.verifyConcurrencyCap, 4);
  });

  it('computeEpicPerfReport carries verifyConcurrencyCap into each waveParallelism row', () => {
    const report = computeEpicPerfReport([], {
      epicId: 99,
      generatedAt: '2026-05-26T00:00:00Z',
      waveParallelism: [
        {
          waveIndex: 0,
          wallClockMs: 1000,
          summedStoryMs: 1000,
          utilisation: 0.5,
          capBinding: false,
          verifyConcurrencyCap: 4,
        },
        {
          waveIndex: 1,
          wallClockMs: 2000,
          summedStoryMs: 4000,
          utilisation: 1,
          capBinding: true,
          verifyConcurrencyCap: 8,
        },
      ],
    });
    assert.equal(report.waveParallelism.length, 2);
    assert.equal(report.waveParallelism[0].verifyConcurrencyCap, 4);
    assert.equal(report.waveParallelism[1].verifyConcurrencyCap, 8);
  });
});
