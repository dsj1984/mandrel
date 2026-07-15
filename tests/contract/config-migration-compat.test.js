// tests/contract/config-migration-compat.test.js
/**
 * Story #3504 — cross-version config-compatibility contract test for the
 * version-keyed migration runner (`lib/migrations/index.js`, landed via
 * #3501). Proves roadmap Finding 18 (remainder): an older-version
 * `.agentrc.json` migrates cleanly to the *current* agentrc JSON Schema.
 *
 * This is a contract-tier test: it asserts the *shape* of a config crossing
 * a version boundary conforms to the published schema
 * (`.agents/schemas/agentrc.schema.json`). Per testing-standards, schema
 * conformance is a contract-tier concern, so the assertions live here rather
 * than in the unit suite alongside the runner.
 *
 * The runner's `migrations` registry currently ships **empty** (v2.0.0 did
 * not register a config migration step; consumers re-sync `.agents/` and
 * re-seed `.agentrc.json`). To exercise the cross-version machinery
 * end-to-end against a real schema target, the test injects *fixture*
 * migration steps via the runner's documented `registry` seam. The fixture
 * steps transform the older config into a shape the current schema accepts:
 *
 *   1. `1.30.0` — add the `project.paths.tempRoot` key the current schema
 *      now requires (older configs predate it).
 *   2. `1.40.0` — drop the legacy top-level `legacyTooling` block the current
 *      root schema rejects (`additionalProperties: false`).
 *
 * Coverage (Story #3504 AC):
 *   - Loads an older-version config fixture, runs runMigrations across the
 *     version range, and asserts the result validates against the current
 *     agentrc schema.
 *   - Asserts a second runMigrations pass is a no-op (idempotency) over the
 *     migrated config.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import runMigrations from '../../lib/migrations/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const OLD_CONFIG_FIXTURE = path.join(
  __dirname,
  'fixtures',
  'config-migration',
  'old-agentrc.json',
);
const AGENTRC_SCHEMA = path.join(
  repoRoot,
  '.agents',
  'schemas',
  'agentrc.schema.json',
);

/** Versions the fixture range spans. The older config sits at `FROM`; the
 * current release is `TO`. Both fixture steps fall inside `(FROM, TO]`. */
const FROM_VERSION = '1.20.0';
const TO_VERSION = '1.43.0';

/** Read + parse a JSON file fresh (no shared mutable reference between tests). */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Fixture migration registry. Each step is idempotent: `detect` probes for
 * the post-condition of `apply` and returns its negation, so a second pass
 * skips every step (the idempotency contract the runner enforces).
 *
 * @returns {Array<{ version: string, description: string, detect: Function, apply: Function }>}
 */
function fixtureMigrations() {
  return [
    {
      version: '1.30.0',
      description: 'add required project.paths.tempRoot',
      detect: (ctx) => ctx?.project?.paths?.tempRoot === undefined,
      apply: (ctx) => {
        ctx.project.paths.tempRoot = 'temp';
      },
    },
    {
      version: '1.40.0',
      description: 'drop legacy top-level legacyTooling block',
      detect: (ctx) => ctx?.legacyTooling !== undefined,
      apply: (ctx) => {
        delete ctx.legacyTooling;
      },
    },
  ];
}

/** Compile a validator for the full agentrc root schema (draft 2020-12). */
function compileAgentRcValidator() {
  const schema = readJson(AGENTRC_SCHEMA);
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

describe('config migration cross-version compatibility (Story #3504)', () => {
  it('the older-version fixture does NOT validate against the current schema', () => {
    // Guard: the fixture must genuinely fail the current schema, otherwise the
    // migration would be a no-op and the test would prove nothing.
    const validate = compileAgentRcValidator();
    const oldConfig = readJson(OLD_CONFIG_FIXTURE);
    assert.equal(
      validate(oldConfig),
      false,
      'old fixture should violate the current schema before migration',
    );
  });

  it('migrates the older fixture across the version range to a schema-valid config', () => {
    const ctx = readJson(OLD_CONFIG_FIXTURE);

    const result = runMigrations({
      fromVersion: FROM_VERSION,
      toVersion: TO_VERSION,
      ctx,
      log: () => {},
      registry: fixtureMigrations(),
    });

    assert.deepEqual(
      result.applied,
      ['1.30.0', '1.40.0'],
      'both fixture steps should apply, in ascending version order',
    );

    const validate = compileAgentRcValidator();
    const valid = validate(ctx);
    assert.ok(
      valid,
      `migrated config should validate against the current agentrc schema, errors: ${JSON.stringify(
        validate.errors,
      )}`,
    );

    // Spot-check the transformations actually happened.
    assert.equal(ctx.project.paths.tempRoot, 'temp');
    assert.equal(ctx.legacyTooling, undefined);
  });

  it('a second runMigrations pass over the migrated config is a no-op (idempotency)', () => {
    const ctx = readJson(OLD_CONFIG_FIXTURE);
    const registry = fixtureMigrations();
    const range = {
      fromVersion: FROM_VERSION,
      toVersion: TO_VERSION,
      ctx,
      registry,
    };

    const first = runMigrations({ ...range, log: () => {} });
    assert.deepEqual(first.applied, ['1.30.0', '1.40.0']);

    const secondLog = [];
    const second = runMigrations({
      ...range,
      log: (msg) => secondLog.push(msg),
    });

    assert.deepEqual(second.applied, [], 'second pass should apply nothing');
    assert.deepEqual(
      second.skipped,
      ['1.30.0', '1.40.0'],
      'second pass should skip both already-applied steps',
    );
    assert.equal(secondLog.length, 0, 'no migrated log line on a no-op pass');

    // The migrated config still validates after the idempotent second pass.
    const validate = compileAgentRcValidator();
    assert.ok(
      validate(ctx),
      `config should still validate after the no-op pass, errors: ${JSON.stringify(
        validate.errors,
      )}`,
    );
  });
});
