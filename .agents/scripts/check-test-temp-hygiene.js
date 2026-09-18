#!/usr/bin/env node

/**
 * Test-temp hygiene guard: fails when the suite pollutes the repo `temp/`
 * telemetry streams (which every retro reads) or leaves a `mandrel-suite-*`
 * root behind in the OS temp root. Pre-existing suite roots are recorded at
 * snapshot time so a concurrent suite in another checkout cannot fail this
 * one. `--lint-globs` is off by default because this script ships in the
 * consumer payload and a consumer's tests are not its business.
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
import { mainCheckoutRoot } from './lib/config/temp-paths.js';
import {
  isReservedTestId,
  RESERVED_TEST_ID_BAND,
} from './lib/reserved-test-ids.js';
import {
  findRawTmpdirMkdtemp,
  listSuiteTempRoots,
  SUITE_ROOTS_KEY,
  survivingSuiteTempRoots,
} from './lib/test-temp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Fixture ids `--clean` targets by default, so real `run-<id>` scratch is never swept. */
export const KNOWN_FIXTURE_STORY_IDS = Object.freeze([
  4428, 10, 4242, 5, 42, 100, 555, 2839, 4257, 4258, 4259,
]);

/**
 * @param {string} repoRoot
 * @returns {string}
 */
export function tempDirFor(repoRoot) {
  return path.join(repoRoot, 'temp');
}

/**
 * Snapshot path outside the protected `temp/` tree (a test wiping `temp/`
 * must not destroy the attestation), keyed by repo root so worktrees never
 * collide.
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
 * Refuse a baseline inside `temp/`: attesting from inside the tree fails open.
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
 * Stream files are `*.ndjson` under `run-<id>/` or `standalone/stories/`.
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
 * @param {string} repoRoot
 * @param {string} [baselinePath]
 * @param {{ tmpDir?: string }} [deps]
 * @returns {{ snapshotPath: string, count: number, suiteRoots: number }}
 */
