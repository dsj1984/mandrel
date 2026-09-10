/**
 * tests/enforcement/workflow-script-help.test.js
 *
 * Story #4750 — every orchestration script a workflow tells an agent to run
 * must be self-describing.
 *
 * ## The rule
 *
 * For each `.agents/scripts/*.js` path referenced by any file under
 * `.agents/workflows/`, `node <script> --help` must:
 *
 *   1. exit 0 — `--help` is a query, never an error path; and
 *   2. write non-empty text to **stdout** (not stderr, and not swallowed by
 *      `AGENT_LOG_LEVEL=silent`).
 *
 * ## Why the set is derived, not listed
 *
 * A hard-coded adoption list is a second place to remember, which is the exact
 * failure this Story exists to remove: the flag contract used to live in the
 * workflow prose that invoked the script, and drifted from the script. Grepping
 * the workflows means a newly-invoked script fails this test until it answers
 * `--help` — the guard grows with the corpus instead of rotting next to it.
 *
 * ## Why the side-effect half is structural, not asserted here
 *
 * "`--help` performs no GitHub write, acquires no lease, and mutates no
 * working tree" is enforced by construction: `runAsCli` (`lib/cli-utils.js`)
 * answers help **before** invoking `main`, so no script body runs at all. The
 * `respondToHelp`-before-`main` ordering is unit-tested in
 * `tests/lib/cli-usage.test.js`; here we assert the observable half plus the
 * one thing a subprocess can see cheaply — that the run left the working tree
 * clean.
 *
 * ## Why the dirty-tree probe settles, and asks a subset question
 *
 * `git status --porcelain` measures the whole checkout, but the claim being
 * made is about ~40 child processes that have all exited. `node --test` runs
 * test files concurrently against that one checkout, so a sibling file that
 * writes a tracked path — even for a few hundred milliseconds — lands in this
 * reading and gets reported as a `--help` write. That is not hypothetical:
 * CI run 34523840460 (Windows Smoke) red-lit here naming
 * `.agents/workflows/mandrel-deliver.md`, which no script writes at all. The
 * real author was `tests/generate-workflows-doc.test.js`, which proved the
 * doc drift gate by editing that file in place and restoring it. That test
 * now runs against a `--root` fixture, but the hazard is structural, so the
 * probe no longer takes a single reading on trust:
 *
 *   - it **settles** — a difference is re-read until it stops changing (or a
 *     small budget expires) before it is believed. A transient third-party
 *     write reverts; a `--help` write cannot, because every child has exited
 *     by the time this runs, so nothing is left to undo it. Settling
 *     therefore removes false reports without weakening the real one; and
 *   - it asks a **subset** question — "is any path dirty now that was not
 *     dirty before?" A path that was dirty at module load and is clean now
 *     was never a `--help` write, and demanding set equality made that
 *     direction fail too.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertDocMentions,
  assertDocOmits,
  readDoc,
} from '../helpers/doc-assert.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.agents', 'workflows');
const SCRIPTS_DIR = path.join(REPO_ROOT, '.agents', 'scripts');

/** Matches `.agents/scripts/<name>.js` — top-level CLIs only, not `lib/`. */
const SCRIPT_REF_RE = /\.agents\/scripts\/([A-Za-z0-9_-]+)\.js/g;

