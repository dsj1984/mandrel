/**
 * Read-only `.agentrc.json` reconciliation: validate against the schema
 * (never silently strip), never auto-fill defaults (the runtime layers them
 * at read time), and flag leaves equal to their default as `[REDUNDANT]`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AGENTRC_SCHEMA, getAgentrcValidator } from '../config-schema.js';
import { deepEqual } from '../json-utils.js';
import {
  getAgentrcDefaults,
  IDENTITY_PLACEHOLDER_PATHS,
  iterDefaultLeaves,
  lookupPath,
} from './defaults.js';

/**
 * @typedef {Object} SyncChange
 * @property {'REDUNDANT'|'ADDED'|'ERROR'} op
 * @property {string} path
 * @property {unknown} [value]
 * @property {string} [reason]
 */

/**
 * @typedef {Object} SyncResult
 * @property {'noop'|'updated'|'invalid'|'missing-config'} status
 * @property {SyncChange[]} changes
 * @property {string[]} errors
 * @property {string} configPath
 * @property {boolean} wrote whether `.agentrc.json` was rewritten
 */

const IDENTITY_SET = new Set(IDENTITY_PLACEHOLDER_PATHS);

/**
 * @param {{ projectRoot: string, defaults?: object, fsImpl?: typeof fs }} opts
 * @returns {SyncResult}
 */
export function syncAgentrc(opts) {
  const projectRoot = path.resolve(opts.projectRoot);
  const fsImpl = opts.fsImpl ?? fs;
  const configPath = path.join(projectRoot, '.agentrc.json');
  const defaults = opts.defaults ?? getAgentrcDefaults();

  if (!fsImpl.existsSync(configPath)) {
    return {
      status: 'missing-config',
      changes: [],
      errors: [
        `No .agentrc.json at ${configPath}. Run \`mandrel init\` (new project) or \`node .agents/scripts/bootstrap.js\` to create it.`,
      ],
      configPath,
      wrote: false,
    };
  }

  let raw;
  try {
    raw = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
  } catch (err) {
    return {
      status: 'invalid',
      changes: [],
      errors: [`Failed to parse .agentrc.json: ${err.message}`],
      configPath,
      wrote: false,
    };
  }

  const validate = getAgentrcValidator();
  if (!validate(raw)) {
    const errors = (validate.errors || []).map(
      (e) => `${e.instancePath || '(root)'} ${e.message}`,
    );
    return {
      status: 'invalid',
      changes: [],
      errors,
      configPath,
      wrote: false,
    };
  }

  const changes = collectRedundantAdvisories(raw, defaults);

  return {
    status: 'noop',
    changes,
    errors: [],
    configPath,
    wrote: false,
  };
}

/**
 * Skips identity placeholders and leaves their parent schema requires
 * (deleting those would invalidate the config).
 *
 * @param {object} project
 * @param {object} defaults
 * @param {object} [schema]
 * @returns {SyncChange[]}
 */
export function collectRedundantAdvisories(
  project,
  defaults,
  schema = AGENTRC_SCHEMA,
) {
  const out = [];
  for (const [dotted, defValue] of iterDefaultLeaves(defaults)) {
    if (IDENTITY_SET.has(dotted)) continue;
    if (!isLeafSchemaRemovable(schema, dotted)) continue;
    const found = lookupPath(project, dotted);
    if (!found.present) continue;
    if (deepEqual(found.value, defValue)) {
      out.push({
        op: 'REDUNDANT',
        path: dotted,
        value: defValue,
      });
    }
  }
  return out;
}

/**
 * Only the leaf's membership in its immediate parent's `required[]` counts;
 * a required ancestor stays present. Assumes a `$ref`-free schema. A path
 * off the schema is removable (the advisory is informational).
 *
 * @param {object} rootSchema
 * @param {string} dottedPath
 * @returns {boolean}
 */
function isLeafSchemaRemovable(rootSchema, dottedPath) {
  if (!rootSchema || typeof rootSchema !== 'object') return true;
  const parts = dottedPath.split('.');
  let cursor = rootSchema;
  for (let i = 0; i < parts.length; i += 1) {
    const key = parts[i];
    if (!cursor || typeof cursor !== 'object') return true;
    const props = cursor.properties;
    if (!props || !Object.hasOwn(props, key)) return true;
    const isLeafSegment = i === parts.length - 1;
    if (
      isLeafSegment &&
      Array.isArray(cursor.required) &&
      cursor.required.includes(key)
    ) {
      return false;
    }
    cursor = props[key];
  }
  return true;
}

/**
 * @param {SyncResult} result
 * @returns {string}
 */
export function formatSyncReport(result) {
  const lines = [];
  if (result.status === 'missing-config') {
    lines.push('[sync-agentrc] ❌ No project config found.');
    for (const err of result.errors) lines.push(`  - ${err}`);
    return lines.join('\n');
  }
  if (result.status === 'invalid') {
    lines.push('[sync-agentrc] ❌ Validation failed:');
    for (const err of result.errors) lines.push(`  - ${err}`);
    return lines.join('\n');
  }
  const redundant = result.changes.filter((c) => c.op === 'REDUNDANT');
  if (redundant.length === 0) {
    lines.push('[sync-agentrc] ✅ No changes required.');
    return lines.join('\n');
  }
  lines.push('[sync-agentrc] ✅ No changes required.');
  lines.push(
    `[sync-agentrc] Advisories: ${redundant.length} project key(s) match framework defaults — informational only.`,
  );
  for (const c of redundant) {
    lines.push(`  [REDUNDANT] ${c.path} = ${previewValue(c.value)}`);
  }
  lines.push(
    '[sync-agentrc] Redundant keys are safe to delete — the runtime layers framework defaults at read time.',
  );
  return lines.join('\n');
}

function previewValue(value) {
  let s;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s == null) return 'undefined';
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}
