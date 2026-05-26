// tests/agentrc-retro-perf-thresholds.test.js
/**
 * Story #3042 / Task #3043 — `delivery.retro.perfThresholds` config keys.
 *
 * Confirms:
 *   - The static JSON Schema (`agentrc.schema.json`) accepts the keys with
 *     correct types/bounds and rejects invalid values.
 *   - The mirror schema (`config-settings-schema.js`) exposes the same
 *     shape under `delivery.retro.perfThresholds`.
 *   - `getRetro(config)` exposes resolved keys with defaults 0.6 / 0.4 / 2
 *     when `.agentrc.json` omits them, and forwards a configured value.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';

import { getRetro } from '../.agents/scripts/lib/config/retro.js';
import { AGENTRC_SCHEMA } from '../.agents/scripts/lib/config-settings-schema.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

async function loadAgentRcSchema() {
  const path = `${REPO_ROOT}.agents/schemas/agentrc.schema.json`;
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

function compileRetroValidator(rootSchema) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema(rootSchema, 'agentrc.schema.json');
  return ajv.compile({ $ref: 'agentrc.schema.json#/$defs/retro' });
}

describe('delivery.retro.perfThresholds (Story #3043)', () => {
  it('agentrc.schema.json accepts the perfThresholds object', async () => {
    const schema = await loadAgentRcSchema();
    const validate = compileRetroValidator(schema);
    const ok = validate({
      perfThresholds: {
        utilisation: 0.6,
        bootstrapShare: 0.4,
        capBindingRunLength: 2,
      },
    });
    assert.ok(
      ok,
      `schema should accept the canonical shape, errors: ${JSON.stringify(validate.errors)}`,
    );
    assert.equal(validate({ perfThresholds: {} }), true);
    assert.equal(validate({}), true);
  });

  it('agentrc.schema.json rejects out-of-range or non-numeric thresholds', async () => {
    const schema = await loadAgentRcSchema();
    const validate = compileRetroValidator(schema);
    assert.equal(
      validate({ perfThresholds: { utilisation: -0.1 } }),
      false,
      'utilisation < 0 should fail',
    );
    assert.equal(
      validate({ perfThresholds: { utilisation: 1.5 } }),
      false,
      'utilisation > 1 should fail',
    );
    assert.equal(
      validate({ perfThresholds: { bootstrapShare: 2 } }),
      false,
      'bootstrapShare > 1 should fail',
    );
    assert.equal(
      validate({ perfThresholds: { capBindingRunLength: 0 } }),
      false,
      'capBindingRunLength must be >= 1',
    );
    assert.equal(
      validate({ perfThresholds: { capBindingRunLength: 1.5 } }),
      false,
      'capBindingRunLength must be integer',
    );
  });

  it('config-settings-schema mirror exposes perfThresholds on delivery.retro', () => {
    const retro = AGENTRC_SCHEMA?.properties?.delivery?.properties?.retro;
    assert.ok(retro, 'delivery.retro sub-schema present');
    const perfThresholds = retro.properties?.perfThresholds;
    assert.ok(perfThresholds, 'perfThresholds sub-schema present');
    assert.equal(perfThresholds.properties?.utilisation?.type, 'number');
    assert.equal(perfThresholds.properties?.bootstrapShare?.type, 'number');
    assert.equal(
      perfThresholds.properties?.capBindingRunLength?.type,
      'integer',
    );
  });

  it('getRetro exposes defaults 0.6 / 0.4 / 2 when config omits the keys', () => {
    const resolved = getRetro({});
    assert.deepEqual(resolved.perfThresholds, {
      utilisation: 0.6,
      bootstrapShare: 0.4,
      capBindingRunLength: 2,
    });
  });

  it('getRetro exposes defaults when delivery / retro is missing entirely', () => {
    assert.deepEqual(getRetro(null).perfThresholds, {
      utilisation: 0.6,
      bootstrapShare: 0.4,
      capBindingRunLength: 2,
    });
    assert.deepEqual(getRetro(undefined).perfThresholds, {
      utilisation: 0.6,
      bootstrapShare: 0.4,
      capBindingRunLength: 2,
    });
    assert.deepEqual(getRetro({ delivery: {} }).perfThresholds, {
      utilisation: 0.6,
      bootstrapShare: 0.4,
      capBindingRunLength: 2,
    });
  });

  it('getRetro forwards configured values', () => {
    const resolved = getRetro({
      delivery: {
        retro: {
          perfThresholds: {
            utilisation: 0.8,
            bootstrapShare: 0.3,
            capBindingRunLength: 3,
          },
        },
      },
    });
    assert.deepEqual(resolved.perfThresholds, {
      utilisation: 0.8,
      bootstrapShare: 0.3,
      capBindingRunLength: 3,
    });
  });

  it('getRetro falls back to defaults for invalid runtime values', () => {
    const resolved = getRetro({
      delivery: {
        retro: {
          perfThresholds: {
            utilisation: -1,
            bootstrapShare: 2,
            capBindingRunLength: 0,
          },
        },
      },
    });
    assert.deepEqual(resolved.perfThresholds, {
      utilisation: 0.6,
      bootstrapShare: 0.4,
      capBindingRunLength: 2,
    });
  });
});