function listMarkdown(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listMarkdown(full, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * The adoption set: every top-level script named by a workflow document and
 * present on disk. Sorted so failures read in a stable order.
 *
 * @returns {string[]} Script basenames, e.g. `single-story-init.js`.
 */
export function deriveWorkflowInvokedScripts() {
  const names = new Set();
  for (const doc of listMarkdown(WORKFLOWS_DIR)) {
    const source = fs.readFileSync(doc, 'utf8');
    for (const match of source.matchAll(SCRIPT_REF_RE)) {
      const file = `${match[1]}.js`;
      if (fs.existsSync(path.join(SCRIPTS_DIR, file))) names.add(file);
    }
  }
  return [...names].sort();
}

const ADOPTION_SET = deriveWorkflowInvokedScripts();

/** `git status --porcelain`, as a set of path entries. */
function worktreeStatus() {
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(status.status, 0, 'git status failed');
  return (status.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes(' temp/'))
    .sort();
}

// Captured at module load — i.e. before any `--help` subprocess runs — so the
// comparison at the end measures what the help runs did, not how dirty the
// checkout happened to be when the suite started.
const STATUS_BEFORE = worktreeStatus();

/**
 * How long a difference is given to clear before it is believed.
 *
 * Paid only when something *is* dirty, so a green run never waits. Waiting
 * for the difference to *clear* is the whole point — a reading that merely
 * looks stable proves nothing, because a sibling test file holding a file
 * dirty for a second looks perfectly stable at this sampling rate.
 */
const SETTLE_BUDGET_MS = 10_000;
const SETTLE_STEP_MS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Entries dirty now that were not dirty at module load, re-read until they
 * clear or the settle budget expires.
 *
 * @param {string[]} before Reading taken before the help runs.
 * @returns {Promise<string[]>}
 */
async function settledNewlyDirty(before) {
  const baseline = new Set(before);
  const newlyDirty = () => worktreeStatus().filter((e) => !baseline.has(e));
  let current = newlyDirty();
  const deadline = Date.now() + SETTLE_BUDGET_MS;
  while (current.length > 0 && Date.now() < deadline) {
    await sleep(SETTLE_STEP_MS);
    current = newlyDirty();
  }
  return current;
}

describe('workflow-invoked scripts are self-describing', () => {
  it('derives a non-empty adoption set from the workflow corpus', () => {
    assert.ok(
      ADOPTION_SET.length > 0,
      'no .agents/scripts/*.js references found under .agents/workflows/ — the ' +
        'grep that derives this guard has stopped matching',
    );
    // Spot-check the derivation rather than pinning a count: a Story that adds
    // or retires a workflow invocation must not have to edit this test.
    assert.ok(
      ADOPTION_SET.includes('single-story-init.js'),
      'expected the deliver path to still invoke single-story-init.js',
    );
  });

  for (const script of ADOPTION_SET) {
    it(`${script} answers --help on stdout with exit 0`, () => {
      const result = spawnSync(
        process.execPath,
        [path.join(SCRIPTS_DIR, script), '--help'],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: 60_000,
          // `silent` proves help does not ride on Logger.info: a script that
          // routes its usage block through the logger prints nothing here.
          env: { ...process.env, AGENT_LOG_LEVEL: 'silent' },
        },
      );

      assert.equal(
        result.status,
        0,
        `${script} --help exited ${result.status} (signal ${result.signal}).\n` +
          `stderr: ${(result.stderr ?? '').slice(0, 800)}`,
      );
      assert.ok(
        (result.stdout ?? '').trim().length > 0,
        `${script} --help wrote nothing to stdout. A workflow-invoked script ` +
          'must document its own flags — add a `usage:` spec to its runAsCli ' +
          'call (see .agents/scripts/lib/cli-usage.js).',
      );
    });
  }

  it('does not re-inline a flag enumeration the script now owns', () => {
    // Story #4750 deleted these three; each is a verbatim restatement of a
    // flag surface `--help` prints, and each is the shape most likely to be
    // pasted back in by a well-meaning edit. Wrap-independent by construction
    // (`assertDocOmits` normalizes) so a re-flow cannot hide a regression.
    const deliverStory = readDoc(
      path.join(WORKFLOWS_DIR, 'helpers', 'deliver-story.md'),
    );
    assertDocOmits(
      deliverStory,
      /Flags: `--dry-run`/,
      'single-story-init.js documents --dry-run / --steal itself — deliver-story.md must not restate them',
    );
    assertDocMentions(
      deliverStory,
      /documents its own flags — run it with `--help`/,
      "deliver-story.md must point the reader at each script's own --help",
    );

    const plan = readDoc(path.join(WORKFLOWS_DIR, 'mandrel-plan.md'));
    for (const flag of [
      '--chain-on-clean',
      '--no-close-superseded',
      '--route-downgrade-reason',
      '--allow-over-budget',
    ]) {
      assertDocOmits(
        plan,
        new RegExp(`\\| \`${flag}`),
        `plan.md's flag table must not restate plan-persist.js's ${flag} — the CLI documents it`,
      );
    }

    const gitCleanup = readDoc(path.join(WORKFLOWS_DIR, 'git-cleanup.md'));
    assertDocMentions(
      gitCleanup,
      /git-cleanup\.js --help/,
      'git-cleanup.md must point at the script for its flag list',
    );
  });

  it('leaves the working tree exactly as it found it', async () => {
    assert.deepEqual(
      await settledNewlyDirty(STATUS_BEFORE),
      [],
      '`--help` mutated the working tree, and the change was still there ' +
        `after settling for ${SETTLE_BUDGET_MS}ms. A help branch must ` +
        'short-circuit before any write — check that the script routes help ' +
        "through runAsCli's `usage` option rather than a check inside " +
        'main(). If the path named above belongs to no script here, the ' +
        'other suspect is a concurrently-running test file writing a tracked ' +
        'path in this shared checkout; such a test belongs on a tmpdir ' +
        'fixture (see tests/generate-workflows-doc.test.js).',
    );
  });
});

/**
 * Story #4872 — the baseline updaters performed a real baseline write when
 * asked for their usage. They are named explicitly here (rather than left to
 * the derived adoption set above) because for a CLI whose whole job is to
 * mutate, "a usage probe leaves the artifact byte-identical" is the
 * load-bearing half of the contract, not an incidental one — and the derived
 * set only covers them for as long as some workflow happens to cite them.
 */
const MUTATING_UPDATERS = [
  'update-coverage-baseline.js',
  'update-crap-baseline.js',
  'update-duplication-baseline.js',
  'update-maintainability-baseline.js',
];

/** `{ relPath: sha-ish content }` for every committed baseline file. */
function snapshotBaselines() {
  const dir = path.join(REPO_ROOT, 'baselines');
  const snapshot = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    snapshot[entry.name] = fs.readFileSync(path.join(dir, entry.name));
  }
  return snapshot;
}

