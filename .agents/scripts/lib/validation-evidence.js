/**
 * Record-and-skip for validation gates: each pass is keyed by
 * `{ gateName, commitSha, commandConfigHash }` in
 * `<tempRoot>/standalone/stories/story-<id>/validation-evidence.json`.
 * A perf optimization, NOT a trust boundary — pre-push and CI still run their
 * own checks, so tampering only skips local re-runs.
 */

import { createHash } from 'node:crypto';
import {
  existsSync as defaultExistsSync,
  mkdirSync as defaultMkdirSync,
  readFileSync as defaultReadFileSync,
  renameSync as defaultRenameSync,
  unlinkSync as defaultUnlinkSync,
  writeFileSync as defaultWriteFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storyTempDir } from './config/temp-paths.js';
import { createAjv2020 } from './util/ajv.js';
import { writeFileAtomic } from './util/atomic-write.js';

export const SCHEMA_VERSION = 1;
const DEFAULT_TEMP_DIR = 'temp';
const EVIDENCE_FILENAME = 'validation-evidence.json';

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
 * Lazy so importing never reads disk; cached so calls never recompile.
 *
 * @returns {(data: unknown) => boolean}
 */
function getEvidenceValidator() {
  if (cachedValidator) return cachedValidator;
  const ajv = createAjv2020({ allErrors: true, strict: false });
  const schema = JSON.parse(defaultReadFileSync(SCHEMA_PATH, 'utf8'));
  cachedValidator = ajv.compile(schema);
  return cachedValidator;
}

const defaultFsAdapter = {
  existsSync: defaultExistsSync,
  mkdirSync: defaultMkdirSync,
  readFileSync: defaultReadFileSync,
  renameSync: defaultRenameSync,
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

function requirePositiveInt(value, label) {
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `[validation-evidence] ${label} must be a positive integer; got ${value}`,
    );
  }
  return n;
}

/**
 * Absolute evidence-file path. `opts.standalone` must be `true` (the only
 * keyspace); the synthetic config bag avoids a disk-bound `.agentrc.json` read.
 *
 * @param {number|string} scopeId
 * @param {{ cwd?: string, tempDir?: string, standalone?: boolean }} opts
 * @returns {string}
 */
export function evidencePath(scopeId, opts = {}) {
  if (opts.standalone !== true) {
    throw new Error(
      '[validation-evidence] evidencePath requires opts.standalone (the storyId-anchored keyspace is the only keyspace).',
    );
  }
  const { cwd, tempDir } = resolveOpts(opts);
  const scope = requirePositiveInt(scopeId, 'scopeId');
  // Pre-absolutise under `cwd`: evidence is per-cwd, and a relative root
  // would be anchored to the main checkout by `temp-paths`.
  const absTempRoot = path.isAbsolute(tempDir)
    ? tempDir
    : path.join(cwd, tempDir);
  const configBag = { project: { paths: { tempRoot: absTempRoot } } };
  // `null` is `storyTempDir`'s standalone-story sentinel.
  const dir = storyTempDir(null, scope, configBag);
  return path.join(dir, EVIDENCE_FILENAME);
}

/**
 * Any change to `cmd`, `args`, or `cwd` invalidates prior evidence.
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

function emptyDoc(scopeId) {
  return {
    storyId: Number(scopeId),
    schemaVersion: SCHEMA_VERSION,
    records: [],
  };
}

/**
 * Missing, unparseable, schema-invalid, or other-Story files all yield an
 * empty document (so `shouldSkip` says no).
 *
 * @param {number|string} scopeId
 * @param {{ cwd?: string, tempDir?: string, standalone?: boolean, fs?: object }} opts
 * @returns {{ storyId: number, schemaVersion: number, records: object[] }}
 */
export function loadEvidence(scopeId, opts = {}) {
  const resolved = resolveOpts(opts);
  const file = evidencePath(scopeId, {
    ...resolved,
    standalone: opts.standalone,
  });
  if (!resolved.fs.existsSync(file)) return emptyDoc(scopeId);
  let parsed;
  try {
    parsed = JSON.parse(resolved.fs.readFileSync(file, 'utf8'));
  } catch {
    return emptyDoc(scopeId);
  }
  const validator = getEvidenceValidator();
  if (!validator(parsed)) return emptyDoc(scopeId);
  if (parsed.storyId !== Number(scopeId)) return emptyDoc(scopeId);
  return parsed;
}

