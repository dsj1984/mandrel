import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSingleFileTap, parseSuiteTap } from './parse-tap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_LOADER = path.resolve(__dirname, 'env-snapshot-loader.js');

const NODE_TEST_BASE = [
  '--experimental-test-module-mocks',
  '--test',
  '--test-reporter=tap',
];

/**
 * @typedef {{ added: string[], removed: string[], changed: string[] }} EnvDiff
 *
 * @typedef {{
 *   file: string,
 *   status: 'pass' | 'fail',
 *   failingTests: string[],
 *   envDiff: EnvDiff | null,
 *   durationMs: number,
 * }} IsolatedResult
 *
 * @typedef {{
 *   file: string,
 *   status: 'pass' | 'fail' | 'missing',
 *   failingTests: string[],
 * }} SuiteResult
 *
 * @typedef {{
 *   file: string,
 *   suspects: string[],
 *   inconclusive: boolean,
 * }} BisectionResult
 *
 * @typedef {{
 *   pattern: string,
 *   files: string[],
 *   isolated: IsolatedResult[],
 *   suite: SuiteResult[],
 *   flippers: string[],
 *   bisections: BisectionResult[],
 *   envMutators: { file: string, envDiff: EnvDiff }[],
 *   durationMs: number,
 * }} IsolateReport
 */

/**
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.file
 * @param {string} [opts.envOutDir]  Directory for env-diff output files.
 * @param {number} [opts.timeoutMs]
 * @param {typeof spawn} [opts.spawnFn]
 * @returns {Promise<IsolatedResult>}
 */
export function runFileIsolated({
  repoRoot,
  file,
  envOutDir,
  timeoutMs = 120_000,
  spawnFn = spawn,
}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const envOutPath = envOutDir
      ? path.join(envOutDir, `${file.replace(/[\\/]/g, '__')}.env-diff`)
      : null;
    if (envOutPath) {
      cleanupEnvSidecars(envOutPath);
    }
    const args = [...NODE_TEST_BASE, '--test-concurrency=1', file];
    const nodeOptions = envOutPath
      ? `--import ${pathToFileUrl(ENV_LOADER)}`
      : '';
    const child = spawnFn(process.execPath, args, {
      cwd: repoRoot,
      env: {
        ...sanitizeEnv(process.env),
        NODE_OPTIONS: nodeOptions,
        TEST_ISOLATE_ENV_OUT: envOutPath ?? '',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        SKIP_PREFLIGHT: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseSingleFileTap(stdout + stderr, code ?? 1);
      const envDiff = readEnvDiff(envOutPath);
      resolve({
        file,
        status: parsed.status,
        failingTests: parsed.failingTests,
        envDiff,
        durationMs: Date.now() - started,
      });
    });
  });
}

function readEnvDiff(envOutPath) {
  if (!envOutPath) return null;
  const dir = path.dirname(envOutPath);
  const base = path.basename(envOutPath);
  let merged = null;
  try {
    if (!fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.startsWith(`${base}.`) || !entry.endsWith('.json')) continue;
      try {
        /** @type {EnvDiff} */
        const parsed = JSON.parse(
          fs.readFileSync(path.join(dir, entry), 'utf8'),
        );
        merged = mergeEnvDiffs(merged, parsed);
      } catch {
        // skip unreadable sidecar
      }
    }
  } catch {
    return null;
  }
  return merged;
}

function mergeEnvDiffs(a, b) {
  if (!a) return b;
  const dedupe = (arr) => Array.from(new Set(arr));
  return {
    added: dedupe([...(a.added ?? []), ...(b.added ?? [])]),
    removed: dedupe([...(a.removed ?? []), ...(b.removed ?? [])]),
    changed: dedupe([...(a.changed ?? []), ...(b.changed ?? [])]),
  };
}

function cleanupEnvSidecars(envOutPath) {
  const dir = path.dirname(envOutPath);
  const base = path.basename(envOutPath);
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith(`${base}.`) && entry.endsWith('.json')) {
      try {
        fs.rmSync(path.join(dir, entry), { force: true });
      } catch {
        // ignore
      }
    }
  }
}