describe('baseline updaters answer --help without writing a baseline', () => {
  for (const script of MUTATING_UPDATERS) {
    it(`${script} --help prints usage, exits 0, and mutates no baseline`, () => {
      const before = snapshotBaselines();
      const result = spawnSync(
        process.execPath,
        [path.join(SCRIPTS_DIR, script), '--help'],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: 120_000,
          env: { ...process.env, AGENT_LOG_LEVEL: 'silent' },
        },
      );

      assert.equal(
        result.status,
        0,
        `${script} --help exited ${result.status}.\nstderr: ${(result.stderr ?? '').slice(0, 800)}`,
      );
      assert.ok(
        (result.stdout ?? '').trim().length > 0,
        `${script} --help wrote nothing to stdout`,
      );

      const after = snapshotBaselines();
      assert.deepEqual(
        Object.keys(after).sort(),
        Object.keys(before).sort(),
        `${script} --help added or removed a baseline file`,
      );
      for (const [name, bytes] of Object.entries(before)) {
        assert.ok(
          bytes.equals(after[name]),
          `${script} --help rewrote baselines/${name} — a usage probe must not mutate the artifact it describes`,
        );
      }
    });
  }
});

/**
 * Story #5101 — the descriptor must be TRUTHFUL, not merely present.
 *
 * The suite above proves a script *answers* `--help`. It never proved the
 * answer was true, and that hole shipped an inert flag:
 * `drain-pending-cleanup.js` advertised `--no-escalate` ("Do not escalate to a
 * forced removal") while `node:util.parseArgs` silently ignored it, so the
 * documented passive drain force-terminated the processes holding a worktree's
 * handles — the exact act the flag promises to suppress.
 *
 * ## The invariant
 *
 * `parseArgs` has NO native `--no-<flag>` negation. A `--no-<x>` flag is
 * honoured only if its parser either declares the literal `'no-<x>'` key
 * (reading `values['no-<x>']` itself) or passes `allowNegative: true`. A
 * descriptor row with neither is advertised and inert.
 *
 * ## Why this arm needs no exemption list
 *
 * The check is exact rather than heuristic: it asks a yes/no question about
 * the parser, not "does this flag look read somewhere". Over the corpus as of
 * this Story it yields ten passes and one failure, and the failure was the
 * real defect. A general "every advertised flag has a read" arm was
 * considered and deliberately dropped — being regex-based it needs a
 * maintained allowlist plus special cases for template-literal dynamic
 * imports and camelCase renames, and that allowlist is itself the drift
 * surface this file exists to remove.
 *
 * ## Why the flag list comes from `--help` and not from the source
 *
 * `--help` stdout is what an operator actually sees, and `runAsCli` answers it
 * before `main`, so reading it is side-effect-free by construction. Regexing
 * the `usage:` descriptor instead would let the guard and the operator
 * disagree — a second home for the contract, which is the drift class Story
 * #4750 removed.
 */

