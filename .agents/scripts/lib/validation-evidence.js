/**
 * validation-evidence.js — record-and-skip for sprint validation gates.
 *
 * Tech Spec #819 §"Evidence record (Story 7)". Each successful gate run
 * writes a record keyed by `{ gateName, commitSha, commandConfigHash }` to
 * `temp/validation-evidence-<storyId>.json` (gitignored). A subsequent
 * caller can `shouldSkip(...)` to learn whether the same gate has already
 * passed against the current HEAD with an identical command-config — in
 * which case the gate is skipped and only logged.
 *
 * The evidence file is a perf optimization, NOT a trust boundary: pre-push
 * hooks and CI continue to run their own checks. An adversarial agent that
 * tampered with the file would only skip local re-runs.
 */

import { createHash } from 'node:crypto';
import {
  existsSync as defaultExistsSync,
  mkdirSync as defaultMkdirSync,
  readFileSync as defaultReadFileSync,
  unlinkSync as defaultUnlinkSync,
  writeFileSync as defaultWriteFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const SCHEMA_VERSION = 1;
const DEFAULT_TEMP_DIR = 'temp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/lib/ → scripts/ → .agents/ → schemas/
const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'schemas',
  'validation-evidence.schema.json',
);

let cachedValidator = null;

/**
 * Lazily compile and cache the AJV validator for the evidence-file schema.
 * Lazy so importing this module never reads disk; cached so repeated
 * `recordPass` / `loadEvidence` calls do not recompile.
 *
 * @returns {(data: unknown) => boolean}
 */
function getEvidenceValidator() {
  if (cachedValidator) return cachedValidator;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(defaultReadFileSync(SCHEMA_PATH, 'utf8'));
  cachedValidator = ajv.compile(schema);
  return cachedValidator;
}

const defaultFsAdapter = {
  existsSync: defaultExistsSync,
  mkdirSync: defaultMkdirSync,
  readFileSync: defaultReadFileSync,
  unlinkSync: defaultUnlinkSync,
  writeFileSync: defaultWriteFileSync,
};

function resolveOpts(opts = {}) {
  return {
    cwd: opts.cwd ?? process.cwd(),
    tempDir: opts.tempDir ?? DEFAULT_TEMP_DIR,
    fs: opts.fs ?? defaultFsAdapter,
    now: opts.now ?? (() => new Date()),
  };
}

/**
 * Compute the absolute path of the evidence file for `storyId`.
 *
 * @param {number|string} storyId
 * @param {{ cwd?: string, tempDir?: string }} [opts]
 * @returns {string}
 */
export function evidencePath(storyId, opts = {}) {
  const { cwd, tempDir } = resolveOpts(opts);
  return path.join(cwd, tempDir, `validation-evidence-${storyId}.json`);
}

/**
 * Hash the resolved gate command-config to a stable sha256 digest. Skip is
 * gated on exact-match: changing `cmd`, `args`, or `cwd` invalidates prior
 * evidence so a config drift never silently re-uses a stale pass.
 *
 * @param {{ cmd: string, args?: string[], cwd?: string }} input
 * @returns {string} `sha256:<hex>` form, matching the schema pattern.
 */
export function hashCommandConfig({ cmd, args = [], cwd = '' } = {}) {
  if (typeof cmd !== 'string' || cmd.length === 0) {
    throw new Error('hashCommandConfig requires a non-empty `cmd` string.');
  }
  const canonical = JSON.stringify({ cmd, args, cwd });
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `sha256:${digest}`;
}

function emptyDoc(storyId) {
  return {
    storyId: Number(storyId),
    schemaVersion: SCHEMA_VERSION,
    records: [],
  };
}

/**
 * Read and validate the evidence file for `storyId`. Returns an empty
 * document for the missing-file, parse-error, schema-mismatch, and
 * cross-storyId cases — callers don't have to branch on those failure
 * modes; they manifest as `shouldSkip()` returning `skip: false`.
 *
 * @param {number|string} storyId
 * @param {object} [opts]
 * @returns {{ storyId: number, schemaVersion: number, records: object[] }}
 */
