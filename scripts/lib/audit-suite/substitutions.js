/**
 * lib/audit-suite/substitutions.js — `{{key}}` template substitution helpers.
 *
 * Extracted from `.agents/scripts/run-audit-suite.js` (Story #963, Epic #946).
 *
 * Three concerns live here:
 *   1. `applySubstitutions` — pure string templating used on each workflow body.
 *   2. `parseSubstitutionPairs` / `applyImplicitSubstitutions` — CLI-side glue
 *      that turns `--substitution key=value` pairs and `--ticket` / `--base-branch`
 *      flags into the substitutions map the runner consumes.
 *   3. `computeAllowedKeys` — the per-run allow-list (built-ins ∪ rule-declared
 *      keys) used by the runner to reject unknown caller substitutions before
 *      any workflow is loaded.
 *
 * No filesystem, no provider, no validation throws beyond `parseSubstitutionPairs`
 * (which is defensive against malformed CLI input).
 */

import { ValidationError } from '../errors/index.js';

/**
 * Built-in substitution keys that are always available regardless of which
 * audits are requested. `auditOutputDir` is sourced from the resolved paths;
 * `ticketId` and `baseBranch` are populated from CLI flags or caller args.
 */
export const BUILT_IN_SUBSTITUTION_KEYS = Object.freeze([
  'auditOutputDir',
  'ticketId',
  'baseBranch',
  // Newline-joined change-set file list, populated by Epic-mode callers
  // (e.g. `epic-audit`) from `selectAudits().context.changedFiles`.
  // Absent in manual `/audit-*` invocations — lens templates handle the
  // unsubstituted literal as "no scope filter".
  'changedFiles',
]);

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pure: replace every occurrence of `{{key}}` in `content` with the matching
 * value from `substitutions`. Keys are escaped for regex safety. Unrecognised
 * placeholders are left intact — validation of the substitution map happens
 * upstream in {@link computeAllowedKeys}.
 *
 * @param {string} content
 * @param {Record<string, string>} substitutions
 * @returns {string}
 */
export function applySubstitutions(content, substitutions) {
  let out = content;
  for (const [key, value] of Object.entries(substitutions)) {
    out = out.replace(
      new RegExp(`\\{\\{${escapeRegExp(key)}\\}\\}`, 'g'),
      value,
    );
  }
  return out;
}

/**
 * Parse repeated `--substitution key=value` CLI pairs into a flat object.
 * Throws {@link ValidationError} on malformed entries (missing `=` or empty key).
 *
 * @param {string[]} [pairs]
 * @returns {Record<string, string>}
 */
export function parseSubstitutionPairs(pairs = []) {
  const out = {};
  for (const entry of pairs) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw new ValidationError(
        `Invalid --substitution "${entry}"; expected key=value.`,
        { entry },
      );
    }
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    out[key] = value;
  }
  return out;
}

/**
 * Mutate `substitutions` in place to fold in CLI-derived defaults that should
 * only override when the operator hasn't already supplied them via
 * `--substitution`. Pulled out of `main` so the precedence rules can be
 * unit-tested without the CLI layer.
 *
 * @param {Record<string, unknown>} values parsed CLI values
 * @param {Record<string, string|undefined>} substitutions mutable map
 */
export function applyImplicitSubstitutions(values, substitutions) {
  if (values.ticket && substitutions.ticketId === undefined) {
    substitutions.ticketId = String(values.ticket);
  }
  if (values['base-branch'] && substitutions.baseBranch === undefined) {
    substitutions.baseBranch = values['base-branch'];
  }
}

/**
 * Aggregate the allowed substitution key set for a run: built-ins plus
 * per-audit declared keys across the requested auditWorkflows. Audits that
 * are not registered in rules are ignored here — the runner rejects them with
 * a findings entry before substitution matters.
 *
 * @param {{ audits?: Record<string, { substitutionKeys?: string[] }> }} rules
 * @param {string[]} auditWorkflows
 * @returns {Set<string>}
 */
export function computeAllowedKeys(rules, auditWorkflows) {
  const allowed = new Set(BUILT_IN_SUBSTITUTION_KEYS);
  for (const auditName of auditWorkflows) {
    const entry = rules.audits?.[auditName];
    if (!entry) continue;
    for (const k of entry.substitutionKeys ?? []) {
      allowed.add(k);
    }
  }
  return allowed;
}
