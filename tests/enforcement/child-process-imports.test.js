/**
 * child-process-imports.test.js — the ratchet behind the one exec surface
 * (Stories #5009, #5739).
 *
 * `.agents/scripts/lib/child-exec.js` owns the child-process stdout ceiling,
 * the `shell: false` posture, and the child failure-message shape. That
 * ownership only holds if new code cannot quietly reach around it, which is
 * what this test enforces, at two grains:
 *
 *  - **Imports (coarse outer guard).** The set of modules importing
 *    `node:child_process` directly is captured; a new importer fails.
 *  - **Raw capture call sites (Story #5739).** An allowlisted import was a
 *    licence to keep a raw, 1 MiB-buffer capture forever — the knip gate was
 *    the first casualty. So every use of a raw runner (`spawnSync`,
 *    `execSync`, `execFileSync`, `spawn`, `exec`, …) outside the wrapper is
 *    pinned per file with a written reason: a direct call that captures
 *    output, or a reference that seeds an injectable runner default (the
 *    call it feeds is just as raw). A call whose options say
 *    `stdio: 'inherit'` / `'ignore'` has nothing to overflow and is exempt by
 *    construction. Adding a site anywhere fails; removing one fails until its
 *    pin is lowered, so the count only shrinks.
 *
 * The failure mode this prevents is the one the ENOBUFS class kept
 * reproducing — a new spawn site with no `maxBuffer`, inheriting Node's 1 MB
 * default, killing its own child on a large `git show` or a chatty `pre-push`
 * hook, and getting fixed one site at a time (Stories #4914, #4915, #4948).
 *
 * Removing a module from the tree means removing its allowlist line: the
 * stale-entry test below refuses to let the allowlist outlive its files, so
 * the ratchet tightens with every deletion instead of accumulating slack.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Shipped source roots. Everything else (tests, fixtures, temp) is out of scope. */
const SCAN_ROOTS = ['.agents/scripts', 'bin', 'lib'];

/** Directory names never descended into while scanning. */
const SKIP_DIRS = new Set([
  '.git',
  '.worktrees',
  '__tests__',
  'coverage',
  'fixtures',
  'node_modules',
  'temp',
]);

/**
 * Static `import … from`, `require(…)` and dynamic `import(…)` of the Node
 * child-process module. A bare mention in a comment or JSDoc type is not an
 * import and must not trip the ratchet.
 */
const CHILD_PROCESS_IMPORT_RE =
  /(?:from\s*['"]node:child_process['"]|require\(\s*['"]node:child_process['"]\s*\)|import\(\s*['"]node:child_process['"]\s*\))/;

/**
 * Local bindings of the raw runners: named `import { … } from`, and
 * destructured `require(…)` / `await import(…)`.
 */
