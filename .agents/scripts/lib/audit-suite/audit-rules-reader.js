/**
 * The one synchronous `audit-rules.json` reader, memoized per process. Only a
 * successful parse is cached, so a failure stays a per-call throw and a
 * manifest that later becomes readable is seen.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getPaths, PROJECT_ROOT, resolveConfig } from '../config-resolver.js';

let auditRulesCache = null;

/**
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
