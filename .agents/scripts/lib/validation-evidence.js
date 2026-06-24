/**
 * validation-evidence.js — record-and-skip for sprint validation gates.
 *
 * Tech Spec #819 §"Evidence record (Story 7)". Each successful gate run
 * writes a record keyed by `{ gateName, commitSha, commandConfigHash }` to
 * a per-Epic-tree path under the resolved `tempRoot`:
 *
 *   - Epic-scoped (scopeId === epicId):
 *       `<tempRoot>/epic-<epicId>/validation-evidence.json`
 *   - Story-scoped (scopeId === storyId):
 *       `<tempRoot>/epic-<epicId>/story-<storyId>/validation-evidence.json`
 *
 * Both paths sit inside the per-Epic durable workspace (Epic #1030, Stories
 * #1039 + #1054) and are gitignored via `temp/`.
 *
 * A subsequent caller can `shouldSkip(...)` to learn whether the same gate
 * has already passed against the current HEAD with an identical
 * command-config — in which case the gate is skipped and only logged.
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
import { epicTempDir, storyTempDir } from './config/temp-paths.js';

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
 * Compute the absolute path of the evidence file for `scopeId` under the
 * per-Epic temp tree.
 *
 * The resolution rule mirrors `lib/config/temp-paths.js`:
 *   - `scopeId === epicId` → `<tempRoot>/epic-<epicId>/validation-evidence.json`
 *   - `scopeId !== epicId` → treated as a Story id → `<tempRoot>/epic-<epicId>/story-<scopeId>/validation-evidence.json`
 *
 * **Standalone keyspace (Story #4250).** When `opts.standalone === true`,
 * the Story has no parent Epic, so the evidence file is anchored on the
 * Story id alone at
 * `<tempRoot>/standalone/stories/story-<scopeId>/validation-evidence.json`
 * (the `storyTempDir(null, sid)` layout from Story #2874). In this mode
 * `epicId` is ignored — callers MUST NOT feed a `0`/`null` epicId into the
 * Epic-keyed branch (the historical bug this keyspace replaces). Outside
 * standalone mode `epicId` remains required.
 *
 * The legacy flat `temp/validation-evidence-<scopeId>.json` layout is no
 * longer supported — Epic-scoped callers must thread the Epic id through
 * (Epic #1030 follow-up to Story #1054). The synthetic config bag passed to
 * `epicTempDir` / `storyTempDir` keeps the resolver from doing a disk-bound
 * `.agentrc.json` lookup; bare callers can pass `tempDir` via `opts` to
 * override the default `'temp'`.
 *
 * @param {number|string} scopeId
 * @param {{ cwd?: string, tempDir?: string, epicId?: number|string|null, standalone?: boolean }} opts
 * @returns {string}
 */