export function writeSnapshot(repoRoot, baselinePath, { tmpDir } = {}) {
  const snapshotPath = checkedBaselinePath(
    repoRoot,
    baselinePath ?? defaultBaselinePath(repoRoot),
  );
  const manifest = buildManifest(tempDirFor(repoRoot));
  const count = Object.keys(manifest).length;
  // Cannot shadow a stream entry: those are always `*.ndjson` paths.
  manifest[SUITE_ROOTS_KEY] = listSuiteTempRoots(tmpDir ?? os.tmpdir());
  mkdirSync(path.dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return {
    snapshotPath,
    count,
    suiteRoots: manifest[SUITE_ROOTS_KEY].length,
  };
}

/**
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
 * A stream that vanished is not a pollution signal, so it is ignored.
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
 * @param {string} name
 * @returns {number|null}
 */
function runDirId(name) {
  const m = /^run-(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

/**
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
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {Iterable<number>} [opts.ids]
 * @param {boolean} [opts.apply=false]
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
 * A nested `run-<eid>/…/story-<sid>/` stream yields both ids, so a fixture
 * Story under a real run cannot slip past.
 * @param {string} rel
 * @returns {number[]}
 */
function streamOwnerIds(rel) {
  const ids = [];
  const run = /^run-(\d+)$/.exec(rel.split('/')[0]);
  if (run) ids.push(Number(run[1]));
  const story = /(?:^|\/)story-(\d+)\//.exec(rel);
  if (story) ids.push(Number(story[1]));
  return ids;
}

/**
 * Streams owned by a reserved test-fixture id. Covers local runs the CI-only
 * snapshot bracket cannot, and needs no baseline: only a test can own one.
 * @param {string} tempDir
 * @returns {string[]}
 */
export function findReservedIdStreamFiles(tempDir) {
  return listStreamFiles(tempDir).filter((rel) =>
    streamOwnerIds(rel).some(isReservedTestId),
  );
}

/**
 * Scans the main checkout's temp tree, not `cwd`: writers anchor relative
 * `tempRoot` there, so scanning a worktree would pass vacuously.
 * @param {object} [opts]
 * @param {string} [opts.cwd=process.cwd()]
 * @param {(line: string) => void} [opts.log]
 * @param {(cwd: string) => string|null} [opts.resolveRoot]
 * @returns {number}
 */
export function assertNoReservedIdStreams({
  cwd = process.cwd(),
  log = (l) => process.stderr.write(`${l}\n`),
  resolveRoot = mainCheckoutRoot,
} = {}) {
  const root = resolveRoot(cwd) ?? cwd;
  const tempDir = tempDirFor(root);
  const found = findReservedIdStreamFiles(tempDir);
  if (found.length === 0) return 0;
  log(
    `[test-temp-hygiene] FAIL — ${found.length} fixture-id telemetry stream(s) in the real temp tree (${tempDir}):`,
  );
  for (const rel of found) log(`  + fixture ${rel}`);
  log(
    `[test-temp-hygiene] ids ${RESERVED_TEST_ID_BAND} are reserved for fixtures, so a test wrote to the live ledger — the retro graduator reads these streams and files tickets off them. Inject an absolute per-test tempRoot on the offending spawn, then remove the stream(s) with --clean --ids <id> --yes.`,
  );
  return 1;
}

/**
 * @param {string[]} argv
 * @returns {{ mode: 'snapshot'|'assert'|'clean', apply: boolean, ids: number[]|null, repoRoot: string, baseline: string|null, lintGlobs: string[] }}
 */
export function parseArgv(argv) {
  let mode = 'assert';
  let apply = false;
  let ids = null;
  let repoRoot = REPO_ROOT;
  let baseline = null;
  let lintGlobs = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--snapshot') mode = 'snapshot';
    else if (arg === '--assert') mode = 'assert';
    else if (arg === '--clean') mode = 'clean';
    else if (arg === '--yes') apply = true;
    else if (arg === '--lint-globs') {
      i += 1;
      lintGlobs = String(argv[i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === '--ids') {
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
  return { mode, apply, ids, repoRoot, baseline, lintGlobs };
}

/**
 * @param {ReturnType<typeof parseArgv>} opts
 * @param {(line: string) => void} [log]
 * @param {{ tmpDir?: string }} [deps]
 * @returns {number}
 */
export function runHygiene(
  opts,
  log = (l) => process.stdout.write(`${l}\n`),
  { tmpDir = os.tmpdir() } = {},
) {
  const { mode, apply, ids, repoRoot, baseline = null, lintGlobs = [] } = opts;
  if (mode === 'snapshot') {
    const { snapshotPath, count, suiteRoots } = writeSnapshot(
      repoRoot,
      baseline,
      { tmpDir },
    );
    log(
      `[test-temp-hygiene] snapshot recorded (${count} stream file(s), ${suiteRoots} pre-existing suite root(s)) → ${snapshotPath}`,
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
  // Run every dimension so one failure cannot hide another.
  const codes = [
    assertStreamTree(repoRoot, snapshot, log),
    assertNoSurvivingSuiteRoots(snapshot, log, tmpDir),
    assertNoRawTmpdirMkdtemp(repoRoot, lintGlobs, log),
  ];
  return Math.max(...codes);
}

/**
 * @param {string} repoRoot
 * @param {Record<string, unknown>} snapshot
 * @param {(line: string) => void} log
 * @returns {number} exit code
 */
function assertStreamTree(repoRoot, snapshot, log) {
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

/**
 * A suite root that appeared since the snapshot and survived was never reaped.
 * @param {Record<string, unknown>} snapshot
 * @param {(line: string) => void} log
 * @param {string} tmpDir
 * @returns {number} exit code
 */
function assertNoSurvivingSuiteRoots(snapshot, log, tmpDir) {
  const before = Array.isArray(snapshot[SUITE_ROOTS_KEY])
    ? snapshot[SUITE_ROOTS_KEY]
    : [];
  const surviving = survivingSuiteTempRoots(tmpDir, before);
  if (surviving.length === 0) {
    log('[test-temp-hygiene] OK — no suite temp roots survived the run.');
    return 0;
  }
  log(
    `[test-temp-hygiene] FAIL — ${surviving.length} suite temp root(s) survived in ${tmpDir}:`,
  );
  for (const name of surviving) log(`  + leaked ${name}`);
  log(
    '[test-temp-hygiene] a process minted a suite root and exited without reaping it. Do not delete these by hand — find the writer that bypassed makeTempDir().',
  );
  return 1;
}

/**
 * @param {string} repoRoot
 * @param {string[]} globs
 * @param {(line: string) => void} log
 * @returns {number} exit code
 */
function assertNoRawTmpdirMkdtemp(repoRoot, globs, log) {
  if (!globs || globs.length === 0) {
    log(
      '[test-temp-hygiene] SKIP — raw-tmpdir lint not requested (pass --lint-globs to enable).',
    );
    return 0;
  }
  const findings = findRawTmpdirMkdtemp(repoRoot, globs);
  if (findings.length === 0) {
    log(
      '[test-temp-hygiene] OK — no test file mints OS temp dirs outside makeTempDir().',
    );
    return 0;
  }
  log(
    `[test-temp-hygiene] FAIL — ${findings.length} raw os.tmpdir() mkdtemp call(s) in test files:`,
  );
  for (const f of findings) log(`  ${f.file}:${f.line}  ${f.text}`);
  log(
    "[test-temp-hygiene] use makeTempDir() from .agents/scripts/lib/test-temp.js so teardown is registered, or mark the line 'test-temp-allow: <reason>' when the real root is genuinely required.",
  );
  return 1;
}

runAsCli(
  import.meta.url,
  async () => {
    const code = runHygiene(parseArgv(process.argv.slice(2)));
    return code;
  },
  {
    source: 'check-test-temp-hygiene',
    propagateExitCode: true,
    usage: {
      invocation:
        'node .agents/scripts/check-test-temp-hygiene.js [--snapshot | --assert | --clean] [--baseline <path>] [--lint-globs <globs>] [--ids <ids>] [--root <dir>]',
      summary:
        'Regression guard for test-fixture pollution of the temp trees: the repo temp/ telemetry streams every retro reads, and the OS temp root the suite scratch dirs nest under.',
      flags: [
        [
          '--snapshot',
          'Fingerprint every temp/ stream file and the pre-existing OS suite roots. Run BEFORE the suite.',
        ],
        [
          '--assert',
          'Re-scan and fail on any stream added or grown, or a surviving suite root. Run AFTER the suite. This is the default when no mode flag is passed.',
        ],
        [
          '--clean',
          'List stream directories whose Epic/Story id matches a known fixture id. Report-only — deletes nothing.',
        ],
        [
          '--baseline <path>',
          'Explicit snapshot path (CI sets a runner-temp path). Defaults to an OS scratch location keyed by the repo root; refused inside the protected temp/ tree.',
        ],
        [
          '--lint-globs <globs>',
          'Comma-separated repo-relative globs scanned for tests calling mkdtemp against os.tmpdir() instead of makeTempDir(). Off unless passed.',
        ],
        ['--ids <ids>', 'Comma-separated fixture ids for --clean.'],
        ['--root <dir>', 'Repository root to scan (default: repo root).'],
      ],
      notes: [
        '--assert requires a snapshot recorded by an earlier --snapshot run: a missing one is a hard failure, never a silent re-baseline.',
        'Exit codes:\n  0  clean\n  1  a breach, or --assert with no snapshot to attest against',
      ],
    },
  },
);
