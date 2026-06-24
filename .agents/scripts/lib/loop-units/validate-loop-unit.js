/**
 * lib/loop-units/validate-loop-unit.js — loop-unit frontmatter validator.
 *
 * Parses a loop-unit markdown file's YAML frontmatter and AJV-validates
 * it against `.agents/schemas/loop-unit.schema.json` (Ajv2020). Mirrors
 * the validation pattern established by `lib/spec/loader.js` (Ajv2020 +
 * ajv-formats + js-yaml, cached compiled validator, normalised
 * `{ path, message }` issues).
 *
 * A "loop unit" is a markdown file under `.agents/workflows/loops/` whose
 * leading `---`-fenced YAML frontmatter block defines a recurring unit of
 * work (cadence, goal, conditional verify, round cap, exhaustion policy).
 *
 * Public surface:
 *   • `parseFrontmatter(source)` → extracts and YAML-parses the leading
 *     `---`-fenced block. Returns the parsed object (or `{}` for an empty
 *     block). Throws `LoopUnitParseError` when the block is absent or the
 *     YAML does not parse.
 *   • `validateLoopUnit(filePath, opts?)` → reads the file, parses its
 *     frontmatter, validates against the schema, and returns
 *     `{ valid, issues, data }`. `issues` is an array of
 *     `{ path, message }` (empty when valid). Never throws on a *validation*
 *     failure — it reports it via `valid: false` — but does throw
 *     `LoopUnitParseError` for an unreadable file or unparseable
 *     frontmatter so callers can distinguish "structurally broken file"
 *     from "schema-invalid unit".
 *
 * The module makes no GitHub calls and no process mutations; it is pure
 * file I/O + schema validation. The `opts` bag accepts `{ schemaPath, fs }`
 * so tests can point at a sandbox schema without monkey-patching globals.
 */

import {
  existsSync as defaultExistsSync,
  readFileSync as defaultReadFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// scripts/lib/loop-units/ → scripts/lib/ → scripts/ → .agents/
const PROJECT_AGENTS_DIR = path.resolve(__dirname, '..', '..', '..');
export const DEFAULT_SCHEMA_PATH = path.join(
  PROJECT_AGENTS_DIR,
  'schemas',
  'loop-unit.schema.json',
);

const defaultFsAdapter = Object.freeze({
  existsSync: defaultExistsSync,
  readFileSync: defaultReadFileSync,
});

let cachedValidator = null;
let cachedValidatorKey = null;

/**
 * Compile (and cache) the Ajv2020 validator for the loop-unit schema.
 * Cached by absolute schema path so tests can swap to a sandbox schema.
 *
 * @param {string} schemaPath
 * @param {{ readFileSync: typeof defaultReadFileSync }} fs
 * @returns {(data: unknown) => boolean}
 */
function getValidator(schemaPath, fs) {
  if (cachedValidator && cachedValidatorKey === schemaPath) {
    return cachedValidator;
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  cachedValidator = ajv.compile(schema);
  cachedValidatorKey = schemaPath;
  return cachedValidator;
}

/**
 * Raised when a loop-unit file cannot be read, has no YAML frontmatter
 * block, or the frontmatter does not parse as YAML.
 */
export class LoopUnitParseError extends Error {
  /**
   * @param {string} filePath
   * @param {string} reason
   */
  constructor(filePath, reason) {
    super(`Loop unit ${filePath} could not be parsed: ${reason}`);
    this.name = 'LoopUnitParseError';
    this.filePath = filePath;
    this.reason = reason;
  }
}

// Leading `---`-fenced YAML block. Tolerates CRLF and a leading BOM. The
// closing fence is a `---` (or `...`) on its own line.
const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/;

/**
 * Extract and YAML-parse the leading `---`-fenced frontmatter block from a
 * markdown source string.
 *
 * @param {string} source        raw file contents
 * @param {string} [filePath]    used only for error messages
 * @returns {object}             the parsed frontmatter object (`{}` if empty)
 * @throws {LoopUnitParseError}  when no fence is present or the YAML fails
 */
export function parseFrontmatter(source, filePath = '<string>') {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) {
    throw new LoopUnitParseError(
      filePath,
      'no YAML frontmatter block (expected a leading "---" fence)',
    );
  }
  let parsed;
  try {
    parsed = yaml.load(match[1], { filename: filePath });
  } catch (err) {
    throw new LoopUnitParseError(
      filePath,
      `frontmatter is not valid YAML: ${err.message}`,
    );
  }
  if (parsed == null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LoopUnitParseError(
      filePath,
      'frontmatter must be a YAML mapping',
    );
  }
  return parsed;
}

/**
 * Convert Ajv's error array into a `{ path, message }` shape. For
 * `required` errors Ajv leaves the missing property in
 * `params.missingProperty` rather than the instance path, so we append it
 * so the caller sees `/loop/verify` instead of `/loop` and the message
 * names the missing field.
 *
 * @param {Array<{instancePath:string,message:string,keyword:string,params?:Record<string,unknown>}>} ajvErrors
 * @returns {Array<{path:string,message:string}>}
 */
function normaliseAjvErrors(ajvErrors) {
  return (ajvErrors ?? []).map((err) => {
    let p = err.instancePath || '/';
    let message = err.message ?? 'validation failed';
    if (
      err.keyword === 'required' &&
      typeof err.params?.missingProperty === 'string'
    ) {
      const sep = p === '/' ? '' : '/';
      p = `${p}${sep}${err.params.missingProperty}`;
      message = `must have required property '${err.params.missingProperty}'`;
    }
    return { path: p, message };
  });
}

/**
 * Read, parse, and schema-validate a loop-unit markdown file.
 *
 * @param {string} filePath
 * @param {{ schemaPath?: string, fs?: typeof defaultFsAdapter }} [opts]
 * @returns {{ valid: boolean, issues: Array<{path:string,message:string}>, data: object }}
 * @throws {LoopUnitParseError} when the file is unreadable or its
 *   frontmatter is missing/unparseable.
 */
export function validateLoopUnit(filePath, opts = {}) {
  const fs = opts.fs ?? defaultFsAdapter;
  const schemaPath = opts.schemaPath ?? DEFAULT_SCHEMA_PATH;

  if (!fs.existsSync(filePath)) {
    throw new LoopUnitParseError(filePath, 'file does not exist');
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new LoopUnitParseError(filePath, `unreadable: ${err.message}`);
  }

  const data = parseFrontmatter(raw, filePath);
  const validate = getValidator(schemaPath, fs);
  const ok = validate(data);

  return {
    valid: ok,
    issues: ok ? [] : normaliseAjvErrors(validate.errors),
    data,
  };
}
