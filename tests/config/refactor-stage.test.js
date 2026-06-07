// tests/config/refactor-stage.test.js
//
// Contract-tier coverage for the opt-in `delivery.refactorStage` config key
// (Story #3430, Epic #3418). Asserts the key is recognized by the runtime
// AJV schema and its static JSON-Schema mirror, that the two agree on shape
// (mirror-drift contract), and that an unset key resolves to `false` via the
// framework defaults in `.agents/docs/agentrc-reference.json`.

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readSchema } from '../../.agents/scripts/generate-config-docs.js';
import {
  getAgentrcDefaults,
  lookupPath,
} from '../../.agents/scripts/lib/config/defaults.js';
import { AGENTRC_SCHEMA } from '../../.agents/scripts/lib/config-settings-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIRROR_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '.agents',
  'schemas',
  'agentrc.schema.json',
);

const REQ = Object.freeze({
  project: {
    paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
  },
});

// Runtime AJV schema (authoritative) + static JSON-Schema mirror (advisory).
const runtimeAjv = new Ajv({ allErrors: true });
addFormats(runtimeAjv);
const runtimeValidator = runtimeAjv.compile(AGENTRC_SCHEMA);

const mirror = readSchema(MIRROR_PATH);
const ajv2020 = new Ajv2020({ allErrors: true });
addFormats(ajv2020);
const mirrorValidator = ajv2020.compile(mirror);

describe('delivery.refactorStage — opt-in config key', () => {
  it('accepts enabled:true on both the runtime schema and the mirror', () => {
    const doc = { ...REQ, delivery: { refactorStage: { enabled: true } } };
    assert.equal(runtimeValidator(doc), true, 'runtime AJV should accept');
    assert.equal(mirrorValidator(doc), true, 'mirror should accept');
  });

  it('accepts enabled:false on both schemas', () => {
    const doc = { ...REQ, delivery: { refactorStage: { enabled: false } } };
    assert.equal(runtimeValidator(doc), true, 'runtime AJV should accept');
    assert.equal(mirrorValidator(doc), true, 'mirror should accept');
  });

  it('accepts an omitted refactorStage block (additive, not required)', () => {
    const doc = { ...REQ, delivery: {} };
    assert.equal(runtimeValidator(doc), true, 'runtime AJV should accept');
    assert.equal(mirrorValidator(doc), true, 'mirror should accept');
  });

  it('rejects a non-boolean enabled on both schemas', () => {
    const doc = { ...REQ, delivery: { refactorStage: { enabled: 'yes' } } };
    assert.equal(runtimeValidator(doc), false, 'runtime AJV should reject');
    assert.equal(mirrorValidator(doc), false, 'mirror should reject');
  });

  it('rejects an unknown property inside refactorStage on both schemas', () => {
    const doc = {
      ...REQ,
      delivery: { refactorStage: { enabled: true, mystery: 1 } },
    };
    assert.equal(runtimeValidator(doc), false, 'runtime AJV should reject');
    assert.equal(mirrorValidator(doc), false, 'mirror should reject');
  });
});

describe('delivery.refactorStage — default resolution', () => {
  it('defaults to false in the framework defaults (unset → false)', () => {
    const defaults = getAgentrcDefaults({ bustCache: true });
    const { present, value } = lookupPath(
      defaults,
      'delivery.refactorStage.enabled',
    );
    assert.equal(present, true, 'default must be present in full-agentrc.json');
    assert.equal(value, false, 'default must resolve to false');
  });
});
