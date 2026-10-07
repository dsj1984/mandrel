/**
 * The SCA gate's committed exceptions file (`audit-exceptions.json`):
 * `{ exceptions: [{ id, package, reason, reviewBy }] }` — reviewed, dated
 * suppressions of advisories that have no patched release. `reviewBy` is the
 * entry's expiry; a package-scoped entry whose package left the tree is `dead`.
 *
 * @module lib/audit-exceptions/adapters/sca-exceptions
 */

import { lineOf } from '../locate.js';
import { readJsonc, readText } from '../read.js';
import { makeRecord } from '../record.js';
import { nameProbe } from './dependency-policy.js';

const SCA_EXCEPTIONS_FILE = 'audit-exceptions.json';

function entryRecord(ctx, text, entry) {
  const review =
    typeof entry.reviewBy === 'string' ? ` expires: ${entry.reviewBy}` : '';
  return makeRecord({
    adapter: 'sca-exceptions',
    category: 'dependency',
    surface: 'sca-exceptions',
    file: SCA_EXCEPTIONS_FILE,
    line: lineOf(text, entry.id),
    target: entry.package ? `${entry.id}|${entry.package}` : entry.id,
    rule: 'sca-exceptions',
    justification: entry.reason ? `${entry.reason}${review}` : null,
    probe: entry.package
      ? nameProbe(ctx, entry.package)
      : { verdict: 'live', basis: 'advisory-unprobed' },
  });
}

function extract(ctx) {
  const config = readJsonc(ctx.root, SCA_EXCEPTIONS_FILE);
  if (config === null) {
    ctx.degrade('config-not-statically-readable', SCA_EXCEPTIONS_FILE);
    return [];
  }
  const text = readText(ctx.root, SCA_EXCEPTIONS_FILE);
  return (config.exceptions ?? [])
    .filter((e) => typeof e?.id === 'string')
    .map((e) => entryRecord(ctx, text, e));
}

export const scaExceptions = Object.freeze({
  id: 'sca-exceptions',
  category: 'dependency',
  applies: (ctx) =>
    ctx.scope.fileSet.has(SCA_EXCEPTIONS_FILE)
      ? { applies: true, reason: `${SCA_EXCEPTIONS_FILE} present` }
      : { applies: false, reason: `no ${SCA_EXCEPTIONS_FILE}` },
  extract,
});
