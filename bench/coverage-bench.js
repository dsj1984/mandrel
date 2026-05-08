/**
 * Coverage runner micro-benchmark.
 *
 * Compares two paths for `npm run test:coverage` end-to-end on a Windows host:
 *
 *   A) c8 wrap         — `c8 node --test ...` (current production path)
 *   B) NODE_V8_COVERAGE — set the env var, run `node --test ...` directly,
 *                         then post-process with `c8 report`
 *
 * Each path runs 3× back-to-back. We report median wall-clock and the
 * line/branch percentages from the resulting coverage-final.json so any
 * accidental scope drift between the two paths is visible.
 *
 * Both paths read include/exclude/thresholds from `.c8rc.cjs` — the bench
 * does not override scope. Thresholds (--lines=85 --branches=70
 * --functions=75) stay on c8's side; we don't enforce them here, the bench
 * only measures.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COVERAGE_DIR = path.join(ROOT, 'coverage');
const V8_TMP = path.join(COVERAGE_DIR, 'tmp');
const FINAL_JSON = path.join(COVERAGE_DIR, 'coverage-final.json');

const RUNS_PER_PATH = 3;
const TEST_GLOB = 'tests/**/*.test.js';

const NODE_TEST_ARGS = [
  '--experimental-test-module-mocks',
  '--test',
  '--test-concurrency=8',
  TEST_GLOB,
];

function cleanCoverage() {
  if (existsSync(COVERAGE_DIR)) {
    rmSync(COVERAGE_DIR, { recursive: true, force: true });
  }
  mkdirSync(COVERAGE_DIR, { recursive: true });
}

function runCmd(cmd, args, env = {}) {
  const start = process.hrtime.bigint();
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    shell: true,
  });
  const ns = process.hrtime.bigint() - start;
  return {
    ms: Number(ns / 1_000_000n),
    code: res.status,
    stdout: res.stdout?.toString() ?? '',
    stderr: res.stderr?.toString() ?? '',
  };
}

function summarizeFinalJson() {
  if (!existsSync(FINAL_JSON)) {
    return { lines: null, branches: null, functions: null, files: 0 };
  }
  const raw = JSON.parse(readFileSync(FINAL_JSON, 'utf8'));
  let lT = 0;
  let lC = 0;
  let bT = 0;
  let bC = 0;
  let fT = 0;
  let fC = 0;
  let files = 0;
  for (const entry of Object.values(raw)) {
    files++;
    const sMap = entry.s ?? {};
    const bMap = entry.b ?? {};
    const fMap = entry.f ?? {};
    for (const v of Object.values(sMap)) {
      lT++;
      if (v > 0) lC++;
    }
    for (const arr of Object.values(bMap)) {
      for (const v of arr) {
        bT++;
        if (v > 0) bC++;
      }
    }
    for (const v of Object.values(fMap)) {
      fT++;
      if (v > 0) fC++;
    }
  }
  const pct = (c, t) => (t === 0 ? 0 : (100 * c) / t);
  return {
    lines: pct(lC, lT).toFixed(2),
    branches: pct(bC, bT).toFixed(2),
    functions: pct(fC, fT).toFixed(2),
    files,
  };
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function runPathA() {
  cleanCoverage();
  const r = runCmd(NPX, [
    'c8',
    '-r',
    'json',
    '-r',
    'text-summary',
    'node',
    ...NODE_TEST_ARGS,
  ]);
  return { ...r, summary: summarizeFinalJson() };
}

function runPathB() {
  cleanCoverage();
  mkdirSync(V8_TMP, { recursive: true });
  const inner = runCmd('node', NODE_TEST_ARGS, {
    NODE_V8_COVERAGE: V8_TMP,
  });
  // Always run the report step even if inner tests had failures — partial
  // coverage is still meaningful for the timing comparison and matches what
  // c8 (path A) does internally.
  const report = runCmd(NPX, [
    'c8',
    'report',
    '-r',
    'json',
    '-r',
    'text-summary',
    '--temp-directory',
    V8_TMP,
  ]);
  return {
    ms: inner.ms + report.ms,
    code: inner.code !== 0 ? inner.code : report.code,
    stdout: `${inner.stdout}\n--- c8 report ---\n${report.stdout}`,
    stderr: `${inner.stderr}\n${report.stderr}`,
    summary: summarizeFinalJson(),
  };
}

function bench(label, fn) {
  const runs = [];
  for (let i = 1; i <= RUNS_PER_PATH; i++) {
    process.stdout.write(`[${label}] run ${i}/${RUNS_PER_PATH} ...`);
    const r = fn();
    runs.push(r);
    process.stdout.write(
      ` ${r.ms} ms  code=${r.code}  lines=${r.summary.lines}  branches=${r.summary.branches}  files=${r.summary.files}\n`,
    );
    if (r.code !== 0) {
      process.stderr.write(`[${label}] non-zero exit; stderr tail:\n`);
      process.stderr.write(r.stderr.slice(-1500));
    }
  }
  return {
    label,
    medianMs: median(runs.map((r) => r.ms)),
    runs: runs.map((r) => ({
      ms: r.ms,
      code: r.code,
      lines: r.summary.lines,
      branches: r.summary.branches,
      functions: r.summary.functions,
      files: r.summary.files,
    })),
  };
}

const a = bench('A: c8 wrap', runPathA);
const b = bench('B: NODE_V8_COVERAGE + c8 report', runPathB);

console.log('\n=== Summary ===');
console.log(JSON.stringify({ pathA: a, pathB: b }, null, 2));
console.log(
  `\nmedian A=${a.medianMs}ms  median B=${b.medianMs}ms  delta=${b.medianMs - a.medianMs}ms (${b.medianMs < a.medianMs ? 'B faster' : 'A faster'})`,
);
