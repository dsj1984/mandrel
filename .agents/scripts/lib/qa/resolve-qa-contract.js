/**
 * `qa` contract resolver — Epic #3214, Story #3294.
 *
 * The agent-driven QA harness (`/qa-run`) needs the
 * consumer's `.agentrc.json` `qa` block to know where the `.feature` root
 * lives, how to sign in, and which personas the seam accepts. The block is
 * *optional in the schema* (most repos never bind the harness, so config
 * validation must not break them — see Tech Spec #3285 § "qa contract
 * block"), which means presence is enforced at run time by this resolver
 * rather than by the AJV gate.
 *
 * This resolver is the single seam the harness calls. It fails **loudly**:
 *   - Absent block  → throw with the operator-actionable phrase
 *     "this project has not bound the QA harness". There is no silent
 *     fallback to auto-detection; the harness must not pretend a contract
 *     exists.
 *   - Malformed block → throw an error naming the offending field so the
 *     operator can fix `.agentrc.json` without spelunking the schema.
 *   - Well-formed block → return the normalized contract object with the
 *     two optional fields (`consoleAllowlist`, `designTokens`) defaulted.
 */

import Ajv from 'ajv';

import { QA_SCHEMA } from '../config-settings-schema.js';

/**
 * The harness-required fields. The AJV `QA_SCHEMA` keeps these optional so
 * the full-document validator never rejects a non-QA consumer; the harness
 * contract, however, is meaningless without all four, so the resolver
 * enforces them here. Keeping the list adjacent to the resolver (not in the
 * schema) is deliberate: the schema validates *shape* for any repo, the
 * resolver enforces *harness-binding completeness* only when the harness is
 * actually invoked.
 */
export const QA_REQUIRED_FIELDS = Object.freeze([
  'featureRoot',
  'fixturesManifest',
  'signInSeam',
  'personas',
]);

/** Defaults applied to the optional fields of a well-formed contract. */
export const QA_CONTRACT_DEFAULTS = Object.freeze({
  consoleAllowlist: Object.freeze([]),
  designTokens: null,
});

const ABSENT_MESSAGE =
  'qa: this project has not bound the QA harness — add a `qa` block to ' +
  '.agentrc.json (featureRoot, fixturesManifest, signInSeam, personas) ' +
  'before invoking the QA harness. See .agents/docs/agentrc-reference.json for the ' +
  'full contract shape.';

let _qaValidator = null;
function getQaValidator() {
  if (!_qaValidator) {
    const ajv = new Ajv({ allErrors: true });
    _qaValidator = ajv.compile(QA_SCHEMA);
  }
  return _qaValidator;
}

/**
 * Normalize the two accepted `personas` shapes to one canonical internal
 * form (Story #3306).
 *
 * The schema accepts either a plain `string[]` of persona names (the honest
 * shape for a `urlTemplate` dev-impersonation seam, where the workflow reads
 * only the persona name) or the object-map form keyed by persona name (each
 * entry carrying `credentialRef` / `signInSkill` for a `skill`/credential
 * seam). Downstream the workflow consumes only the persona *names*, so the
 * canonical internal form is an object map keyed by persona name. A name-only
 * persona maps to an empty record — it carries no fabricated auth material.
 *
 * @param {string[] | Record<string, object>} personas Either accepted shape.
 * @returns {{ personas: Record<string, object>, personaNames: string[] }}
 */
function normalizePersonas(personas) {
  if (Array.isArray(personas)) {
    const map = {};
    for (const name of personas) {
      map[name] = {};
    }
    return { personas: map, personaNames: [...personas] };
  }
  // Object-map form: clone each entry so callers cannot mutate the input.
  const map = {};
  for (const [name, material] of Object.entries(personas)) {
    map[name] = { ...material };
  }
  return { personas: map, personaNames: Object.keys(personas) };
}

/**
 * Render an AJV error into an actionable, field-named sentence.
 *
 * @param {import('ajv').ErrorObject} err
 * @returns {string}
 */
function describeError(err) {
  // `instancePath` is e.g. "/featureRoot" or "/signInSeam"; strip the
  // leading slash so the message reads `qa.featureRoot ...`. A top-level
  // error (empty path) describes the block itself.
  const field = err.instancePath ? err.instancePath.replace(/^\//, '') : '';
  const dotted = field ? `qa.${field.replace(/\//g, '.')}` : 'qa';
  if (err.keyword === 'additionalProperties') {
    const extra = err.params?.additionalProperty;
    return `${dotted} has an unknown field \`${extra}\``;
  }
  return `${dotted} ${err.message}`;
}

/**
 * Resolve, validate, and normalize the `qa` contract block.
 *
 * Accepts either the full resolved config wrapper (`{ qa, project, ... }`)
 * or the bare `qa` bag. Returns a fresh normalized object — callers must not
 * mutate the input.
 *
 * `personas` is accepted in either shape (a `string[]` of names or the
 * object-map form) and normalized to one canonical internal form: an object
 * map keyed by persona name. A `personaNames` array is also returned for the
 * common case (url-template seam) where only the names are consumed.
 *
 * @param {object | null | undefined} config Full resolved config or bare qa block.
 * @returns {{
 *   featureRoot: string,
 *   fixturesManifest: string,
 *   signInSeam: object,
 *   personas: Record<string, object>,
 *   personaNames: string[],
 *   consoleAllowlist: string[],
 *   designTokens: string | null,
 * }}
 * @throws {Error} when the block is absent or malformed.
 */
export function resolveQaContract(config) {
  const qa = config?.qa ?? config;

  if (qa == null || typeof qa !== 'object' || Array.isArray(qa)) {
    throw new Error(ABSENT_MESSAGE);
  }

  // Distinguish "absent" from "malformed": a block that is missing *every*
  // harness-required field is treated as absent (the operator scaffolded an
  // empty `qa: {}` but never bound it), so it gets the loud no-fallback
  // message rather than a field-by-field validation dump.
  const presentRequired = QA_REQUIRED_FIELDS.filter(
    (key) => qa[key] !== undefined,
  );
  if (presentRequired.length === 0) {
    throw new Error(ABSENT_MESSAGE);
  }

  // Malformed-shape check first (AJV), so a wrong-typed field is reported by
  // name even when a required field is also missing.
  const validate = getQaValidator();
  if (!validate(qa)) {
    const detail = (validate.errors || []).map(describeError).join('; ');
    throw new Error(`qa: malformed contract — ${detail}`);
  }

  // Required-field completeness, naming the first missing field.
  const missing = QA_REQUIRED_FIELDS.filter((key) => qa[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `qa: malformed contract — missing required field${
        missing.length > 1 ? 's' : ''
      } \`${missing.join('`, `')}\``,
    );
  }

  const { personas, personaNames } = normalizePersonas(qa.personas);

  return {
    featureRoot: qa.featureRoot,
    fixturesManifest: qa.fixturesManifest,
    signInSeam: qa.signInSeam,
    personas,
    personaNames,
    consoleAllowlist: Array.isArray(qa.consoleAllowlist)
      ? [...qa.consoleAllowlist]
      : [...QA_CONTRACT_DEFAULTS.consoleAllowlist],
    designTokens:
      qa.designTokens === undefined
        ? QA_CONTRACT_DEFAULTS.designTokens
        : qa.designTokens,
  };
}
