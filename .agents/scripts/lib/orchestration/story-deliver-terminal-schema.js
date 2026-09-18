/**
 * Load `story-deliver-terminal.schema.json` and validate envelopes. The schema
 * is read ONCE at module load: close may run from a worktree it later reaps,
 * so a lazy read after the reap would lose the envelope. An unreadable schema
 * degrades validation rather than throwing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'schemas',
  'story-deliver-terminal.schema.json',
);

/**
 * Never throws: importing this module must never break a delivery.
 *
 * @returns {{ schema: object|null, error: string|null }}
 */
function loadSchemaSource() {
  try {
    return {
      schema: JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')),
      error: null,
    };
  } catch (err) {
    return { schema: null, error: err?.message ?? String(err) };
  }
}

/** @type {{ schema: object|null, error: string|null }} */
const SCHEMA_SOURCE = loadSchemaSource();

/**
 * Keyed by source so an injected test source never poisons production's.
 *
 * @type {WeakMap<object, Function>}
 */
const VALIDATORS = new WeakMap();

/**
 * @param {{ schema: object|null }} source
 * @returns {Function|null}
 */
function getValidator(source) {
  if (!source?.schema) return null;
  const cached = VALIDATORS.get(source);
  if (cached) return cached;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(source.schema);
  VALIDATORS.set(source, validate);
  return validate;
}

let _unvalidatedWarned = false;

/**
 * Once per process, straight to stderr: like the envelope itself, the notice
 * must survive `AGENT_LOG_LEVEL=silent`.
 *
 * @param {string|null|undefined} error
 * @returns {void}
 */
function warnUnvalidated(error) {
  if (_unvalidatedWarned) return;
  _unvalidatedWarned = true;
  process.stderr.write(
    `[story-deliver-terminal] ⚠️ terminal-envelope schema unavailable (${error ?? 'unknown'}) — ` +
      `emitting the envelope UNVALIDATED. The return contract is preserved; its shape is not checked. ` +
      `Expected at: ${SCHEMA_PATH}\n`,
  );
}

/**
 * With no schema: `valid: true, validated: false` — deliberately, since an
 * unvalidated envelope beats none. A violation still fails at the writer.
 *
 * @param {object} envelope
 * @param {{ schemaSource?: { schema: object|null, error: string|null } }} [opts]
 *   Test seam.
 * @returns {{ valid: boolean, errors: string[], validated: boolean }}
 */
export function validateTerminalEnvelope(
  envelope,
  { schemaSource = SCHEMA_SOURCE } = {},
) {
  const validate = getValidator(schemaSource);
  if (!validate) {
    warnUnvalidated(schemaSource?.error);
    return { valid: true, errors: [], validated: false };
  }
  const valid = validate(envelope);
  if (valid) return { valid: true, errors: [], validated: true };
  const errors = (validate.errors ?? []).map(
    (e) => `${e.instancePath || '/'} ${e.message}`,
  );
  return { valid: false, errors, validated: true };
}
