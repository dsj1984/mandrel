/**
 * `{{key}}` substitution for audit workflow bodies, plus the CLI glue and the
 * per-run allowed-key set.
 */

import { ValidationError } from '../errors/index.js';

export const BUILT_IN_SUBSTITUTION_KEYS = Object.freeze([
  'auditOutputDir',
  'ticketId',
  'baseBranch',
  // Newline-joined change set; when unsubstituted, lens templates read the
  // literal as "no scope filter".
  'changedFiles',
]);

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Unrecognised placeholders are left intact; keys are validated upstream.
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
 * Throws {@link ValidationError} on a missing `=` or empty key.
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
 * Fill `ticketId`/`baseBranch` from flags in place, unless an explicit
 * `--substitution` already set them.
 *
 * @param {Record<string, unknown>} values
 * @param {Record<string, string|undefined>} substitutions
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
 * Built-ins plus each requested audit's declared keys; unregistered audits
 * are rejected elsewhere.
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
