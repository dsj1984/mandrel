/**
 * Supply-chain relaxations: npm-audit allowlists (`.nsprc`, `audit-ci`) and
 * `.npmrc` settings that loosen install-time checks. An allowlisted advisory
 * is judged by its justification and expiry only — no network lookup — but an
 * entry scoped to a package that left the tree is `dead`.
 *
 * @module lib/audit-exceptions/adapters/dependency-audit
 */

import path from 'node:path';
import { lineOf } from '../locate.js';
import { readJsonc, readText } from '../read.js';
import { makeRecord } from '../record.js';
import { nameProbe } from './dependency-policy.js';

const AUDIT_CI_FILES = Object.freeze(['audit-ci.json', 'audit-ci.jsonc']);
const ADVISORY_RE = /^(?:GHSA-[\w-]+|CVE-\d+-\d+|\d+)$/i;

/** `.npmrc` keys whose value loosens a check, with the loosening value. */
const NPMRC_RELAXATIONS = Object.freeze({
  'legacy-peer-deps': 'true',
  'strict-peer-dependencies': 'false',
  'engine-strict': 'false',
  'strict-ssl': 'false',
  audit: 'false',
  force: 'true',
});

function expiryText(expiry) {
  if (typeof expiry === 'number')
    return new Date(expiry).toISOString().slice(0, 10);
  return typeof expiry === 'string' ? expiry.slice(0, 10) : null;
}

/** Fold `notes` and `expiry` into one justification string `record.js` reads. */
function entryJustification(meta) {
  if (typeof meta === 'string') return meta;
  if (!meta || typeof meta !== 'object') return null;
  const expiry = expiryText(meta.expiry);
  const parts = [
    meta.notes ?? meta.reason,
    expiry ? `expires: ${expiry}` : null,
  ];
  return parts.filter(Boolean).join(' ') || null;
}

/** `GHSA-x|a>b` → probe package `b`; a bare package name → itself; an id → none. */
function allowlistProbe(ctx, entry) {
  const [id, scopePath] = entry.split('|');
  if (scopePath) return nameProbe(ctx, scopePath.split('>').pop());
  if (ADVISORY_RE.test(id))
    return { verdict: 'live', basis: 'advisory-unprobed' };
  return nameProbe(ctx, id.split('>').pop());
}

function allowRecord(ctx, { file, text, surface, entry, meta }) {
  return makeRecord({
    adapter: 'dependency-audit',
    category: 'dependency',
    surface,
    file,
    line: lineOf(text, entry),
    target: entry,
    rule: surface,
    justification: entryJustification(meta),
    probe: allowlistProbe(ctx, entry),
  });
}

function nsprcRecords(ctx) {
  if (!ctx.scope.fileSet.has('.nsprc')) return [];
  const config = readJsonc(ctx.root, '.nsprc');
  if (config === null) {
    ctx.degrade('config-not-statically-readable', '.nsprc');
    return [];
  }
  const text = readText(ctx.root, '.nsprc');
  return Object.entries(config)
    .filter(([, meta]) => meta?.active !== false)
    .map(([entry, meta]) =>
      allowRecord(ctx, { file: '.nsprc', text, surface: 'nsprc', entry, meta }),
    );
}

function auditCiEntries(allowlist) {
  return (allowlist ?? []).flatMap((item) =>
    typeof item === 'string'
      ? [{ entry: item, meta: null }]
      : Object.entries(item ?? {}).map(([entry, meta]) => ({ entry, meta })),
  );
}

function auditCiRecords(ctx) {
  return AUDIT_CI_FILES.filter((f) => ctx.scope.fileSet.has(f)).flatMap(
    (file) => {
      const config = readJsonc(ctx.root, file);
      if (config === null) {
        ctx.degrade('config-not-statically-readable', file);
        return [];
      }
      const text = readText(ctx.root, file);
      return auditCiEntries(config.allowlist)
        .filter(({ meta }) => meta?.active !== false)
        .map(({ entry, meta }) =>
          allowRecord(ctx, {
            file,
            text,
            surface: 'audit-ci-allowlist',
            entry,
            meta,
          }),
        );
    },
  );
}

/** The comment line directly above `index`, if any. */
function commentAbove(lines, index) {
  const prev = lines[index - 1]?.trim() ?? '';
  return /^[#;]/.test(prev) ? prev.replace(/^[#;]+/, '') : null;
}

function npmrcRecords(ctx, file) {
  const lines = (readText(ctx.root, file) ?? '').split('\n');
  const records = [];
  lines.forEach((raw, i) => {
    const m = /^\s*([\w-]+)\s*=\s*([^#;\s]+)\s*(?:[#;](.*))?$/.exec(raw);
    if (!m || NPMRC_RELAXATIONS[m[1]] !== m[2].toLowerCase()) return;
    records.push(
      makeRecord({
        adapter: 'dependency-audit',
        category: 'dependency',
        surface: 'npmrc',
        file,
        line: i + 1,
        target: `${m[1]}=${m[2]}`,
        rule: `npmrc-${m[1]}`,
        justification: m[3] ?? commentAbove(lines, i),
        probe: { verdict: 'live', basis: 'setting-in-force' },
      }),
    );
  });
  return records;
}

export const dependencyAudit = Object.freeze({
  id: 'dependency-audit',
  category: 'dependency',
  applies: (ctx) =>
    ctx.scope.manifests.length > 0
      ? { applies: true, reason: 'package manifests present' }
      : { applies: false, reason: 'no package.json' },
  extract: (ctx) => [
    ...nsprcRecords(ctx),
    ...auditCiRecords(ctx),
    ...ctx.scope.files
      .filter((f) => path.posix.basename(f) === '.npmrc')
      .flatMap((f) => npmrcRecords(ctx, f)),
  ],
});
