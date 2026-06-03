/**
 * sync-agentrc — default-aware `.agentrc.json` reconciliation (Story #1995).
 *
 * Replaces the template-diff merge the helper procedure previously
 * described. The new contract:
 *
 *   1. Validate the project config against the framework schema. Any
 *      failure aborts the run with a diagnostic — never silently strip.
 *   2. Never auto-fill optional keys from the template. The runtime
 *      already layers `*_DEFAULTS` underneath the project config at
 *      read time, so an absent key resolves to the framework default
 *      without needing to be written into `.agentrc.json`.
 *   3. For every project leaf whose value deep-equals the framework
 *      default at that path, emit a `[REDUNDANT]` advisory row.
 *      Advisories are informational only — the project file is left
 *      untouched. Operators who want a leaner config can prune the
 *      redundant keys by hand.
 *
 * Outcome: after `/agents-update`, `.agentrc.json` contains only keys
 * that materially diverge from framework defaults, plus the
 * consumer-identity keys with no sensible framework default (owner,
 * repo, operatorHandle).
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
import { resolveProfile } from './profiles.js';

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
 * Run the reconciliation against a project root.
 *
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
        `No .agentrc.json at ${configPath}. Run /agents-bootstrap-project first.`,
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
 * Walk every default leaf path. When the project carries the same path
 * with a deep-equal value, emit a `[REDUNDANT]` advisory. Skip identity
 * placeholder paths (those have no usable default) and skip leaves the
 * schema requires at their immediate parent (deleting them would
 * invalidate the config).
 *
 * @param {object} project
 * @param {object} defaults
 * @param {object} [schema] — schema to consult for `required` arrays.
 *   Defaults to the runtime AJV schema. Tests can inject a synthetic
 *   schema to exercise the walk in isolation.
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
 * Walk a (pre-resolved, $ref-free) JSON Schema along a dotted path and
 * report whether the leaf can be removed without invalidating its
 * immediate parent. A leaf is schema-removable when it does NOT appear
 * in its immediate-parent object's `required[]`.
 *
 * Only the leaf segment's membership in its parent's `required[]`
 * matters. An ancestor being listed as required at a higher level
 * (e.g. root requires `project`) does NOT prevent removing a
 * non-required descendant (e.g. `project.baseBranch`) — the ancestor
 * stays present, only the optional leaf disappears.
 *
 * The runtime AJV schema (`AGENTRC_SCHEMA`) is already fully inlined —
 * no `$ref` indirection — so a simple `properties[key]` descent
 * suffices. When the walk falls off the schema (the path isn't covered
 * by any `properties` entry), the leaf is treated as removable: the
 * advisory layer is purely informational and would-be advisories for
 * keys the schema doesn't constrain are harmless.
 *
 * @param {object} rootSchema
 * @param {string} dottedPath
 * @returns {boolean}
 */
export function isLeafSchemaRemovable(rootSchema, dottedPath) {
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
 * Format a sync result for terminal display.
 *
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

// ---------------------------------------------------------------------------
// Profile-seeded `.agentrc.json` body (Story #3527, Epic #3438)
//
// When an installer picks a named config profile during bootstrap, the
// repo-config phase seeds `.agentrc.json` from that profile's delta seed
// (a minimal, posture-scoped document) rather than from the full bundled
// starter reference. The profile seed files carry the same operator-identity
// placeholders the starter uses (`[OWNER]`, `[REPO]`, `[USERNAME]`) and pin
// `project.baseBranch` to `main`, so the substitution rules are identical to
// the starter path in `ensureAgentrc`. Centralising the substitution here
// keeps the seeding logic pure and unit-testable, and guarantees the profile
// and starter paths apply the same operator overlay.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ProfileSeedAnswers
 * @property {string} owner            GitHub owner for `[OWNER]`.
 * @property {string} repo             GitHub repo for `[REPO]`.
 * @property {string} [operatorHandle] Handle for `[USERNAME]`; falls back to
 *   `owner` when blank/absent (mirrors the starter path).
 * @property {string} [baseBranch]     Base branch; when present and not
 *   `main`, replaces the profile's pinned `"baseBranch": "main"`.
 */

/**
 * Build the `.agentrc.json` body to write when seeding from a named config
 * profile (Story #3527). Resolves and schema-validates the profile delta via
 * {@link resolveProfile}, re-attaches the editor `$schema` pointer the
 * consumer config uses, then applies the same operator-identity placeholder
 * substitution and `baseBranch` override the starter path applies in
 * `ensureAgentrc`.
 *
 * A minimal profile (e.g. `solo-local`, which carries only `project`) yields a
 * correspondingly minimal `.agentrc.json` — no `github`/`delivery` blocks and
 * therefore no `[OWNER]`/`[REPO]`/`[USERNAME]` placeholders to substitute. The
 * resolved config still layers framework defaults at read time, so the seeded
 * file stays intentionally small and scoped to the chosen posture.
 *
 * @param {{ profile: string, answers: ProfileSeedAnswers }} opts
 * @returns {string} The newline-terminated JSON body to write to
 *   `.agentrc.json`.
 * @throws {Error} If the profile name is unknown or its seed fails schema
 *   validation (propagated from {@link resolveProfile}).
 */
export function buildProfileAgentrcBody(opts) {
  const { profile, answers } = opts;
  // `resolveProfile` strips the `$schema` pointer (it is editor metadata, not
  // part of the delta seed). Re-attach the consumer-relative pointer so the
  // seeded `.agentrc.json` matches the starter path's `$schema` shape.
  const seed = resolveProfile(profile);
  const body = {
    $schema: './.agents/schemas/agentrc.schema.json',
    ...seed,
  };
  let text = `${JSON.stringify(body, null, 2)}\n`;
  text = text
    .replace(/\[OWNER\]/g, answers.owner)
    .replace(/\[REPO\]/g, answers.repo)
    .replace(/\[USERNAME\]/g, answers.operatorHandle ?? answers.owner);
  if (answers.baseBranch && answers.baseBranch !== 'main') {
    text = text.replace(
      /"baseBranch":\s*"main"/,
      `"baseBranch": "${answers.baseBranch}"`,
    );
  }
  return text;
}
