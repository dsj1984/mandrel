#!/usr/bin/env node

/**
 * Test-temp hygiene guard (Story #4696).
 *
 * The friction / lifecycle / trace NDJSON streams under `temp/` are the
 * substrate every retro, rollup, and loop-health consumer reads. When the
 * test suite appends fixture records to the *real* `temp/` tree (the #4555
 * defect class, re-surfaced for the signal writers), those consumers read
 * noise: at the time this guard shipped, 99% of friction records were
 * test-fixture pollution.
 *
 * The writer-layer fix (`lib/config/temp-paths.js` scratch seam +
 * `lib/test-env.js` bootstrap) redirects stray test writes into an absolute
 * per-process scratch dir. This script is the regression guard that keeps
 * the fix honest, plus a local cleanup mode for the accumulated noise:
 *
 *   --snapshot         Record a fingerprint (size + sha256) of every stream
 *                      file under `temp/` to the snapshot baseline. Run this
 *                      before the suite.
 *   --assert           Re-scan and fail if any stream file was added or grew
 *                      relative to the snapshot. Run this after the suite. A
 *                      missing snapshot is a hard failure ("snapshot missing
 *                      — guard cannot attest"), never a silent re-baseline:
 *                      the baseline lives *outside* the protected `temp/`
 *                      tree (Story #4711), so a test wiping `temp/` can no
 *                      longer destroy the baseline and fail the guard open.
 *   --baseline <path>  Explicit snapshot-baseline path (CI sets this to a
 *                      runner-temp path). Defaults to an OS scratch location
 *                      keyed by the resolved repo root. Refused when it
 *                      resolves inside the protected `temp/` tree.
 *   --clean            List stream directories whose Epic/Story id matches a
 *                      known fixture id (report-only; nothing is deleted).
 *   --clean --yes      Delete those directories.
 *   --ids 1,2,3        Override the fixture-id list for --clean.
 *   --root <dir>       Operate against <dir> instead of the repo root
 *                      (its `temp/` subtree). Used by tests.
 *
 * Exit codes: 1 on an --assert failure (a new / grown stream file, or a
 * missing snapshot baseline); 0 otherwise.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAsCli } from './lib/cli-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Known fixture Epic/Story ids observed polluting the real `temp/` tree
 * (Story #4696). `--clean` targets only these by default so real scratch
 * (a genuine `run-<id>` from a live delivery) is never swept.
 */
export const KNOWN_FIXTURE_STORY_IDS = Object.freeze([
  4428, 10, 4242, 5, 42, 100, 555, 2839, 4257, 4258, 4259,
]);

/**
 * Resolve the `temp/` directory for a given repo root.
 * @param {string} repoRoot
 * @returns {string}
 */
export function tempDirFor(repoRoot) {
  return path.join(repoRoot, 'temp');
}

/**
 * Default snapshot-baseline path for a repo root — deliberately *outside*
 * the protected `temp/` tree (Story #4711). The pre-#4711 baseline lived at
 * `temp/.test-temp-hygiene-snapshot.json`, inside the very tree the guard
 * protects: a test (or cleanup) that wiped `temp/` destroyed the baseline
 * and the post-test `--assert` silently re-baselined the pollution. The
 * default now lives under the OS scratch dir, keyed by the resolved repo
 * root so parallel checkouts / worktrees never collide.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function defaultBaselinePath(repoRoot) {
  const key = createHash('sha256')
    .update(path.resolve(repoRoot))
    .digest('hex')
    .slice(0, 16);
  return path.join(
    os.tmpdir(),
    'mandrel-test-temp-hygiene',
    `snapshot-${key}.json`,
  );
}

/**
 * Refuse a baseline path that resolves inside the protected `temp/` tree —
 * storing the attestation inside the tree it attests recreates the
 * fail-open gap this Story closes.
 *
 * @param {string} repoRoot
 * @param {string} baselinePath
 * @returns {string} the resolved baseline path
 */
function checkedBaselinePath(repoRoot, baselinePath) {
  const resolved = path.resolve(baselinePath);
  const tempDir = path.resolve(tempDirFor(repoRoot));
  if (resolved === tempDir || resolved.startsWith(tempDir + path.sep)) {
    throw new Error(
      `[test-temp-hygiene] baseline path must live outside the protected temp/ tree; got ${resolved}`,
    );
  }
  return resolved;
}

/**
 * Is `rel` (a path relative to `temp/`, POSIX-normalised) a telemetry stream
 * file we guard? Stream files are `*.ndjson` living under a `run-<id>/`
 * subtree or the `standalone/stories/` subtree.
 *
 * @param {string} rel
 * @returns {boolean}
 */
export function isStreamFile(rel) {
  if (!rel.endsWith('.ndjson')) return false;
  const first = rel.split('/')[0];
  if (/^run-\d+$/.test(first)) return true;
  return rel.startsWith('standalone/stories/');
}

