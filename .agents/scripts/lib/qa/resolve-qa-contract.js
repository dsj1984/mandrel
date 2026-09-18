/**
 * `qa` contract resolver — the single seam the QA harness calls. The block is
 * optional in the schema (non-QA repos must validate), so presence is enforced
 * here at run time, loudly: an absent block, a malformed field, or a dangling
 * `signInSeam.skill` throws an operator-actionable error; there is no silent
 * fallback.
 */

import Ajv from 'ajv';
import { QA_SCHEMA } from '../config-settings-schema.js';
import { PROJECT_ROOT } from '../project-root.js';
import {
  resolveSkillFile,
  SKILL_SEARCH_ROOTS,
} from '../skills/walk-skill-files.js';

/**
 * Optional in the schema (shape for any repo), required here (binding
 * completeness only when the harness actually runs).
 */
export const QA_REQUIRED_FIELDS = Object.freeze([
  'featureRoot',
  'fixturesManifest',
  'environments',
  'personas',
]);

// The only environment whose `allowWrites` defaults to true; every other
// target is read-only unless the consumer opts in.
const WRITE_ENABLED_DEFAULT_ENVIRONMENT = 'local';

export const QA_CONTRACT_DEFAULTS = Object.freeze({
  consoleAllowlist: Object.freeze([]),
  designTokens: null,
});

const ABSENT_MESSAGE =
  'qa: this project has not bound the QA harness — add a `qa` block to ' +
  '.agentrc.json (featureRoot, fixturesManifest, environments, personas) ' +
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
 * Normalize `string[]` or object-map personas to an object map; a name-only
 * persona maps to `{}` (no fabricated auth material).
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
  const map = {};
  for (const [name, material] of Object.entries(personas)) {
    map[name] = { ...material };
  }
  return { personas: map, personaNames: Object.keys(personas) };
}

/**
 * @param {import('ajv').ErrorObject} err
 * @returns {string}
 */