function pathToFileUrl(p) {
  return pathToFileURL(p).href;
}

/**
 * Strip env vars that signal "I am a node:test worker" so spawned child
 * `node --test` processes don't refuse to run with "node:test run() is
 * being called recursively". This lets `test-isolate` itself be exercised
 * from inside the project's own test suite.
 */
function sanitizeEnv(source) {
  const out = { ...source };
  for (const key of Object.keys(out)) {
    if (key.startsWith('NODE_TEST_CONTEXT')) delete out[key];
  }
  delete out.NODE_TEST_CONTEXT;
  return out;
}

/**
 * Run a list of test files inside a single `node --test` invocation at the
 * given concurrency. Returns per-file pass/fail parsed from TAP.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string[]} opts.files
 * @param {number} [opts.concurrency]
 * @param {number} [opts.timeoutMs]
 * @param {typeof spawn} [opts.spawnFn]
 * @returns {Promise<{ results: SuiteResult[], exitCode: number, stdout: string, stderr: string }>}
 */
export function runSuite({
  repoRoot,
  files,
  concurrency = 8,
  timeoutMs = 5 * 60 * 1000,
  spawnFn = spawn,
}) {
  return new Promise((resolve) => {
    if (files.length === 0) {
      resolve({ results: [], exitCode: 0, stdout: '', stderr: '' });
      return;
    }
    const args = [
      ...NODE_TEST_BASE,
      `--test-concurrency=${concurrency}`,
      ...files,
    ];
    const child = spawnFn(process.execPath, args, {
      cwd: repoRoot,
      env: {
        ...sanitizeEnv(process.env),
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        SKIP_PREFLIGHT: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseSuiteTap(stdout + stderr);
      // Node's TAP reporter prints subtest names using the host path
      // separator (backslashes on Windows). Look up both forms.
      const results = files.map((file) => {
        const winForm = file.replace(/\//g, '\\');
        const entry = parsed.get(file) ?? parsed.get(winForm);
        if (!entry) {
          return { file, status: 'missing', failingTests: [] };
        }
        return {
          file,
          status: entry.status,
          failingTests: entry.failingTests,
        };
      });
      resolve({ results, exitCode: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Run isolated runs in parallel across a worker pool.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string[]} opts.files
 * @param {string} [opts.envOutDir]
 * @param {number} [opts.workers]
 * @param {number} [opts.timeoutMs]
 * @param {(r: IsolatedResult) => void} [opts.onResult]
 * @returns {Promise<IsolatedResult[]>}
 */
export async function runIsolatedPool({
  repoRoot,
  files,
  envOutDir,
  workers = Math.max(2, Math.min(os.cpus().length, 8)),
  timeoutMs = 120_000,
  onResult,
}) {
  const queue = [...files];
  const results = [];
  const workerCount = Math.min(workers, queue.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const file = queue.shift();
        if (!file) return;
        const r = await runFileIsolated({
          repoRoot,
          file,
          envOutDir,
          timeoutMs,
        });
        results.push(r);
        if (onResult) onResult(r);
      }
    }),
  );
  return results;
}

/**
 * Bisect to find the smallest candidate subset (down to a single file) whose
 * presence alongside `target` reproduces `target` failing.
 *
 * Strategy: binary halving. Run `[half, target]` at full concurrency. If
 * `target` fails, recurse into `half`; else recurse into the other half. The
 * search depth is capped — when both halves keep failing or neither
 * reproduces, the bisection is marked inconclusive and the residual
 * candidate set returned as suspects.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.target           File that flipped (passed alone, failed in suite).
 * @param {string[]} opts.candidates     All other files in the suite.
 * @param {number} [opts.concurrency]
 * @param {number} [opts.maxDepth]
 * @param {(stage: string, payload: object) => void} [opts.onProgress]
 * @returns {Promise<BisectionResult>}
 */
export async function bisectFlipper({
  repoRoot,
  target,
  candidates,
  concurrency = 8,
  maxDepth = 8,
  onProgress,
  runSuiteFn = runSuite,
}) {
  let pool = [...candidates];
  let depth = 0;
  let inconclusive = false;

  while (pool.length > 1 && depth < maxDepth) {
    const mid = Math.ceil(pool.length / 2);
    const half = pool.slice(0, mid);
    const { results } = await runSuiteFn({
      repoRoot,
      files: [...half, target],
      concurrency,
    });
    const targetResult = results.find((r) => r.file === target);
    if (onProgress) {
      onProgress('probe', {
        target,
        depth,
        candidates: half.length,
        targetStatus: targetResult?.status,
      });
    }
    if (targetResult?.status === 'fail') {
      pool = half;
    } else {
      const other = pool.slice(mid);
      const r2 = await runSuiteFn({
        repoRoot,
        files: [...other, target],
        concurrency,
      });
      const t2 = r2.results.find((r) => r.file === target);
      if (onProgress) {
        onProgress('probe', {
          target,
          depth: depth + 0.5,
          candidates: other.length,
          targetStatus: t2?.status,
        });
      }
      if (t2?.status === 'fail') {
        pool = other;
      } else {
        inconclusive = true;
        break;
      }
    }
    depth += 1;
  }

  return {
    file: target,
    suspects: pool,
    inconclusive: inconclusive || pool.length > 1,
  };
}

/**
 * Drive the full isolation diagnosis.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string[]} opts.files
 * @param {number} [opts.suiteConcurrency]
 * @param {number} [opts.workers]
 * @param {number} [opts.maxBisectTargets]
 * @param {number} [opts.maxBisectDepth]
 * @param {(stage: string, payload?: object) => void} [opts.onProgress]
 * @returns {Promise<IsolateReport>}
 */
export async function diagnoseIsolation({
  repoRoot,
  files,
  suiteConcurrency = 8,
  workers,
  maxBisectTargets = 5,
  maxBisectDepth = 8,
  onProgress = () => {},
}) {
  const started = Date.now();
  const envOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-isolate-env-'));

  onProgress('isolated:start', { count: files.length });
  const isolated = await runIsolatedPool({
    repoRoot,
    files,
    envOutDir,
    workers,
    onResult: (r) =>
      onProgress('isolated:file', {
        file: r.file,
        status: r.status,
        durationMs: r.durationMs,
      }),
  });
  onProgress('isolated:done', { count: isolated.length });

  onProgress('suite:start', { count: files.length });
  const { results: suite } = await runSuite({
    repoRoot,
    files,
    concurrency: suiteConcurrency,
  });
  onProgress('suite:done', { count: suite.length });

  const suiteByFile = new Map(suite.map((s) => [s.file, s]));
  const isolatedByFile = new Map(isolated.map((s) => [s.file, s]));

  const flippers = files.filter((f) => {
    const iso = isolatedByFile.get(f);
    const ste = suiteByFile.get(f);
    return iso?.status === 'pass' && ste?.status === 'fail';
  });

  const bisectTargets = flippers.slice(0, maxBisectTargets);
  const bisections = [];
  for (const target of bisectTargets) {
    const candidates = files.filter((f) => f !== target);
    onProgress('bisect:start', { target });
    const result = await bisectFlipper({
      repoRoot,
      target,
      candidates,
      concurrency: suiteConcurrency,
      maxDepth: maxBisectDepth,
      onProgress,
    });
    bisections.push(result);
    onProgress('bisect:done', { target, suspects: result.suspects });
  }

  const envMutators = isolated
    .filter((r) => {
      const d = r.envDiff;
      return (
        d &&
        (d.added.length > 0 || d.removed.length > 0 || d.changed.length > 0)
      );
    })
    .map((r) => ({ file: r.file, envDiff: r.envDiff }));

  try {
    fs.rmSync(envOutDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  return {
    pattern: files.length === 1 ? files[0] : null,
    files,
    isolated,
    suite,
    flippers,
    bisections,
    envMutators,
    durationMs: Date.now() - started,
  };
}
