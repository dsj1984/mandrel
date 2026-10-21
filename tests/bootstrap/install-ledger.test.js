import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildLedgerRecord,
  InstallLedgerCorruptError,
  ledgerPath,
  readInstallLedger,
  writeInstallLedger,
} from '../../.agents/scripts/lib/bootstrap/install-ledger.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const record = () =>
  buildLedgerRecord({
    entries: [
      {
        phaseGroup: 'core',
        target: '.gitignore',
        action: 'append',
        reversible: true,
      },
    ],
    approvedGroups: ['core'],
    appliedAt: '2026-10-21T00:00:00.000Z',
  });

describe('install ledger', () => {
  it('round-trips a written ledger and leaves no tmp sibling behind', () => {
    const root = makeTempDir('ledger-');
    const result = writeInstallLedger(root, record());
    assert.equal(result.path, ledgerPath(root));
    assert.deepEqual(readInstallLedger(root), record());
    assert.deepEqual(fs.readdirSync(path.join(root, '.agents')), [
      '.install-manifest.json',
    ]);
  });

  it('reads an absent ledger as null', () => {
    assert.equal(readInstallLedger(makeTempDir('ledger-')), null);
  });

  it('throws InstallLedgerCorruptError naming the file on a truncated ledger', () => {
    const root = makeTempDir('ledger-');
    writeInstallLedger(root, record());
    const target = ledgerPath(root);
    const full = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, full.slice(0, full.length / 2));
    assert.throws(
      () => readInstallLedger(root),
      (err) =>
        err instanceof InstallLedgerCorruptError &&
        err.name === 'InstallLedgerCorruptError' &&
        err.path === target &&
        err.message.includes(target),
    );
  });
});