export function loadEvidence(storyId, opts = {}) {
  const resolved = resolveOpts(opts);
  const file = evidencePath(storyId, resolved);
  if (!resolved.fs.existsSync(file)) return emptyDoc(storyId);
  let parsed;
  try {
    parsed = JSON.parse(resolved.fs.readFileSync(file, 'utf8'));
  } catch {
    return emptyDoc(storyId);
  }
  const validator = getEvidenceValidator();
  if (!validator(parsed)) return emptyDoc(storyId);
  if (parsed.storyId !== Number(storyId)) return emptyDoc(storyId);
  return parsed;
}

/**
 * Append a `gateName` pass record to the Story's evidence file, replacing any
 * prior record for the same gate. Creates the parent directory if missing.
 * Validates the resulting document against the schema before writing — a
 * malformed write throws so the bug surfaces immediately.
 *
 * @param {{
 *   storyId: number|string,
 *   gateName: string,
 *   sha: string,
 *   configHash: string,
 *   exitCode?: number,
 *   durationMs?: number|null,
 * }} input
 * @param {object} [opts]
 * @returns {object} The persisted record.
 */
export function recordPass(
  { storyId, gateName, sha, configHash, exitCode = 0, durationMs = null },
  opts = {},
) {
  if (storyId == null || !gateName || !sha || !configHash) {
    throw new Error(
      'recordPass requires { storyId, gateName, sha, configHash }.',
    );
  }
  const resolved = resolveOpts(opts);
  const doc = loadEvidence(storyId, resolved);
  const record = {
    gateName,
    commitSha: sha,
    commandConfigHash: configHash,
    exitCode,
    durationMs,
    timestamp: resolved.now().toISOString(),
  };
  doc.records = [...doc.records.filter((r) => r.gateName !== gateName), record];

  const validator = getEvidenceValidator();
  if (!validator(doc)) {
    const detail = (validator.errors || [])
      .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
      .join('; ');
    throw new Error(`Evidence document failed schema validation: ${detail}`);
  }

  const file = evidencePath(storyId, resolved);
  resolved.fs.mkdirSync(path.dirname(file), { recursive: true });
  resolved.fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
  return record;
}

/**
 * Decide whether a gate can be skipped given the current HEAD + command
 * config. Skip is granted only on full triple-match: gateName + commitSha +
 * commandConfigHash. Any mismatch (or missing record) returns `skip: false`
 * with a machine-readable `reason` so callers can log why the skip didn't
 * fire.
 *
 * @param {{ storyId: number|string, gateName: string, currentSha: string, configHash: string }} input
 * @param {object} [opts]
 * @returns {{ skip: boolean, reason: string, record?: object }}
 */
export function shouldSkip(
  { storyId, gateName, currentSha, configHash },
  opts = {},
) {
  if (storyId == null || !gateName || !currentSha || !configHash) {
    return { skip: false, reason: 'missing-input' };
  }
  const doc = loadEvidence(storyId, opts);
  const match = doc.records.find((r) => r.gateName === gateName);
  if (!match) return { skip: false, reason: 'no-record' };
  if (match.commitSha !== currentSha) {
    return { skip: false, reason: 'sha-mismatch', record: match };
  }
  if (match.commandConfigHash !== configHash) {
    return { skip: false, reason: 'config-hash-mismatch', record: match };
  }
  return { skip: true, reason: 'evidence-match', record: match };
}

/**
 * Delete the evidence file for `storyId`. Called by `story-init.js`
 * at the start of each Story so a re-run always starts clean. Idempotent —
 * absent file is not an error.
 *
 * @param {number|string} storyId
 * @param {object} [opts]
 * @returns {{ cleared: boolean, path: string }}
 */
export function forceClear(storyId, opts = {}) {
  const resolved = resolveOpts(opts);
  const file = evidencePath(storyId, resolved);
  if (!resolved.fs.existsSync(file)) return { cleared: false, path: file };
  resolved.fs.unlinkSync(file);
  return { cleared: true, path: file };
}