/**
 * Upsert a gate's pass record; a schema-invalid document throws before write.
 *
 * @param {{
 *   storyId: number|string,
 *   gateName: string,
 *   sha: string,
 *   configHash: string,
 *   exitCode?: number,
 *   durationMs?: number|null,
 * }} input
 * @param {{ cwd?: string, tempDir?: string, standalone?: boolean, fs?: object, now?: Function }} opts
 * @returns {object} The persisted record.
 */
export function recordPass(
  {
    storyId,
    gateName,
    sha,
    configHash,
    exitCode = 0,
    durationMs = null,
    inputFingerprint = null,
  },
  opts = {},
) {
  if (storyId == null || !gateName || !sha || !configHash) {
    throw new Error(
      'recordPass requires { storyId, gateName, sha, configHash }.',
    );
  }
  const resolved = resolveOpts(opts);
  const evidenceOpts = {
    ...resolved,
    standalone: opts.standalone,
  };
  const doc = loadEvidence(storyId, evidenceOpts);
  const record = {
    gateName,
    commitSha: sha,
    commandConfigHash: configHash,
    exitCode,
    durationMs,
    inputFingerprint: isNonEmptyString(inputFingerprint)
      ? inputFingerprint
      : null,
    timestamp: resolved.now().toISOString(),
  };
  doc.records = [...doc.records.filter((r) => r.gateName !== gateName), record];

  assertValidEvidence(doc);
  writeFileAtomic(
    evidencePath(storyId, evidenceOpts),
    JSON.stringify(doc, null, 2),
    { fsImpl: resolved.fs },
  );
  return record;
}

function assertValidEvidence(doc) {
  const validator = getEvidenceValidator();
  if (validator(doc)) return;
  const detail = (validator.errors || [])
    .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
    .join('; ');
  throw new Error(`Evidence document failed schema validation: ${detail}`);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * `HEAD^{tree}` as `inputFingerprint`: survives close's base-sync moving HEAD
 * without changing content, so gates are not re-paid. `null` when unreadable
 * (SHA-only matching, never a false match).
 *
 * @param {string} cwd Absolute worktree root.
 * @param {Function} [gitSpawnFn] `(cwd, ...args) => { status, stdout }`.
 * @returns {string|null} `tree:<oid>`, or `null` when unavailable.
 */
export function treeFingerprint(cwd, gitSpawnFn) {
  if (typeof gitSpawnFn !== 'function') return null;
  try {
    const res = gitSpawnFn(cwd, 'rev-parse', 'HEAD^{tree}');
    if (res?.status !== 0) return null;
    const oid = String(res.stdout ?? '').trim();
    return /^[0-9a-f]{40,64}$/.test(oid) ? `tree:${oid}` : null;
  } catch {
    return null;
  }
}

/**
 * Skip only when gate and config hash match and either the SHA or a non-empty
 * input fingerprint matches; otherwise `reason` says why not.
 *
 * @param {{ storyId: number|string, gateName: string, currentSha: string, configHash: string }} input
 * @param {{ cwd?: string, tempDir?: string, standalone?: boolean, fs?: object }} opts
 * @returns {{ skip: boolean, reason: string, record?: object }}
 */
export function shouldSkip(
  { storyId, gateName, currentSha, configHash, inputFingerprint = null },
  opts = {},
) {
  if (storyId == null || !gateName || !currentSha || !configHash) {
    return { skip: false, reason: 'missing-input' };
  }
  const doc = loadEvidence(storyId, opts);
  const match = doc.records.find((r) => r.gateName === gateName);
  if (!match) return { skip: false, reason: 'no-record' };
  if (match.commandConfigHash !== configHash) {
    return { skip: false, reason: 'config-hash-mismatch', record: match };
  }
  if (match.commitSha === currentSha) {
    return { skip: true, reason: 'evidence-match', record: match };
  }
  if (
    isNonEmptyString(inputFingerprint) &&
    match.inputFingerprint === inputFingerprint
  ) {
    return { skip: true, reason: 'fingerprint-match', record: match };
  }
  return { skip: false, reason: 'sha-mismatch', record: match };
}

/**
 * Idempotent delete, run at Story init so a re-run starts clean.
 *
 * @param {number|string} scopeId
 * @param {{ cwd?: string, tempDir?: string, standalone?: boolean, fs?: object }} opts
 * @returns {{ cleared: boolean, path: string }}
 */
export function forceClear(scopeId, opts = {}) {
  const resolved = resolveOpts(opts);
  const file = evidencePath(scopeId, {
    ...resolved,
    standalone: opts.standalone,
  });
  if (!resolved.fs.existsSync(file)) return { cleared: false, path: file };
  resolved.fs.unlinkSync(file);
  return { cleared: true, path: file };
}
