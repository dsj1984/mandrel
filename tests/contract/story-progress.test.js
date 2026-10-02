/**
 * tests/contract/story-progress.test.js — the story-progress record contract
 * (Story #5553).
 *
 * Live tooling polls `<tempRoot>/orchestration/story-progress-<id>.json` to
 * see which handoff step or close phase a Story is in. This suite pins:
 *   - every record the writer produces, for both stages and every phase name
 *     the writers pass, validates against the shipped schema;
 *   - the schema is closed (no stray field) and requires `prNumber` to be
 *     present even when it is still null;
 *   - a reader polling while the record is rewritten never parses a partial
 *     file — the write lands whole through a tmp-then-rename.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { createStoryProgress } from '../../.agents/scripts/lib/orchestration/story-progress.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(
  fs.readFileSync(
    path.resolve(
      __dirname,
      '..',
      '..',
      '.agents',
      'schemas',
      'story-progress.schema.json',
    ),
    'utf8',
  ),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(SCHEMA);

const CLOSE_PHASES = [
  'wrong-tree-guard',
  'base-sync',
  'close-validation',
  'push',
  'pull-request',
  'code-review',
  'auto-merge',
  'confirm-merge',
  'post-land',
];
const HANDOFF_STEPS = [
  'preflight',
  'base-merge',
  'credited-run',
  'seat',
  'push',
  'review',
];

let tempRoot;
let config;
beforeEach(() => {
  tempRoot = makeTempDir('story-progress-contract-');
  config = { project: { paths: { tempRoot } } };
});
afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const readRecord = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function assertValid(record) {
  assert.equal(
    validate(record),
    true,
    `story-progress record violates the schema: ${ajv.errorsText(validate.errors)}`,
  );
}

describe('story-progress — the record contract', () => {
  it('the schema and the writer agree on the kind and the stage vocabulary', () => {
    assert.deepEqual(SCHEMA.properties.stage.enum, ['handoff', 'close']);
    for (const stage of SCHEMA.properties.stage.enum) {
      const rec = createStoryProgress({ storyId: 5553, stage, config });
      rec.phase('push');
      const record = readRecord(rec.file);
      assert.equal(record.kind, SCHEMA.properties.kind.const);
      assert.equal(record.stage, stage);
    }
  });

  it('AC-3: every close-phase record validates, before and after the PR number', () => {
    const rec = createStoryProgress({ storyId: 5553, stage: 'close', config });
    for (const phase of CLOSE_PHASES) {
      rec.phase(phase);
      assertValid(readRecord(rec.file));
      if (phase === 'pull-request') {
        rec.prNumber(42);
        assertValid(readRecord(rec.file));
      }
    }
    assert.equal(readRecord(rec.file).prNumber, 42);
  });

  it('AC-3: every handoff-step record validates', () => {
    const rec = createStoryProgress({
      storyId: 5553,
      stage: 'handoff',
      config,
    });
    for (const step of HANDOFF_STEPS) {
      rec.phase(step);
      const record = readRecord(rec.file);
      assertValid(record);
      assert.equal(record.stage, 'handoff');
      assert.equal(record.phase, step);
      assert.equal(record.prNumber, null);
    }
  });

  it('the schema is closed and requires an explicit prNumber', () => {
    const rec = createStoryProgress({ storyId: 5553, stage: 'close', config });
    rec.phase('push');
    const record = readRecord(rec.file);
    assert.equal(validate({ ...record, extra: true }), false);
    const { prNumber: _pr, ...withoutPr } = record;
    assert.equal(validate(withoutPr), false);
    assert.equal(validate({ ...record, stage: 'deliver' }), false);
  });

  it('AC-3: a reader polling between rewrites always parses a whole record', () => {
    const rec = createStoryProgress({ storyId: 5553, stage: 'close', config });
    rec.phase('push');
    for (let i = 0; i < 200; i += 1) {
      rec.phase(CLOSE_PHASES[i % CLOSE_PHASES.length]);
      const text = fs.readFileSync(rec.file, 'utf8');
      assertValid(JSON.parse(text));
    }
    assert.equal(fs.existsSync(`${rec.file}.tmp`), false);
  });
});