export function evidencePath(scopeId, opts = {}) {
  const standalone = opts.standalone === true;
  if (!standalone && opts.epicId == null) {
    throw new Error(
      '[validation-evidence] evidencePath requires opts.epicId (Epic-scoped path resolution) unless opts.standalone is set.',
    );
  }
  const { cwd, tempDir } = resolveOpts(opts);
  const scope = requirePositiveInt(scopeId, 'scopeId');
  // Bind the temp tree to the explicit `cwd` (Story #3900): pre-absolutise
  // the tempRoot under `cwd` and pass it through the canonical
  // `project.paths.tempRoot` shape so `temp-paths` honours it verbatim rather
  // than (a) ignoring the legacy bare-`paths` bag and falling back to the
  // default, then (b) anchoring that default to the main checkout. The
  // evidence file is a per-cwd artifact, not a main-checkout lifecycle ledger,
  // so it must stay rooted at the caller's `cwd`.
  const absTempRoot = path.isAbsolute(tempDir)
    ? tempDir
    : path.join(cwd, tempDir);
  const configBag = { project: { paths: { tempRoot: absTempRoot } } };
  let dir;
  if (standalone) {
    // Story #4250 — storyId-anchored standalone keyspace. `null` is the
    // standalone-story sentinel `storyTempDir` accepts (Story #2874).
    dir = storyTempDir(null, scope, configBag);
  } else {
    const epicId = requirePositiveInt(opts.epicId, 'epicId');
    dir =
      scope === epicId
        ? epicTempDir(epicId, configBag)
        : storyTempDir(epicId, scope, configBag);
  }
  return path.join(dir, EVIDENCE_FILENAME);
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

function emptyDoc(scopeId) {
  return {
    storyId: Number(scopeId),
    schemaVersion: SCHEMA_VERSION,
    records: [],
  };
}

/**
 * Read and validate the evidence file for `scopeId`. Returns an empty
 * document for the missing-file, parse-error, schema-mismatch, and
 * cross-scopeId cases — callers don't have to branch on those failure
 * modes; they manifest as `shouldSkip()` returning `skip: false`.
 *
 * `opts.epicId` is required so the per-Epic-tree path can be resolved,
 * unless `opts.standalone === true` (Story #4250) routes to the
 * storyId-anchored standalone keyspace.
 *
 * @param {number|string} scopeId
 * @param {{ cwd?: string, tempDir?: string, epicId?: number|string|null, standalone?: boolean, fs?: object }} opts
 * @returns {{ storyId: number, schemaVersion: number, records: object[] }}
 */
export function loadEvidence(scopeId, opts = {}) {
  const resolved = resolveOpts(opts);
  const file = evidencePath(scopeId, {
    ...resolved,
    epicId: opts.epicId,
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
 * Append a `gateName` pass record to the scope's evidence file, replacing any
 * prior record for the same gate. Creates the parent directory if missing.
 * Validates the resulting document against the schema before writing — a
 * malformed write throws so the bug surfaces immediately.
 *
 * `opts.epicId` is required so the per-Epic-tree path can be resolved,
 * unless `opts.standalone === true` (Story #4250) routes to the
 * storyId-anchored standalone keyspace.
 *
 * @param {{
 *   storyId: number|string,
 *   gateName: string,
 *   sha: string,
 *   configHash: string,
 *   exitCode?: number,
 *   durationMs?: number|null,
 * }} input
 * @param {{ cwd?: string, tempDir?: string, epicId?: number|string|null, standalone?: boolean, fs?: object, now?: Function }} opts
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
    epicId: opts.epicId,
    standalone: opts.standalone,
  };
  const doc = loadEvidence(storyId, evidenceOpts);
  const record = {
    gateName,
    commitSha: sha,
    commandConfigHash: configHash,
    exitCode,
    durationMs,
    inputFingerprint:
      typeof inputFingerprint === 'string' && inputFingerprint.length > 0
        ? inputFingerprint
        : null,
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

  const file = evidencePath(storyId, evidenceOpts);
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
 * `opts.epicId` is required so the per-Epic-tree path can be resolved,
 * unless `opts.standalone === true` (Story #4250) routes to the
 * storyId-anchored standalone keyspace. `opts` is forwarded verbatim to
 * `loadEvidence`, so `standalone` flows through unchanged.
 *
 * @param {{ storyId: number|string, gateName: string, currentSha: string, configHash: string }} input
 * @param {{ cwd?: string, tempDir?: string, epicId?: number|string|null, standalone?: boolean, fs?: object }} opts
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
  // SHA moved but the gate's effective inputs may still be byte-identical.
  if (
    typeof inputFingerprint === 'string' &&
    inputFingerprint.length > 0 &&
    typeof match.inputFingerprint === 'string' &&
    match.inputFingerprint.length > 0 &&
    match.inputFingerprint === inputFingerprint
  ) {
    return { skip: true, reason: 'fingerprint-match', record: match };
  }
  return { skip: false, reason: 'sha-mismatch', record: match };
}

/**
 * Delete the evidence file for `scopeId`. Called by `story-init.js` at the
 * start of each Story so a re-run always starts clean. Idempotent —
 * absent file is not an error.
 *
 * `opts.epicId` is required so the per-Epic-tree path can be resolved,
 * unless `opts.standalone === true` (Story #4250) routes to the
 * storyId-anchored standalone keyspace.
 *
 * @param {number|string} scopeId
 * @param {{ cwd?: string, tempDir?: string, epicId?: number|string|null, standalone?: boolean, fs?: object }} opts
 * @returns {{ cleared: boolean, path: string }}
 */
export function forceClear(scopeId, opts = {}) {
  const resolved = resolveOpts(opts);
  const file = evidencePath(scopeId, {
    ...resolved,
    epicId: opts.epicId,
    standalone: opts.standalone,
  });
  if (!resolved.fs.existsSync(file)) return { cleared: false, path: file };
  resolved.fs.unlinkSync(file);
  return { cleared: true, path: file };
}