function describeError(err) {
  const field = err.instancePath ? err.instancePath.replace(/^\//, '') : '';
  const dotted = field ? `qa.${field.replace(/\//g, '.')}` : 'qa';
  if (err.keyword === 'additionalProperties') {
    const extra = err.params?.additionalProperty;
    return `${dotted} has an unknown field \`${extra}\``;
  }
  return `${dotted} ${err.message}`;
}

/**
 * Accepts the full config or the bare `qa` bag; returns a fresh normalized
 * contract.
 *
 * @param {object | null | undefined} config Full resolved config or bare qa block.
 * @returns {{
 *   featureRoot: string,
 *   fixturesManifest: string,
 *   environments: Record<string, { baseUrl: string, signInSeam: object, allowWrites?: boolean }>,
 *   defaultEnvironment: string,
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

  // A scaffolded `qa: {}` with no required field is "absent", not malformed.
  const presentRequired = QA_REQUIRED_FIELDS.filter(
    (key) => qa[key] !== undefined,
  );
  if (presentRequired.length === 0) {
    throw new Error(ABSENT_MESSAGE);
  }

  // Shape first, so a wrong-typed field is named even when another is missing.
  const validate = getQaValidator();
  if (!validate(qa)) {
    const detail = (validate.errors || []).map(describeError).join('; ');
    throw new Error(`qa: malformed contract — ${detail}`);
  }

  const missing = QA_REQUIRED_FIELDS.filter((key) => qa[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `qa: malformed contract — missing required field${
        missing.length > 1 ? 's' : ''
      } \`${missing.join('`, `')}\``,
    );
  }

  const { personas, personaNames } = normalizePersonas(qa.personas);

  const environments = {};
  for (const [name, env] of Object.entries(qa.environments)) {
    environments[name] = { ...env };
  }

  // `local` when declared, else the first-declared environment.
  const environmentNames = Object.keys(environments);
  const defaultEnvironment = Object.hasOwn(
    environments,
    WRITE_ENABLED_DEFAULT_ENVIRONMENT,
  )
    ? WRITE_ENABLED_DEFAULT_ENVIRONMENT
    : environmentNames[0];

  return {
    featureRoot: qa.featureRoot,
    fixturesManifest: qa.fixturesManifest,
    environments,
    defaultEnvironment,
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

/**
 * @param {string} value
 * @returns {string | null}
 */
function toOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * An absent seam is a declarable `null`. A `{ skill }` seam must resolve
 * under a skills root now, not mid-sweep after a browser was driven; the
 * resolved path is attached as `skillPath`. A malformed id and an unresolved
 * one get different messages because they need different fixes (the
 * malformed branch is reachable past a degraded validator).
 *
 * @param {object | undefined} seam
 * @param {string} envName Environment name, for the error message.
 * @param {{ repoRoot?: string }} options
 * @returns {object | null}
 */
function resolveSignInSeam(seam, envName, options) {
  if (seam == null) return null;
  if (typeof seam.skill !== 'string') return seam;

  const repoRoot = options.repoRoot ?? PROJECT_ROOT;
  const found = resolveSkillFile(repoRoot, seam.skill);
  if (found?.reason === 'invalid-id') {
    throw new Error(
      `qa: environment \`${envName}\` declares signInSeam.skill ` +
        `\`${seam.skill}\`, which is not a well-formed skill id. ` +
        'An id is two or more lowercase segments of letters, digits, `.`, ' +
        '`_` or `-` joined by `/` — e.g. `stack/qa/acme-sso`. Traversals, ' +
        'absolute paths, backslashes and uppercase segments are rejected ' +
        'outright, so no skills root was searched. Correct the id.',
    );
  }
  if (found === null) {
    throw new Error(
      `qa: environment \`${envName}\` declares signInSeam.skill ` +
        `\`${seam.skill}\`, which resolves to no readable SKILL.md. ` +
        `Searched ${SKILL_SEARCH_ROOTS.map((r) => `\`${r}/<skill>/SKILL.md\``).join(' and ')}. ` +
        'Author the skill under the consumer-writable `.agents/local/skills/` ' +
        'zone (it is never pruned by `mandrel sync` and never flagged as ' +
        'payload drift), correct the id, or omit `signInSeam` entirely if ' +
        'this target genuinely has no sign-in seam.',
    );
  }
  return { ...seam, skillPath: found.path };
}

/**
 * Select one environment: omitted → default; exact name (wins even if it
 * parses as a URL); else a raw URL matched by origin against each `baseUrl`.
 * `allowWrites` resolves to an explicit boolean.
 *
 * @param {{ environments: Record<string, { baseUrl: string, signInSeam?: object, allowWrites?: boolean }>, defaultEnvironment: string }} contract
 *   A contract returned by `resolveQaContract`.
 * @param {string} [target] Environment name or raw URL.
 * @param {{ repoRoot?: string }} [options] Roots skill-seam resolution.
 * @returns {{ name: string, baseUrl: string, signInSeam: object | null, allowWrites: boolean }}
 * @throws {Error} on an unknown name, an unmatched URL, or a `{ skill }` seam
 *   that resolves under no skills root.
 */
export function resolveQaEnvironment(contract, target, options = {}) {
  const environments = contract?.environments;
  if (
    environments == null ||
    typeof environments !== 'object' ||
    Object.keys(environments).length === 0
  ) {
    throw new Error(
      'qa: cannot resolve an environment — the contract carries no ' +
        '`environments`. Call resolveQaContract first.',
    );
  }

  const known = Object.keys(environments);
  const knownList = known.map((name) => `\`${name}\``).join(', ');

  const name =
    target == null || target === '' ? contract.defaultEnvironment : target;

  let resolvedName = Object.hasOwn(environments, name) ? name : null;

  if (resolvedName === null) {
    const targetOrigin = toOrigin(name);
    if (targetOrigin !== null) {
      resolvedName =
        known.find(
          (envName) => toOrigin(environments[envName].baseUrl) === targetOrigin,
        ) ?? null;
    }
  }

  if (resolvedName === null) {
    throw new Error(
      `qa: unknown environment \`${name}\` — the contract declares ${knownList}. ` +
        'Pass an exact environment name or a URL whose origin matches one of ' +
        'their baseUrl values.',
    );
  }

  const env = environments[resolvedName];
  const allowWrites =
    typeof env.allowWrites === 'boolean'
      ? env.allowWrites
      : resolvedName === WRITE_ENABLED_DEFAULT_ENVIRONMENT;

  return {
    name: resolvedName,
    baseUrl: env.baseUrl,
    signInSeam: resolveSignInSeam(env.signInSeam, resolvedName, options),
    allowWrites,
  };
}
