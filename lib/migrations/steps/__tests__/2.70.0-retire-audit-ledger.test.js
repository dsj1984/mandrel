/**
 * Story #5502 — the 2.70.0 step deletes a consumer's retired
 * `baselines/audit-ledger.json` and nothing else. Driven against a real temp
 * project root, since the step's whole contract is one file's existence.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makeTempDir } from '../../../../.agents/scripts/lib/test-temp.js';
import { compareVersions, migrations, runMigrations } from '../../index.js';
import { retireAuditLedger } from '../2.70.0-retire-audit-ledger.js';

/**
 * @param {{ ledger?: boolean }} [opts]
 * @returns {{ ctx: { projectRoot: string }, ledger: string, sibling: string }}
 */
function project({ ledger = true } = {}) {
  const projectRoot = makeTempDir('retire-audit-ledger-');
  const baselines = path.join(projectRoot, 'baselines');
  fs.mkdirSync(baselines, { recursive: true });
  const sibling = path.join(baselines, 'crap.json');
  fs.writeFileSync(sibling, '{"rows":[]}\n');
  const ledgerPath = path.join(baselines, 'audit-ledger.json');
  if (ledger) fs.writeFileSync(ledgerPath, '{"entries":[]}\n');
  return { ctx: { projectRoot }, ledger: ledgerPath, sibling };
}

describe('retireAuditLedger (2.70.0)', () => {
  it('deletes baselines/audit-ledger.json when present, and only that file', () => {
    const { ctx, ledger, sibling } = project();
    assert.equal(retireAuditLedger.detect(ctx), true);
    retireAuditLedger.apply(ctx);
    assert.equal(fs.existsSync(ledger), false);
    assert.equal(fs.existsSync(sibling), true, 'a sibling baseline survives');
  });

  it('is a no-op when the ledger is absent', () => {
    const { ctx, sibling } = project({ ledger: false });
    assert.equal(retireAuditLedger.detect(ctx), false);
    assert.doesNotThrow(() => retireAuditLedger.apply(ctx));
    assert.equal(fs.existsSync(sibling), true);
  });

  it('is idempotent: detect is false after apply, and a second pass changes nothing', () => {
    const { ctx } = project();
    const first = runMigrations({
      fromVersion: '2.69.0',
      toVersion: '2.70.0',
      ctx,
      log: () => {},
    });
    assert.deepEqual(first.applied, ['2.70.0']);
    assert.equal(retireAuditLedger.detect(ctx), false);
    const second = runMigrations({
      fromVersion: '2.69.0',
      toVersion: '2.70.0',
      ctx,
      log: () => {},
    });
    assert.deepEqual(second, { applied: [], skipped: ['2.70.0'] });
  });

  it('is registered in ascending version order', () => {
    const i = migrations.indexOf(retireAuditLedger);
    assert.ok(i > 0, 'registered');
    assert.equal(retireAuditLedger.version, '2.70.0');
    assert.equal(
      compareVersions(migrations[i - 1].version, '2.70.0') < 0,
      true,
    );
    const next = migrations[i + 1];
    if (next) assert.equal(compareVersions(next.version, '2.70.0') > 0, true);
  });
});
