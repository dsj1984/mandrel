/**
 * lib/audit-suite/audit-rules-reader.js — the one synchronous reader of the
 * `audit-rules.json` manifest, memoized for the process lifetime.
 *
 * The manifest is shipped framework configuration resolved from one fixed
 * path per process, and the shape-derivation path reads it once per Story at
 * resolve AND persist — an un-memoized read is pure repeated I/O (measured
 * 221 µs/op raw vs 5.5 µs seamed on the run adhoc-4722-4723 audit). Only a
 * successful parse is cached: a read failure stays a per-call throw so a
 * caller can observe a manifest that becomes readable later. Tests never
 * reach this read — they inject fixture rules through the callers'
 * `injectedRules` seam.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getPaths, PROJECT_ROOT, resolveConfig } from '../config-resolver.js';

/** Process-lifetime memo of the parsed manifest (successful parses only). */
let auditRulesCache = null;

/**
 * Read and parse the `audit-rules.json` manifest synchronously from the
 * project's configured `schemasRoot`. Shared by the synchronous, ticket-free
 * readers (`resolveLensTier`, `selectLocalLenses`,
 * `selectSensitivePathClasses`) so the path resolution and read-failure
 * handling live in one place rather than being duplicated per reader.
 *
 * @returns {{ audits?: Record<string, object> }} Parsed manifest.
 * @throws {Error} When the manifest cannot be read or parsed.
 */
export function readAuditRulesSync() {
  if (auditRulesCache !== null) return auditRulesCache;
  const config = resolveConfig();
  const rulesPath = path.join(
    PROJECT_ROOT,
    getPaths(config).schemasRoot,
    'audit-rules.json',
  );
  try {
    auditRulesCache = JSON.parse(readFileSync(rulesPath, 'utf8'));
    return auditRulesCache;
  } catch (err) {
    throw new Error(
      `audit-suite: failed to read audit-rules from ${rulesPath}: ${err.message}`,
    );
  }
}
