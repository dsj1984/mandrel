/**
 * Named config-profile seeds and resolver (Story #3518, Epic #3438).
 *
 * A *profile* is a named, hand-curated delta seed for a project's first
 * `.agentrc.json`. Each profile file under `.agents/config-profiles/<name>.json`
 * is a complete, schema-valid `.agentrc.json` document tuned for one starting
 * posture:
 *
 *   - `solo-local`  — the minimal seed: just `project` (paths + baseBranch).
 *                     Omits the `github` block and every team / GitHub-only
 *                     key so the resolved config stays small and intentional.
 *   - `team-github` — adds GitHub identity, branch protection, notifications,
 *                     and CI-skip-for-story-pushes for a team using GitHub.
 *   - `qa-only`     — seeds the `qa` harness block (feature root, sign-in
 *                     seam, personas) on top of the minimal project base.
 *   - `audit-only`  — seeds an audit-oriented code-review provider chain and
 *                     audit-results auto-filing on top of the minimal base.
 *
 * The seed is intended to be copied to the consumer project root as the
 * starting `.agentrc.json`; the resolver loads and validates it so callers
 * (e.g. a bootstrap / `config-explain` capability) can surface a known-good
 * starting point rather than asking the operator to hand-author one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAgentrcValidator } from '../config-settings-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// .agents/scripts/lib/config/ → .agents/config-profiles/
export const PROFILES_DIR = path.resolve(__dirname, '../../../config-profiles');

/**
 * Canonical profile names in display order. The on-disk `<name>.json` files
 * under `PROFILES_DIR` are the source of truth; this list pins the order and
 * the set so `listProfiles()` is deterministic and does not silently pick up
 * unrelated files dropped in the directory.
 *
 * @type {readonly string[]}
 */
export const PROFILE_NAMES = Object.freeze([
  'solo-local',
  'team-github',
  'qa-only',
  'audit-only',
]);

/**
 * Return the canonical list of available profile names, in display order.
 *
 * @returns {string[]} A fresh array (safe for the caller to mutate).
 */
export function listProfiles() {
  return [...PROFILE_NAMES];
}

/**
 * Absolute path to a profile's seed file.
 *
 * @param {string} name
 * @returns {string}
 */
export function profilePath(name) {
  return path.join(PROFILES_DIR, `${name}.json`);
}

/**
 * Load and validate a named profile's delta seed.
 *
 * The returned object is the parsed `<name>.json` document with the editor
 * `$schema` pointer stripped — i.e. exactly the delta seed an operator would
 * write to `.agentrc.json`. It is validated against the runtime AGENTRC
 * schema (the same validator the config resolver uses); an invalid seed
 * throws rather than returning a malformed document.
 *
 * @param {string} name One of `listProfiles()`.
 * @returns {object} The schema-valid delta seed.
 * @throws {Error} If the name is unknown or the seed fails schema validation.
 */
export function resolveProfile(name) {
  if (!PROFILE_NAMES.includes(name)) {
    throw new Error(
      `Unknown config profile "${name}". Known profiles: ${PROFILE_NAMES.join(', ')}.`,
    );
  }

  const seedPath = profilePath(name);
  let raw;
  try {
    raw = fs.readFileSync(seedPath, 'utf8');
  } catch (cause) {
    throw new Error(
      `Config profile "${name}" is registered but its seed file is missing at ${seedPath}.`,
      { cause },
    );
  }

  const seed = JSON.parse(raw);
  // The `$schema` pointer is editor metadata, not part of the delta seed's
  // semantic content. Strip it before validating / returning so callers get
  // the clean document they would merge into `.agentrc.json`.
  delete seed.$schema;

  const validate = getAgentrcValidator();
  if (!validate(seed)) {
    const detail = (validate.errors ?? [])
      .map((e) => `${e.instancePath || '/'} ${e.message}`)
      .join('; ');
    throw new Error(
      `Config profile "${name}" seed does not validate against the agentrc schema: ${detail}`,
    );
  }

  return seed;
}
