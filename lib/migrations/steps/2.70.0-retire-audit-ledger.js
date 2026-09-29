// lib/migrations/steps/2.70.0-retire-audit-ledger.js
/**
 * Delete the retired cross-run audit ledger. Issue provenance footers are the
 * only cross-run dedup memory now, so nothing reads the file. Deletes that one
 * path and nothing else.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

const AUDIT_LEDGER_PATH = path.join('baselines', 'audit-ledger.json');

export const retireAuditLedger = {
  version: '2.70.0',
  description:
    'delete the retired baselines/audit-ledger.json — Issue provenance ' +
    'footers are the cross-run audit dedup memory (Story #5502)',
  /**
   * @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx]
   * @param {typeof nodeFs} [fsImpl]
   * @returns {boolean}
   */
  detect(ctx, fsImpl = ctx?.fs ?? nodeFs) {
    const root = ctx?.projectRoot ?? process.cwd();
    return fsImpl.existsSync(path.join(root, AUDIT_LEDGER_PATH));
  },
  /**
   * @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx]
   * @param {typeof nodeFs} [fsImpl]
   * @returns {void}
   */
  apply(ctx, fsImpl = ctx?.fs ?? nodeFs) {
    const root = ctx?.projectRoot ?? process.cwd();
    fsImpl.rmSync(path.join(root, AUDIT_LEDGER_PATH), { force: true });
  },
};
