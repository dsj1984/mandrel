/**
 * phases/risk-verdict.js — read + schema-validate the planner-authored
 * risk verdict (Epic #3865).
 *
 * The `epic-plan-spec-author` Skill writes `risk-verdict.json` as the
 * fourth planning artifact; the persist half of `epic-plan-spec.js` loads
 * it through this module before deriving the planningRisk envelope. A
 * missing, unparseable, or schema-invalid verdict throws — the spec phase
 * fails closed rather than mis-routing the review gate.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const RISK_VERDICT_SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'schemas',
  'risk-verdict.schema.json',
);

/** @type {Map<string, import('ajv').ValidateFunction>} */
const validatorCache = new Map();

/**
 * Compile (and cache) the Ajv2020 validator for the risk-verdict schema.
 *
 * @param {string} schemaPath
 * @param {{ readFileSync: typeof readFileSync }} io
 * @returns {import('ajv').ValidateFunction}
 */
function getRiskVerdictValidator(schemaPath, io) {
  const cached = validatorCache.get(schemaPath);
  if (cached) return cached;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(io.readFileSync(schemaPath, 'utf8'));
  const validate = ajv.compile(schema);
  validatorCache.set(schemaPath, validate);
  return validate;
}

/**
 * Validate a parsed risk verdict against the schema. Throws with the full
 * Ajv error detail on any violation so the spec phase never routes the
 * review gate off a malformed verdict.
 *
 * @param {unknown} verdict
 * @param {{ schemaPath?: string, io?: { readFileSync: typeof readFileSync } }} [opts]
 * @returns {import('../../planning-risk.js').RiskVerdict} The validated verdict (same reference).
 */
export function validateRiskVerdict(verdict, opts = {}) {
  const validate = getRiskVerdictValidator(
    opts.schemaPath ?? RISK_VERDICT_SCHEMA_PATH,
    opts.io ?? { readFileSync },
  );
  if (!validate(verdict)) {
    const detail = (validate.errors ?? [])
      .map((e) => `${e.instancePath || '/'} ${e.message}`)
      .join('; ');
    throw new Error(
      `[epic-plan-spec] risk verdict failed schema validation: ${detail}`,
    );
  }
  return /** @type {import('../../planning-risk.js').RiskVerdict} */ (verdict);
}

/**
 * Read, parse, and schema-validate the risk-verdict file the
 * `epic-plan-spec-author` Skill wrote.
 *
 * @param {string} verdictPath
 * @param {{ schemaPath?: string, io?: { readFileSync: typeof readFileSync } }} [opts]
 * @returns {import('../../planning-risk.js').RiskVerdict}
 */
export function loadRiskVerdict(verdictPath, opts = {}) {
  const io = opts.io ?? { readFileSync };
  let raw;
  try {
    raw = io.readFileSync(verdictPath, 'utf8');
  } catch (err) {
    throw new Error(
      `[epic-plan-spec] cannot read risk verdict at ${verdictPath}: ${err.message}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[epic-plan-spec] risk verdict at ${verdictPath} is not valid JSON: ${err.message}`,
    );
  }
  return validateRiskVerdict(parsed, opts);
}
