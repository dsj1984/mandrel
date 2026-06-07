import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import {
  isUntriaged,
  ledgerPathFor,
  readLedger,
  resolveQaSession,
  resolveSessionId,
  TRIAGED_DISPOSITIONS,
} from '../../../.agents/scripts/lib/qa/qa-session.js';

/**
 * Story #3723 — session-id + ledger resume helper (Epic #3686).
 *
 * The resume seam lets a later /qa-explore run pick up where the last left
 * off: it resolves a stable session-id, finds the ledger under `temp/qa/`,
 * reads the parsed items plus the still-un-triaged subset (the rolling
 * backlog), and on a second run with the same session-id reuses the existing
 * ledger rather than overwriting it. These tests pin those four acceptance
 * criteria.
 *
 * Story #3738 adds a round-trip guard: the captured-but-untriaged items that
 * `readLedger` / `resolveQaSession` carry forward as the rolling backlog MUST
 * validate against `.agents/schemas/qa-ledger.schema.json`. If they did not,
 * any validate-on-read or validate-on-resume step would reject exactly the
 * records the resume path is built to recover.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '.agents',
  'schemas',
  'qa-ledger.schema.json',
);

/** Compile the on-disk qa-ledger schema into an AJV validator. */
function compileLedgerSchema() {
  const schema = JSON.parse(fs.readFileSync(LEDGER_SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** A schema-complete ledger item with the Capture-phase fields populated. */
function fullLedgerItem(overrides = {}) {
  return {
    id: 'L1',
    class: 'product-bug',
    severity: 'high',
    evidence: 'Save button stays disabled after a valid form is completed',
    coverage: 'invoices/new',
    missingTest:
      'A contract test asserting the save handler enables on valid input',
    ...overrides,
  };
}

let tmpRoot;
/** A config bag whose tempRoot points at an isolated tmp dir for each test. */
function configFor(root) {
  return { project: { paths: { tempRoot: root } } };
}

/** Write ndjson `items` to the session ledger, creating `qa/` as needed. */
function seedLedger(ledgerPath, items) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const body = items.map((i) => JSON.stringify(i)).join('\n');
  fs.writeFileSync(ledgerPath, `${body}\n`, 'utf8');
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-session-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveSessionId — stable id resolution', () => {
  it('prefers an explicit session-id and slugifies it', () => {
    assert.equal(
      resolveSessionId({ sessionId: 'sweep/2026 alpha' }),
      'sweep-2026-alpha',
    );
  });

  it('falls back to the QA_SESSION_ID env var', () => {
    assert.equal(
      resolveSessionId({ env: { QA_SESSION_ID: 'nightly-42' } }),
      'nightly-42',
    );
  });

  it('derives a fresh id when none is supplied', () => {
    const id = resolveSessionId({ env: {} });
    assert.match(id, /^qa-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
  });

  it('never lets a hostile label escape the qa directory', () => {
    const id = resolveSessionId({ sessionId: '../../etc/passwd' });
    assert.ok(!id.includes('/'));
    assert.ok(!id.includes('\\'));
    assert.ok(!id.includes('..'));
  });
});

describe('ledgerPathFor — path under temp/qa/', () => {
  it('places the ledger at <tempRoot>/qa/<sessionId>.ndjson', () => {
    const p = ledgerPathFor('alpha', configFor(tmpRoot));
    assert.equal(p, path.join(tmpRoot, 'qa', 'alpha.ndjson'));
  });

  it('uses the framework-default temp root when config is absent', () => {
    const p = ledgerPathFor('alpha');
    assert.equal(p, path.join('temp', 'qa', 'alpha.ndjson'));
  });
});

describe('isUntriaged — rolling-backlog predicate', () => {
  it('treats each triaged disposition as triaged', () => {
    for (const disposition of TRIAGED_DISPOSITIONS) {
      assert.equal(isUntriaged({ disposition }), false);
    }
  });

  it('treats a missing, null, or unknown disposition as untriaged', () => {
    assert.equal(isUntriaged({}), true);
    assert.equal(isUntriaged({ disposition: null }), true);
    assert.equal(isUntriaged({ disposition: '' }), true);
    assert.equal(isUntriaged({ disposition: 'pending' }), true);
  });
});

describe('readLedger — parse items + untriaged subset', () => {
  it('returns parsed items and the un-triaged subset', () => {
    const ledgerPath = ledgerPathFor('read', configFor(tmpRoot));
    seedLedger(ledgerPath, [
      { id: 'L1', disposition: 'file' },
      { id: 'L2' },
      { id: 'L3', disposition: 'defer' },
      { id: 'L4', disposition: null },
    ]);

    const { exists, items, untriaged } = readLedger(ledgerPath);

    assert.equal(exists, true);
    assert.equal(items.length, 4);
    assert.deepEqual(
      untriaged.map((i) => i.id),
      ['L2', 'L4'],
    );
  });

  it('skips blank and malformed lines rather than throwing', () => {
    const ledgerPath = ledgerPathFor('partial', configFor(tmpRoot));
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(
      ledgerPath,
      `${JSON.stringify({ id: 'L1' })}\n\n{not valid json\n`,
      'utf8',
    );

    const { items, untriaged } = readLedger(ledgerPath);

    assert.deepEqual(
      items.map((i) => i.id),
      ['L1'],
    );
    assert.equal(untriaged.length, 1);
  });

  it('reports a missing ledger as empty, not an error', () => {
    const ledgerPath = ledgerPathFor('absent', configFor(tmpRoot));
    const result = readLedger(ledgerPath);

    assert.deepEqual(result, { exists: false, items: [], untriaged: [] });
  });
});

describe('resolveQaSession — resume contract', () => {
  it('resolves a stable id and ledger path under temp/qa/', () => {
    const session = resolveQaSession({
      sessionId: 'resume-me',
      config: configFor(tmpRoot),
    });

    assert.equal(session.sessionId, 'resume-me');
    assert.equal(
      session.ledgerPath,
      path.join(tmpRoot, 'qa', 'resume-me.ndjson'),
    );
    assert.equal(session.reused, false);
    assert.deepEqual(session.items, []);
    assert.deepEqual(session.untriaged, []);
  });

  it('reads parsed items and the un-triaged backlog from an existing ledger', () => {
    const config = configFor(tmpRoot);
    const ledgerPath = ledgerPathFor('history', config);
    seedLedger(ledgerPath, [
      { id: 'L1', disposition: 'dismiss' },
      { id: 'L2' },
    ]);

    const session = resolveQaSession({ sessionId: 'history', config });

    assert.equal(session.reused, true);
    assert.equal(session.items.length, 2);
    assert.deepEqual(
      session.untriaged.map((i) => i.id),
      ['L2'],
    );
  });

  it('reuses the existing ledger on a second run rather than overwriting it', () => {
    const config = configFor(tmpRoot);
    const ledgerPath = ledgerPathFor('same-session', config);
    seedLedger(ledgerPath, [{ id: 'L1', disposition: 'file' }]);
    const originalBytes = fs.readFileSync(ledgerPath);

    const session = resolveQaSession({ sessionId: 'same-session', config });

    // The resolver must surface the reuse signal …
    assert.equal(session.reused, true);
    assert.equal(session.ledgerPath, ledgerPath);
    // … and must not have touched the on-disk ledger.
    assert.deepEqual(fs.readFileSync(ledgerPath), originalBytes);
  });
});

describe('untriaged-backlog round-trip — schema validity (Story #3738)', () => {
  const validate = compileLedgerSchema();

  it('every untriaged item readLedger returns validates against the schema', () => {
    const config = configFor(tmpRoot);
    const ledgerPath = ledgerPathFor('round-trip', config);
    // A realistic mixed ledger: a triaged item plus the captured-but-untriaged
    // shapes the Capture phase appends (disposition absent / null / sentinel).
    seedLedger(ledgerPath, [
      fullLedgerItem({ id: 'L1', disposition: 'file' }),
      fullLedgerItem({ id: 'L2', class: 'enhancement', missingTest: null }),
      fullLedgerItem({ id: 'L3', disposition: null }),
      fullLedgerItem({ id: 'L4', disposition: 'pending' }),
    ]);

    const { untriaged } = readLedger(ledgerPath);

    // The backlog is exactly the un-triaged subset …
    assert.deepEqual(
      untriaged.map((i) => i.id),
      ['L2', 'L3', 'L4'],
    );
    // … and each carried-forward item must satisfy the ledger schema.
    for (const item of untriaged) {
      const ok = validate(item);
      assert.equal(
        ok,
        true,
        `untriaged item ${item.id} failed schema: ${JSON.stringify(validate.errors)}`,
      );
      // The predicate the resume path keys off must agree it is untriaged.
      assert.equal(isUntriaged(item), true);
    }
  });

  it('resolveQaSession surfaces a schema-valid untriaged backlog on resume', () => {
    const config = configFor(tmpRoot);
    const ledgerPath = ledgerPathFor('resume-backlog', config);
    seedLedger(ledgerPath, [
      fullLedgerItem({ id: 'L1', disposition: 'dismiss' }),
      fullLedgerItem({ id: 'L2', class: 'test-gap' }),
    ]);

    const session = resolveQaSession({ sessionId: 'resume-backlog', config });

    assert.equal(session.reused, true);
    assert.deepEqual(
      session.untriaged.map((i) => i.id),
      ['L2'],
    );
    for (const item of session.untriaged) {
      const ok = validate(item);
      assert.equal(
        ok,
        true,
        `resumed item ${item.id} failed schema: ${JSON.stringify(validate.errors)}`,
      );
    }
  });
});