/**
 * Recursively list every stream file under `tempDir`, returned as
 * POSIX-normalised paths relative to `tempDir`, sorted for determinism.
 *
 * @param {string} tempDir
 * @returns {string[]}
 */
export function listStreamFiles(tempDir) {
  if (!existsSync(tempDir)) return [];
  /** @type {string[]} */
  const out = [];
  const walk = (absDir, relDir) => {
    for (const ent of readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, ent.name);
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(abs, rel);
      } else if (ent.isFile() && isStreamFile(rel)) {
        out.push(rel);
      }
    }
  };
  walk(tempDir, '');
  return out.sort();
}

/**
 * Fingerprint a single file by byte length + sha256 of its contents.
 * @param {string} absPath
 * @returns {{ size: number, sha256: string }}
 */
export function fingerprintFile(absPath) {
  const buf = readFileSync(absPath);
  return {
    size: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
}

/**
 * Build a `{ [relPath]: fingerprint }` manifest of every stream file under
 * `tempDir`.
 * @param {string} tempDir
 * @returns {Record<string, { size: number, sha256: string }>}
 */
export function buildManifest(tempDir) {
  /** @type {Record<string, { size: number, sha256: string }>} */
  const manifest = {};
  for (const rel of listStreamFiles(tempDir)) {
    manifest[rel] = fingerprintFile(path.join(tempDir, rel));
  }
  return manifest;
}

/**
 * Persist the current manifest to the baseline path (default: the external
 * `defaultBaselinePath` — never inside `temp/`).
 * @param {string} repoRoot
 * @param {string} [baselinePath]
 * @returns {{ snapshotPath: string, count: number }}
 */
export function writeSnapshot(repoRoot, baselinePath) {
  const snapshotPath = checkedBaselinePath(
    repoRoot,
    baselinePath ?? defaultBaselinePath(repoRoot),
  );
  const manifest = buildManifest(tempDirFor(repoRoot));
  mkdirSync(path.dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { snapshotPath, count: Object.keys(manifest).length };
}

/**
 * Load the persisted manifest, or `null` when no snapshot exists.
 * @param {string} repoRoot
 * @param {string} [baselinePath]
 * @returns {Record<string, { size: number, sha256: string }> | null}
 */
export function readSnapshot(repoRoot, baselinePath) {
  const snapshotPath = checkedBaselinePath(
    repoRoot,
    baselinePath ?? defaultBaselinePath(repoRoot),
  );
  if (!existsSync(snapshotPath)) return null;
  return JSON.parse(readFileSync(snapshotPath, 'utf8'));
}

/**
 * Diff the current stream tree against a snapshot manifest.
 *
 * `added`   — stream files present now but absent from the snapshot.
 * `changed` — stream files whose size or sha256 differs from the snapshot
 *             (i.e. a test grew or rewrote an existing stream).
 *
 * A file that shrank or vanished is not a pollution signal, so it is ignored.
 *
 * @param {string} tempDir
 * @param {Record<string, { size: number, sha256: string }>} snapshot
 * @returns {{ added: string[], changed: string[] }}
 */
export function diffAgainstSnapshot(tempDir, snapshot) {
  const current = buildManifest(tempDir);
  const added = [];
  const changed = [];
  for (const [rel, fp] of Object.entries(current)) {
    const prior = snapshot[rel];
    if (!prior) {
      added.push(rel);
    } else if (prior.size !== fp.size || prior.sha256 !== fp.sha256) {
      changed.push(rel);
    }
  }
  return { added: added.sort(), changed: changed.sort() };
}

/**
 * Extract the fixture-matching id from a top-level `temp/` entry name, or
 * `null` when the entry is not an id-keyed stream directory.
 *
 * `run-<id>` maps to `<id>`; the `standalone/stories/story-<id>` shape is
 * handled by the caller (it recurses one level deeper).
 *
 * @param {string} name
 * @returns {number|null}
 */
function runDirId(name) {
  const m = /^run-(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

/**
 * Locate stream directories whose Epic/Story id is in `ids`.
 *
 * Two shapes are swept: `temp/run-<id>/` (Epic-scoped) and
 * `temp/standalone/stories/story-<id>/` (standalone Story-scoped).
 *
 * @param {string} tempDir
 * @param {ReadonlySet<number>} ids
 * @returns {{ id: number, kind: 'run' | 'standalone-story', rel: string }[]}
 */
export function findFixtureDirs(tempDir, ids) {
  if (!existsSync(tempDir)) return [];
  const found = [];
  for (const ent of readdirSync(tempDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const id = runDirId(ent.name);
    if (id !== null && ids.has(id)) {
      found.push({ id, kind: 'run', rel: ent.name });
    }
  }
  const storiesDir = path.join(tempDir, 'standalone', 'stories');
  if (existsSync(storiesDir)) {
    for (const ent of readdirSync(storiesDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const m = /^story-(\d+)$/.exec(ent.name);
      const id = m ? Number(m[1]) : null;
      if (id !== null && ids.has(id)) {
        found.push({
          id,
          kind: 'standalone-story',
          rel: `standalone/stories/${ent.name}`,
        });
      }
    }
  }
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Report (and optionally delete) fixture-id stream directories.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {Iterable<number>} [opts.ids]
 * @param {boolean} [opts.apply=false] delete when true; report-only otherwise.
 * @returns {{ candidates: { id: number, kind: string, rel: string }[], removed: string[] }}
 */
export function cleanFixtureDirs({
  repoRoot,
  ids = KNOWN_FIXTURE_STORY_IDS,
  apply = false,
}) {
  const tempDir = tempDirFor(repoRoot);
  const candidates = findFixtureDirs(tempDir, new Set(ids));
  const removed = [];
  if (apply) {
    for (const c of candidates) {
      rmSync(path.join(tempDir, c.rel), { recursive: true, force: true });
      removed.push(c.rel);
    }
  }
  return { candidates, removed };
}

/**
 * Parse the CLI argv into a normalised options object.
 * @param {string[]} argv
 * @returns {{ mode: 'snapshot'|'assert'|'clean', apply: boolean, ids: number[]|null, repoRoot: string, baseline: string|null }}
 */
export function parseArgv(argv) {
  let mode = 'assert';
  let apply = false;
  let ids = null;
  let repoRoot = REPO_ROOT;
  let baseline = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--snapshot') mode = 'snapshot';
    else if (arg === '--assert') mode = 'assert';
    else if (arg === '--clean') mode = 'clean';
    else if (arg === '--yes') apply = true;
    else if (arg === '--ids') {
      i += 1;
      ids = String(argv[i] ?? '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    } else if (arg === '--root') {
      i += 1;
      repoRoot = path.resolve(String(argv[i] ?? '.'));
    } else if (arg === '--baseline') {
      i += 1;
      baseline = path.resolve(String(argv[i] ?? '.'));
    }
  }
  return { mode, apply, ids, repoRoot, baseline };
}

/**
 * Execute the guard for a parsed options object. Returns the process exit
 * code (0 = clean / snapshot recorded; 1 = pollution detected under
 * --assert). Printing is done via the injectable `log`.
 *
 * @param {ReturnType<typeof parseArgv>} opts
 * @param {(line: string) => void} [log]
 * @returns {number}
 */
export function runHygiene(opts, log = (l) => process.stdout.write(`${l}\n`)) {
  const { mode, apply, ids, repoRoot, baseline = null } = opts;
  if (mode === 'snapshot') {
    const { snapshotPath, count } = writeSnapshot(repoRoot, baseline);
    log(
      `[test-temp-hygiene] snapshot recorded (${count} stream file(s)) → ${snapshotPath}`,
    );
    return 0;
  }
  if (mode === 'clean') {
    const { candidates } = cleanFixtureDirs({
      repoRoot,
      ids: ids ?? KNOWN_FIXTURE_STORY_IDS,
      apply,
    });
    if (candidates.length === 0) {
      log('[test-temp-hygiene] no fixture-id stream directories found.');
      return 0;
    }
    log(
      `[test-temp-hygiene] ${candidates.length} fixture-id stream director(y/ies)${
        apply ? ' removed' : ' (report-only; pass --yes to delete)'
      }:`,
    );
    for (const c of candidates) {
      log(`  - ${c.rel} (id ${c.id}, ${c.kind})`);
    }
    return 0;
  }
  // mode === 'assert'
  const snapshotPath = baseline ?? defaultBaselinePath(repoRoot);
  const snapshot = readSnapshot(repoRoot, snapshotPath);
  if (snapshot === null) {
    log(
      `[test-temp-hygiene] FAIL — snapshot missing (${path.resolve(snapshotPath)}); guard cannot attest. Run --snapshot before the suite (never re-baseline at assert time).`,
    );
    return 1;
  }
  const { added, changed } = diffAgainstSnapshot(
    tempDirFor(repoRoot),
    snapshot,
  );
  if (added.length === 0 && changed.length === 0) {
    log('[test-temp-hygiene] OK — no new or grown stream files under temp/.');
    return 0;
  }
  log(
    '[test-temp-hygiene] FAIL — the test suite polluted the real temp/ tree:',
  );
  for (const rel of added) log(`  + new    ${rel}`);
  for (const rel of changed) log(`  ~ grew   ${rel}`);
  log(
    '[test-temp-hygiene] a writer bypassed the scratch seam. Inject an absolute per-test tempRoot; do not weaken this guard.',
  );
  return 1;
}

runAsCli(
  import.meta.url,
  async () => {
    const code = runHygiene(parseArgv(process.argv.slice(2)));
    return code;
  },
  { source: 'check-test-temp-hygiene', propagateExitCode: true },
);