const CHILD_PROCESS_BINDING_RE =
  /import\s*\{([^}]*)\}\s*from\s*['"]node:child_process['"]|(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:require\(\s*|await\s+import\(\s*)['"]node:child_process['"]\s*\)/g;

/** The `node:child_process` runners whose output a caller can capture. */
const RAW_RUNNERS = new Set([
  'exec',
  'execFile',
  'execFileSync',
  'execSync',
  'fork',
  'spawn',
  'spawnSync',
]);

/** A call's options say there is no captured stream to overflow. */
const NO_CAPTURE_STDIO_RE = /stdio\s*:\s*['"](?:inherit|ignore)['"]/;

/** The shared exec surface itself — necessarily an importer, by definition. */
const WRAPPER = '.agents/scripts/lib/child-exec.js';

/**
 * Modules importing `node:child_process` directly as of Story #5009.
 *
 * Grandfathered, not endorsed. New code calls `child-exec.js` instead; an
 * addition here needs a reason that the wrapper genuinely cannot serve —
 * `spawn` streaming, a `timeout` bound, or a raw `error`/`signal` the
 * wrapper's contract deliberately does not surface.
 */
const ALLOWLIST = new Set([
  WRAPPER,
  '.agents/scripts/bootstrap.js',
  '.agents/scripts/check-windows-git-perf.js',
  '.agents/scripts/evidence-gate.js',
  '.agents/scripts/lib/bootstrap/preflight.js',
  '.agents/scripts/lib/bootstrap/project-bootstrap.js',
  '.agents/scripts/lib/bootstrap/prompt.js',
  '.agents/scripts/lib/bootstrap/quality-bootstrap.js',
  '.agents/scripts/lib/checks/state.js',
  '.agents/scripts/lib/close-validation/process.js',
  '.agents/scripts/lib/feedback-loop/graduator-gh.js',
  '.agents/scripts/lib/format-generated-json.js',
  '.agents/scripts/lib/gh-exec.js',
  '.agents/scripts/lib/git-utils.js',
  '.agents/scripts/lib/install-cmd-parser.js',
  '.agents/scripts/lib/onboard/init-tail.js',
  '.agents/scripts/lib/orchestration/remote-verifier.js',
  '.agents/scripts/lib/orchestration/review-providers/security-review.js',
  // Story #5485: streams a full suite as a supervised process group (inherit
  // stdio, group kill, suite-ready handshake) that the wrapper cannot serve.
  '.agents/scripts/lib/supervised-suite.js',
  '.agents/scripts/lib/test-runner-contract.js',
  '.agents/scripts/lib/worktree/git-hooks.js',
  '.agents/scripts/lib/worktree/lifecycle/force-drain.js',
  '.agents/scripts/mandrel-update-preflight.js',
  '.agents/scripts/providers/github/auth.js',
  '.agents/scripts/quality-watch.js',
  '.agents/scripts/run-tests.js',
  'lib/cli/doctor-checks/spawn.js',
  'lib/cli/guarded-sync.js',
  'lib/cli/init.js',
  'lib/cli/update.js',
]);

const SEAM_REASON =
  'seeds an injectable runner default (tests swap it); its captures are small probes';
const GIT_PROBE_REASON =
  'captures a short git probe (rev-parse / config / status line); far below 1 MiB';

/**
 * Every surviving raw runner use outside the wrapper, per file: callee →
 * count, where `<runner> (seam)` is a reference seeding an injectable default
 * and a bare `<runner>` is a direct capturing call. Pinned against the tree
 * this Story landed on (#5739); lower a count when you migrate a site.
 */
const RAW_CAPTURE_SITES = {
  '.agents/scripts/bootstrap.js': {
    reason: GIT_PROBE_REASON,
    sites: { spawnSync: 1 },
  },
  '.agents/scripts/check-windows-git-perf.js': {
    reason: GIT_PROBE_REASON,
    sites: { spawnSync: 2 },
  },
  '.agents/scripts/evidence-gate.js': {
    reason: SEAM_REASON,
    sites: { 'spawnSync (seam)': 1 },
  },
  '.agents/scripts/lib/bootstrap/preflight.js': {
    reason: GIT_PROBE_REASON,
    sites: { spawnSync: 1 },
  },
  '.agents/scripts/lib/bootstrap/project-bootstrap.js': {
    reason: SEAM_REASON,
    sites: { 'spawnSync (seam)': 3 },
  },
  '.agents/scripts/lib/bootstrap/prompt.js': {
    reason: GIT_PROBE_REASON,
    sites: { spawnSync: 1 },
  },
  '.agents/scripts/lib/bootstrap/quality-bootstrap.js': {
    reason: SEAM_REASON,
    sites: { 'spawnSync (seam)': 1 },
  },
  '.agents/scripts/lib/checks/state.js': {
    reason: GIT_PROBE_REASON,
    sites: { spawnSync: 1 },
  },
  '.agents/scripts/lib/close-validation/process.js': {
    reason:
      'async gate runner: streams line-prefixed stdio as it arrives; spawn() has no buffer to overflow',
    sites: { spawn: 1 },
  },
  '.agents/scripts/lib/feedback-loop/graduator-gh.js': {
    reason: 'streaming spawn() seam; no buffer to overflow',
    sites: { 'spawn (seam)': 1 },
  },
  '.agents/scripts/lib/format-generated-json.js': {
    reason: `${SEAM_REASON} (biome --stdin formats one generated file)`,
    sites: { 'spawnSync (seam)': 1 },
  },
  '.agents/scripts/lib/gh-exec.js': {
    reason:
      "exec()'s streaming spawn() seam, which collects its own output with no buffer to overflow (runGh routes through child-exec since #5756)",
    sites: { 'spawn (seam)': 1 },
  },
  '.agents/scripts/lib/git-utils.js': {
    reason:
      'already routes through child-exec; keeps the raw runners only as the swappable default seam',
    sites: { 'execFileSync (seam)': 2, 'spawnSync (seam)': 2 },
  },
  '.agents/scripts/lib/install-cmd-parser.js': {
    reason: `${SEAM_REASON}; the call it feeds streams stdio: 'inherit'`,
    sites: { 'spawnSync (seam)': 1 },
  },
  '.agents/scripts/lib/orchestration/remote-verifier.js': {
    reason: `${SEAM_REASON} (git remote / ls-remote)`,
    sites: { 'spawnSync (seam)': 2 },
  },
  '.agents/scripts/lib/orchestration/review-providers/security-review.js': {
    reason:
      'claude CLI probe and review-run seams; the review is timeout-bounded and reports a short summary',
    sites: { 'spawnSync (seam)': 2 },
  },
  '.agents/scripts/lib/supervised-suite.js': {
    reason:
      'supervised process group: inherit stdio, group kill, suite-ready handshake (Story #5485)',
    sites: { 'spawn (seam)': 1 },
  },
  '.agents/scripts/lib/test-runner-contract.js': {
    reason: `${SEAM_REASON} (contract probe runs)`,
    sites: { 'spawnSync (seam)': 1 },
  },
  '.agents/scripts/lib/worktree/git-hooks.js': {
    reason: `${SEAM_REASON} (git config core.hooksPath)`,
    sites: { 'execFileSync (seam)': 1 },
  },
  '.agents/scripts/lib/worktree/lifecycle/force-drain.js': {
    reason: `${SEAM_REASON} (process-table listing, taskkill)`,
    sites: { 'spawnSync (seam)': 3 },
  },
  '.agents/scripts/mandrel-update-preflight.js': {
    reason: 'staged-file list and npm ping before an update; small captures',
    sites: { execFileSync: 2 },
  },
  '.agents/scripts/providers/github/auth.js': {
    reason: `${SEAM_REASON} (gh auth token)`,
    sites: { 'execFileSync (seam)': 2 },
  },
  '.agents/scripts/quality-watch.js': {
    reason: 'streaming spawn() seam for the watch loop; no buffer to overflow',
    sites: { 'spawn (seam)': 1 },
  },
  '.agents/scripts/run-tests.js': {
    reason: `${SEAM_REASON} (suite runner)`,
    sites: { 'spawnSync (seam)': 1 },
  },
  'lib/cli/doctor-checks/spawn.js': {
    reason: "doctor's version / presence probes; small captures",
    sites: { spawnSync: 1 },
  },
  'lib/cli/guarded-sync.js': {
    reason: SEAM_REASON,
    sites: { 'spawnSync (seam)': 1 },
  },
  'lib/cli/update.js': {
    reason: `${SEAM_REASON} (npm view, git status, the new binary's phases)`,
    sites: { 'spawnSync (seam)': 3 },
  },
};

/**
 * Raw capture sites at the base of the last Story that migrated one (#5756;
 * main at ccbd466e5, before runGh moved onto child-exec), measured by the
 * same scanner. The pinned total must stay strictly below it, so the next
 * migrating Story lowers this to the total it starts from.
 */
const BASE_RAW_CAPTURE_SITE_COUNT = 42;

/**
 * A numeric `maxBuffer` option literal — the hand-copied constant this Story
 * consolidated, and the shape that had drifted to 10 / 16 / 64 MB across nine
 * modules. `maxBuffer: someIdentifier` is fine: the identifier resolves to an
 * import from the wrapper.
 */
const NUMERIC_MAX_BUFFER_RE = /maxBuffer\s*:\s*\d/;

/** Where the ceiling constant is *defined*, as opposed to referenced. */
const MAX_BUFFER_DEFINITION_RE = /\bMAX_BUFFER_BYTES\s*=/;

/**
 * Every non-test `.js` file under `SCAN_ROOTS`, as repo-relative POSIX paths.
 *
 * @param {string} root - Absolute repository root.
 * @returns {string[]}
 */
function listSourceFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.js') &&
        !entry.name.endsWith('.test.js')
      ) {
        found.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  for (const scanRoot of SCAN_ROOTS) {
    const abs = path.join(root, scanRoot);
    if (fs.existsSync(abs)) walk(abs);
  }
  return found.sort();
}

/**
 * Partition scanned files against the allowlist. Pure over its `read`
 * argument so the ratchet's own logic is testable without touching the tree.
 *
 * @param {string[]} files - Repo-relative paths.
 * @param {(file: string) => string} read - File-contents reader.
 * @param {Set<string>} allowlist
 * @returns {{ importers: string[], unallowed: string[], stale: string[] }}
 */
function auditChildProcessImports(files, read, allowlist) {
  const importers = files.filter((file) =>
    CHILD_PROCESS_IMPORT_RE.test(read(file)),
  );
  const importerSet = new Set(importers);
  return {
    importers,
    unallowed: importers.filter((file) => !allowlist.has(file)),
    stale: [...allowlist].filter((file) => !importerSet.has(file)).sort(),
  };
}

/**
 * Source files whose text matches `pattern`.
 *
 * @param {string[]} files
 * @param {(file: string) => string} read
 * @param {RegExp} pattern
 * @returns {string[]}
 */
function filesMatching(files, read, pattern) {
  return files.filter((file) => pattern.test(read(file)));
}

/**
 * Blank out comments, keeping offsets and newlines, so a runner named in
 * prose or JSDoc is never a site. String contents are kept verbatim.
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  let out = '';
  let quote = null;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      if (ch === '\\') {
        out += ch + (next ?? '');
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && (next === '*' || next === '/')) {
      const end =
        next === '*' ? src.indexOf('*/', i + 2) : src.indexOf('\n', i);
      let stop = src.length;
      if (end !== -1) stop = next === '*' ? end + 2 : end;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Text between the parenthesis at `open` and its match.
 *
 * @param {string} code
 * @param {number} open
 * @returns {string}
 */
function callArguments(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return code.slice(open + 1);
}

/**
 * `local → runner` for every raw runner the module binds, plus the import
 * spans (a binding's own declaration is not a use).
 *
 * @param {string} code - Comment-stripped source.
 */
function rawRunnerBindings(code) {
  const bindings = new Map();
  const spans = [];
  for (const match of code.matchAll(CHILD_PROCESS_BINDING_RE)) {
    spans.push([match.index, match.index + match[0].length]);
    for (const part of (match[1] ?? match[2]).split(',')) {
      const [runner, local = runner] = part
        .split(/\s+as\s+|\s*:\s*/)
        .map((word) => word.trim());
      if (RAW_RUNNERS.has(runner)) bindings.set(local, runner);
    }
  }
  return { bindings, spans };
}

/**
 * Callee labels of every raw capture site in one module: `<runner>` for a
 * capturing call, `<runner> (seam)` for a reference that seeds a runner
 * default. Exempt: calls whose options inherit or ignore stdio, and object
 * keys that merely share the runner's name.
 *
 * @param {string} source
 * @returns {string[]}
 */
function rawCaptureSites(source) {
  const code = stripComments(source);
  const { bindings, spans } = rawRunnerBindings(code);
  const sites = [];
  for (const [local, runner] of bindings) {
    const useRe = new RegExp(`(?<![\\w$.])${local}(?![\\w$])`, 'g');
    for (const use of code.matchAll(useRe)) {
      const at = use.index;
      if (spans.some(([start, end]) => at >= start && at < end)) continue;
      const after = code.slice(at + local.length);
      const before = code.slice(0, at).trimEnd();
      if (/^\s*:/.test(after) && /[{,]$/.test(before)) continue;
      const call = /^\s*\(/.exec(after);
      if (!call) {
        sites.push(`${runner} (seam)`);
        continue;
      }
      const open = at + local.length + call[0].length - 1;
      if (NO_CAPTURE_STDIO_RE.test(callArguments(code, open))) continue;
      sites.push(runner);
    }
  }
  return sites;
}

/**
 * Measure raw capture sites per file (the wrapper excluded) and diff them
 * against the pins. Pure over `read`, so the ratchet is testable on fixtures.
 *
 * @param {string[]} files
 * @param {(file: string) => string} read
 * @param {Record<string, { reason: string, sites: Record<string, number> }>} pins
 * @returns {{ measured: Record<string, Record<string, number>>, total: number,
 *   unlisted: string[], stale: string[] }}
 */
function auditRawCaptureSites(files, read, pins) {
  const measured = {};
  let total = 0;
  for (const file of files) {
    if (file === WRAPPER) continue;
    const sites = rawCaptureSites(read(file));
    if (sites.length === 0) continue;
    measured[file] = {};
    for (const callee of sites) {
      measured[file][callee] = (measured[file][callee] ?? 0) + 1;
    }
    total += sites.length;
  }
  const unlisted = [];
  const stale = [];
  const keys = new Set([...Object.keys(measured), ...Object.keys(pins)]);
  for (const file of [...keys].sort()) {
    const seen = measured[file] ?? {};
    const pinned = pins[file]?.sites ?? {};
    for (const callee of new Set([
      ...Object.keys(seen),
      ...Object.keys(pinned),
    ])) {
      const have = seen[callee] ?? 0;
      const want = pinned[callee] ?? 0;
      if (have > want) unlisted.push(`${file} ${callee} ×${have - want}`);
      if (have < want) stale.push(`${file} ${callee} ×${want - have}`);
    }
  }
  return { measured, total, unlisted, stale };
}

const readSource = (file) =>
  fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

describe('auditChildProcessImports (the ratchet itself)', () => {
  const fixture = {
    'a.js': "import { spawnSync } from 'node:child_process';\n",
    'b.js': "const cp = require('node:child_process');\n",
    'c.js': "const cp = await import('node:child_process');\n",
    'd.js': '// mentions node:child_process in prose only\n',
    'e.js': "import { spawnChild } from './lib/child-exec.js';\n",
  };
  const read = (file) => fixture[file];
  const files = Object.keys(fixture);

  it('flags a NEW importer that is not on the allowlist', () => {
    const { unallowed } = auditChildProcessImports(
      files,
      read,
      new Set(['b.js', 'c.js']),
    );
    assert.deepEqual(
      unallowed,
      ['a.js'],
      'a static import from an unlisted module must fail the ratchet',
    );
  });

  it('passes an importer that IS on the allowlist', () => {
    const { unallowed } = auditChildProcessImports(
      files,
      read,
      new Set(['a.js', 'b.js', 'c.js']),
    );
    assert.deepEqual(unallowed, []);
  });

  it('catches require() and dynamic import(), not prose mentions', () => {
    const { importers } = auditChildProcessImports(files, read, new Set());
    assert.deepEqual(
      importers,
      ['a.js', 'b.js', 'c.js'],
      'the comment-only and wrapper-using modules are not importers',
    );
  });

  it('reports allowlist entries that no longer import as stale', () => {
    const { stale } = auditChildProcessImports(
      files,
      read,
      new Set(['a.js', 'deleted.js']),
    );
    assert.deepEqual(stale, ['deleted.js']);
  });
});

describe('rawCaptureSites (the call-site ratchet itself)', () => {
  const imp =
    "import { spawnSync, execFileSync as efs } from 'node:child_process';\n";

  it('flags a new raw capturing call, through an alias too', () => {
    assert.deepEqual(
      rawCaptureSites(
        `${imp}spawnSync('git', ['log'], { encoding: 'utf8' });\nefs('gh', []);\n`,
      ),
      ['spawnSync', 'execFileSync'],
    );
  });

  it('flags a reference that seeds a runner default as a seam', () => {
    assert.deepEqual(
      rawCaptureSites(`${imp}export function f({ run = spawnSync } = {}) {}\n`),
      ['spawnSync (seam)'],
    );
  });

  it("exempts stdio: 'inherit' / 'ignore' calls, comments and object keys", () => {
    assert.deepEqual(
      rawCaptureSites(
        `${imp}// spawnSync('x') in prose\n` +
          "spawnSync('npm', ['ci'], { stdio: 'inherit' });\n" +
          "efs('git', ['gc'], { cwd, stdio: 'ignore' });\n" +
          'const deps = { spawnSync: fake };\n',
      ),
      [],
    );
  });

  it('sees destructured require() and dynamic import() bindings', () => {
    assert.deepEqual(
      rawCaptureSites(
        "const { spawn } = require('node:child_process');\nspawn('a', []);\n" +
          "const { exec: run } = await import('node:child_process');\nrun('b');\n",
      ),
      ['spawn', 'exec'],
    );
  });

  it('fails a new raw capture site that has no pin (negative fixture)', () => {
    const fixture = {
      'pinned.js': `${imp}spawnSync('git', ['status']);\n`,
      'new.js': `${imp}spawnSync('git', ['log']);\n`,
      'wrapped.js':
        "import { spawnCapture } from './lib/child-exec.js';\nspawnCapture('git', ['log']);\n",
    };
    const pins = { 'pinned.js': { reason: 'r', sites: { spawnSync: 1 } } };
    const { unlisted, stale, total } = auditRawCaptureSites(
      Object.keys(fixture),
      (file) => fixture[file],
      pins,
    );
    assert.deepEqual(unlisted, ['new.js spawnSync ×1']);
    assert.deepEqual(stale, []);
    assert.equal(total, 2);
  });

  it('reports a pin above the measured count as stale, so the pin must shrink', () => {
    const { stale } = auditRawCaptureSites(
      ['a.js'],
      () => `${imp}spawnSync('git', ['status']);\n`,
      {
        'a.js': { reason: 'r', sites: { spawnSync: 2 } },
        'gone.js': { reason: 'r', sites: { spawn: 1 } },
      },
    );
    assert.deepEqual(stale, ['a.js spawnSync ×1', 'gone.js spawn ×1']);
  });
});

describe('raw capture call sites across the shipped tree (Story #5739)', () => {
  const files = listSourceFiles(REPO_ROOT);
  const audit = auditRawCaptureSites(files, readSource, RAW_CAPTURE_SITES);

  it('every raw capture site outside child-exec is pinned', () => {
    assert.deepEqual(
      audit.unlisted,
      [],
      `New raw child-process capture site(s):\n  ${audit.unlisted.join('\n  ')}\n` +
        '→ route the call through .agents/scripts/lib/child-exec.js (spawnCapture /\n' +
        '  spawnChild / execFileCapture, passing a test runner as `run`), or stream with\n' +
        "  stdio: 'inherit'. A raw pipe inherits Node's 1 MiB maxBuffer and dies on ENOBUFS.",
    );
  });

  it('no pin outlives its site — a migrated site lowers its count', () => {
    assert.deepEqual(
      audit.stale,
      [],
      `RAW_CAPTURE_SITES pins above the measured count:\n  ${audit.stale.join('\n  ')}\n` +
        '→ lower or delete those pins so the ratchet tightens.',
    );
  });

  it('every pinned file carries a written reason', () => {
    for (const [file, { reason }] of Object.entries(RAW_CAPTURE_SITES)) {
      assert.ok(
        typeof reason === 'string' && reason.trim().length > 10,
        `${file} needs a reason`,
      );
    }
  });

  it('the pinned site count is strictly below the Story #5756 base', () => {
    const pinnedTotal = Object.values(RAW_CAPTURE_SITES)
      .flatMap(({ sites }) => Object.values(sites))
      .reduce((sum, n) => sum + n, 0);
    assert.equal(audit.total, pinnedTotal);
    assert.ok(
      pinnedTotal < BASE_RAW_CAPTURE_SITE_COUNT,
      `pinned ${pinnedTotal} must be below the base ${BASE_RAW_CAPTURE_SITE_COUNT}`,
    );
  });
});

describe('node:child_process imports across the shipped tree', () => {
  const files = listSourceFiles(REPO_ROOT);

  it('scans a non-trivial set of source files', () => {
    assert.ok(
      files.length > 100,
      `expected the scan to reach the shipped tree, saw ${files.length} files`,
    );
  });

  it('no module outside the allowlist imports node:child_process', () => {
    const { unallowed } = auditChildProcessImports(
      files,
      readSource,
      ALLOWLIST,
    );
    assert.deepEqual(
      unallowed,
      [],
      `New direct node:child_process importer(s):\n  ${unallowed.join('\n  ')}\n` +
        `→ use .agents/scripts/lib/child-exec.js (execFileCapture / spawnChild / spawnCapture),\n` +
        `  which owns the 64 MiB stdout ceiling, shell:false and error normalisation.\n` +
        `  If the wrapper genuinely cannot serve the call (streaming spawn, timeout\n` +
        `  bound, raw error/signal), add the file to ALLOWLIST in this test with a reason.`,
    );
  });

  it('the allowlist carries no stale entries', () => {
    const { stale } = auditChildProcessImports(files, readSource, ALLOWLIST);
    assert.deepEqual(
      stale,
      [],
      `ALLOWLIST entries that no longer import node:child_process:\n  ${stale.join('\n  ')}\n` +
        '→ delete those lines so the ratchet tightens instead of accumulating slack.',
    );
  });

  it('the wrapper is on the allowlist and does import it', () => {
    const { importers } = auditChildProcessImports(
      files,
      readSource,
      ALLOWLIST,
    );
    assert.ok(ALLOWLIST.has(WRAPPER));
    assert.ok(
      importers.includes(WRAPPER),
      'the shared exec surface must be the module that owns the real runners',
    );
  });
});

describe('maxBuffer is defined once (Story #5009 AC-1)', () => {
  const files = listSourceFiles(REPO_ROOT);

  it('exactly one module defines the ceiling constant', () => {
    assert.deepEqual(
      filesMatching(files, readSource, MAX_BUFFER_DEFINITION_RE),
      [WRAPPER],
      'the stdout ceiling has one definition site; every other module gets ' +
        'it by importing child-exec.js (or by letting its default apply)',
    );
  });

  it('no module carries a hand-written numeric maxBuffer literal', () => {
    assert.deepEqual(
      filesMatching(files, readSource, NUMERIC_MAX_BUFFER_RE),
      [],
      'a bare maxBuffer number re-forks the ceiling — pass an imported ' +
        'constant, or omit the option and take the wrapper default',
    );
  });
});