/** Every top-level CLI that declares a usage descriptor. */
function scriptsWithUsageDescriptor() {
  return fs
    .readdirSync(SCRIPTS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => e.name)
    .filter((name) => {
      const src = fs.readFileSync(path.join(SCRIPTS_DIR, name), 'utf8');
      // Cheap pre-filter: a script advertising `--no-x` must contain that
      // literal somewhere. It can only shrink the spawn set, never hide an
      // advertised negation flag — the authoritative list is still `--help`.
      return /\busage:\s*[{A-Z]/.test(src) && /--no-[a-z]/.test(src);
    })
    .sort();
}

/**
 * Strip block and line comments.
 *
 * Load-bearing, not tidiness. The very comment explaining why a parser passes
 * `allowNegative` contains the token `allowNegative`, so an un-stripped scan
 * accepts prose as proof: deleting the real option leaves the explanation
 * behind and the arm still passes. The mutation check in this suite is what
 * surfaced that — the guard has to read code, not documentation.
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

/** Static + template-literal local import specifiers in one source file. */
const LOCAL_IMPORT_RE =
  /(?:import|export)[\s\S]{0,600}?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|import\(\s*`(\.[^`$]+\.js)/g;

/**
 * Every local module reachable from `entry`. The template-literal form is
 * load-bearing: `single-story-close.js` reaches the runner that owns its argv
 * handling via ``import(`./lib/.../runner.js${search}`)``, so a static-only
 * resolver would miss the parser and red a flag that is honoured.
 *
 * @param {string} entry Absolute path to the CLI's entry file.
 * @returns {string[]} Absolute paths, entry included.
 */
function localModuleGraph(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file) || !file.endsWith('.js') || !fs.existsSync(file)) {
      continue;
    }
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const match of src.matchAll(LOCAL_IMPORT_RE)) {
      const spec = match[1] || match[2] || match[3];
      if (!spec) continue;
      let resolved = path.resolve(path.dirname(file), spec);
      if (!resolved.endsWith('.js')) resolved += '.js';
      if (resolved.includes('__tests__')) continue;
      stack.push(resolved);
    }
  }
  return [...seen];
}

/** The `--no-*` rows a script's own `--help` advertises. */
function advertisedNegationFlags(script) {
  const result = spawnSync(
    process.execPath,
    [path.join(SCRIPTS_DIR, script), '--help'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, AGENT_LOG_LEVEL: 'silent' },
    },
  );
  assert.equal(
    result.status,
    0,
    `${script} --help exited ${result.status}.\nstderr: ${(result.stderr ?? '').slice(0, 800)}`,
  );
  const flags = new Set();
  for (const line of (result.stdout ?? '').split('\n')) {
    const match = /^\s+(--no-[a-z0-9][a-z0-9-]*)/.exec(line);
    if (match) flags.add(match[1]);
  }
  return [...flags];
}

describe('advertised --no-* flags are honoured by their parser', () => {
  const scripts = scriptsWithUsageDescriptor();

  it('finds negation flags to check', () => {
    assert.ok(
      scripts.length > 0,
      'no descriptor-carrying script advertises a --no-* flag — the ' +
        'derivation that feeds this guard has stopped matching',
    );
  });

  for (const script of scripts) {
    it(`${script}: every --no-* flag has a parser that honours it`, () => {
      const flags = advertisedNegationFlags(script);
      if (flags.length === 0) return;
      const source = localModuleGraph(path.join(SCRIPTS_DIR, script))
        .map((file) => stripComments(fs.readFileSync(file, 'utf8')))
        .join('\n');
      const allowsNegative = /\ballowNegative\b/.test(source);
      for (const flag of flags) {
        const key = flag.slice(2); // `--no-escalate` -> `no-escalate`
        const declaresKey = new RegExp(`['"\`]${key}['"\`]`).test(source);
        assert.ok(
          declaresKey || allowsNegative,
          `${script} advertises ${flag} but no parser honours it. ` +
            'node:util.parseArgs has no native --no-<flag> negation: declare ' +
            `the literal '${key}' option key and read values['${key}'], or ` +
            'pass `allowNegative: true`. Otherwise the flag parses into a ' +
            'key nothing reads and the command proceeds as if it were absent.',
        );
      }
    });
  }
});
