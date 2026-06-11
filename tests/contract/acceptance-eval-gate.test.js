// tests/contract/acceptance-eval-gate.test.js
//
// Contract-tier coverage for the acceptance-eval.js gate boundary (Story
// #3819). Asserts:
//   - the verdict JSON Schema accepts a well-formed verdict and rejects
//     malformed ones (the gate refuses to act on a bad verdict);
//   - the emitted per-criterion signal conforms to signal-event.schema.json;
//   - runAcceptanceEval maps each decision to the correct exit code and
//     emits exactly one signal through the injected writer.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  runAcceptanceEval,
  validateVerdict,
} from '../../.agents/scripts/acceptance-eval.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(__dirname, '..', '..', '.agents', 'schemas');

function loadSchema(name) {
  return JSON.parse(readFileSync(path.join(SCHEMAS_DIR, name), 'utf8'));
}

function compile(name) {
  const schema = loadSchema(name);
  // Pick the Ajv dialect that matches the schema's declared $schema: the
  // verdict schema is draft-2020-12; signal-event.schema.json is draft-07.
  const isDraft07 =
    typeof schema.$schema === 'string' && schema.$schema.includes('draft-07');
  const ajv = isDraft07
    ? new Ajv({ allErrors: true, strict: false })
    : new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

const validVerdict = (overrides = {}) => ({
  storyId: 3819,
  epicId: null,
  schemaVersion: 1,
  round: 1,
  criteria: [
    {
      index: 0,
      criterion: 'The gate enforces the round cap.',
      verdict: 'met',
      evidence: 'acceptance-eval.js:212 exits non-zero on block',
      verifyEvidence: [
        { command: 'npm run test:quick', outcome: 'pass', detail: null },
      ],
    },
  ],
  ...overrides,
});

describe('acceptance-eval-verdict schema — conformance', () => {
  const validate = compile('acceptance-eval-verdict.schema.json');

  it('accepts a well-formed verdict (happy path)', () => {
    assert.equal(
      validate(validVerdict()),
      true,
      JSON.stringify(validate.errors),
    );
  });

  it('accepts the three verdict enum values', () => {
    for (const v of ['met', 'partial', 'unmet']) {
      const doc = validVerdict({
        criteria: [{ index: 0, criterion: 'x', verdict: v, evidence: 'e' }],
      });
      assert.equal(validate(doc), true, `verdict=${v} should validate`);
    }
  });

  it('rejects an out-of-enum verdict (negative case)', () => {
    const doc = validVerdict({
      criteria: [{ index: 0, criterion: 'x', verdict: 'maybe', evidence: 'e' }],
    });
    assert.equal(validate(doc), false);
  });

  it('rejects round below 1', () => {
    assert.equal(validate(validVerdict({ round: 0 })), false);
  });

  it('rejects an empty criteria array', () => {
    assert.equal(validate(validVerdict({ criteria: [] })), false);
  });

  it('rejects a criterion missing evidence', () => {
    const doc = validVerdict({
      criteria: [{ index: 0, criterion: 'x', verdict: 'met' }],
    });
    assert.equal(validate(doc), false);
  });

  it('rejects unknown top-level keys (closed shape)', () => {
    assert.equal(validate(validVerdict({ mystery: true })), false);
  });
});

describe('validateVerdict — gate boundary', () => {
  it('returns the verdict on a valid input', () => {
    const doc = validVerdict();
    assert.equal(validateVerdict(doc), doc);
  });

  it('throws a descriptive error on a malformed verdict', () => {
    assert.throws(
      () =>
        validateVerdict({
          storyId: 1,
          schemaVersion: 1,
          round: 1,
          criteria: [],
        }),
      /failed schema validation/,
    );
  });
});

describe('runAcceptanceEval — decision → exit-code mapping + signal emission', () => {
  const config = {}; // resolves the default cap (2) via getAcceptanceEval.

  it('maps all-met to proceed with exit 0 and emits one signal', async () => {
    const emitted = [];
    const { envelope, exitCode } = await runAcceptanceEval(
      {
        storyId: 3819,
        epicId: null,
        verdict: validVerdict(),
        config,
        emitSignal: true,
      },
      {
        appendSignalFn: async (a) => {
          emitted.push(a);
          return true;
        },
      },
    );
    assert.equal(envelope.decision, 'proceed');
    assert.equal(exitCode, 0);
    assert.equal(envelope.signalEmitted, true);
    assert.equal(emitted.length, 1);
  });

  it('maps an unmet criterion below the cap to redraft with exit 0', async () => {
    const verdict = validVerdict({
      round: 1,
      criteria: [
        { index: 0, criterion: 'a', verdict: 'met', evidence: 'e' },
        { index: 1, criterion: 'b', verdict: 'unmet', evidence: 'missing' },
      ],
    });
    const { envelope, exitCode } = await runAcceptanceEval({
      storyId: 3819,
      epicId: null,
      verdict,
      config,
      emitSignal: false,
      round: 1,
    });
    assert.equal(envelope.decision, 'redraft');
    assert.equal(exitCode, 0);
    assert.equal(envelope.unmetCriteria.length, 1);
    assert.equal(envelope.unmetCriteria[0].index, 1);
  });

  it('maps cap-reached-with-unmet to block with exit 1', async () => {
    const verdict = validVerdict({
      round: 2,
      criteria: [
        { index: 0, criterion: 'a', verdict: 'partial', evidence: 'half' },
      ],
    });
    // Round 2 is derived from the signals ledger (one prior round on
    // disk), not from the verdict's self-reported value (Story #4019).
    const { envelope, exitCode } = await runAcceptanceEval(
      {
        storyId: 3819,
        epicId: null,
        verdict,
        config,
        emitSignal: false,
      },
      {
        deriveRoundFn: () => 2,
      },
    );
    assert.equal(envelope.decision, 'block');
    assert.equal(envelope.capReached, true);
    assert.equal(exitCode, 1);
  });

  it('survives a signal-writer failure (best-effort) without failing the gate', async () => {
    const { envelope, exitCode } = await runAcceptanceEval(
      {
        storyId: 3819,
        epicId: null,
        verdict: validVerdict(),
        config,
        emitSignal: true,
      },
      {
        appendSignalFn: async () => {
          throw new Error('disk full');
        },
      },
    );
    assert.equal(envelope.decision, 'proceed');
    assert.equal(exitCode, 0);
    assert.equal(envelope.signalEmitted, false);
  });
});

describe('emitted signal conforms to signal-event.schema.json', () => {
  it('the acceptance-eval signal validates against the signal-event schema', async () => {
    const signalValidate = compile('signal-event.schema.json');
    let captured = null;
    await runAcceptanceEval(
      {
        storyId: 3819,
        epicId: 98,
        verdict: validVerdict({ epicId: 98 }),
        config: {},
        emitSignal: true,
      },
      {
        appendSignalFn: async ({ signal }) => {
          captured = signal;
          return true;
        },
      },
    );
    assert.ok(captured, 'a signal should have been emitted');
    assert.equal(
      signalValidate(captured),
      true,
      JSON.stringify(signalValidate.errors),
    );
    assert.equal(captured.kind, 'acceptance-eval');
  });
});
