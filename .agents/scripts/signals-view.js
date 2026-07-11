#!/usr/bin/env node

/**
 * signals-view.js — `/signals` viewer CLI (Epic #1181 / Story #1440 /
 * Task #1463).
 *
 * Reads signals via `lib/signals/read`, materialises a span-tree via
 * `lib/signals/buildSpanTree`, and prints a readable Epic → Story → Task →
 * events tree to stdout. The output is **plain text via
 * `process.stdout.write`** — no Ink, no blessed, no terminal-control
 * escape sequences — so it works on Windows + bash hosts (see
 * `parallel-tooling.md`). The Task ticket's "console.log only" rule
 * specified the absence of TUI libraries; we route through
 * `process.stdout.write` to comply with the framework-wide
 * `tests/enforcement/no-console.test.js` allowlist (machine-parsable
 * stdout uses `process.stdout.write`, not the console).
 *
 * Usage:
 *   node .agents/scripts/signals-view.js <epic-id> [--story <id>]
 *
 * Args:
 *   <epic-id>            Positive integer Epic ID. Required.
 *   --story <id>         Optional positive integer Story ID. When set,
 *                        narrows the printed tree to a single Story
 *                        subtree.
 *
 * Exit codes:
 *   0  — happy path, OR missing signals file (friendly message printed,
 *        no stack trace).
 *   1  — bad arguments (non-integer epic, missing positional, etc.).
 *
 * Tempfile contract:
 *   The viewer resolves the on-disk signals path via the configured
 *   `project.paths.tempRoot`. The `phase_timings_uses_project_root`
 *   memory captures the failure mode this guards against — earlier
 *   post-merge work leaked to the real repo root regardless of test
 *   sandbox `tempRoot`. The `--temp-root` flag is the test hook;
 *   production callers leave it unset and pick up the resolved config.
 *
 * @module signals-view
 */

import { parseStandardCliArgs } from './lib/cli/standard-args.js';
import { runAsCli } from './lib/cli-utils.js';
import * as signals from './lib/signals/index.js';

/**
 * Single sink for every line the viewer emits. Centralised so the
 * enforcement test (`tests/enforcement/no-console.test.js`) sees one
 * audit point and the unit tests patch one seam, not eleven.
 *
 * @param {string} line
 * @returns {void}
 */
function println(line) {
  process.stdout.write(`${line}\n`);
}

const USAGE =
  'Usage: node .agents/scripts/signals-view.js <epic-id> [--story <id>] [--temp-root <path>]';

/**
 * Parse a token as a strict positive integer (no leading +, no float, no
 * trailing junk). Returns `null` on any non-conforming input.
 *
 * @param {unknown} tok
 * @returns {number|null}
 */
function parseStrictPositiveInt(tok) {
  if (typeof tok !== 'string') return null;
  const n = Number.parseInt(tok, 10);
  if (!Number.isInteger(n) || n <= 0) return null;
  if (String(n) !== tok.trim()) return null;
  return n;
}

function err(error) {
  return { ok: false, error };
}

const HELP_FLAGS = new Set(['--help', '-h']);

/**
 * Parse argv slice (the array passed to `main` excludes node + script).
 * Returns a `{ ok, ... }` envelope rather than throwing so `main` can
 * print a friendly message and exit 1 without a stack trace.
 *
 * Delegates the flag walking to `parseStandardCliArgs` and post-validates
 * the diagnose-specific invariants (single positional epic-id, strictly
 * positive integers for both ids).
 *
 * @param {string[]} argv
 * @returns {{ ok: true, epic: number, story: number | null, tempRoot: string | null } | { ok: false, error: string }}
 */
export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return err(`missing <epic-id>. ${USAGE}`);
  }
  if (argv.some((t) => HELP_FLAGS.has(t))) return err(USAGE);

  let parsed;
  try {
    parsed = parseStandardCliArgs({
      argv,
      extras: {
        'temp-root': { type: 'string', alias: 'tempRoot' },
      },
    });
  } catch (e) {
    if (e && e.code === 'UNKNOWN_FLAG') {
      return err(`unexpected token "--${e.flag}". ${USAGE}`);
    }
    return err(`${e.message}. ${USAGE}`);
  }

  const { values, positionals } = parsed;

  // Exactly one positional, which must be a strictly positive integer
  // (no leading `+`, no float, no trailing junk).
  if (positionals.length === 0) {
    return err(`missing <epic-id>. ${USAGE}`);
  }
  if (positionals.length > 1) {
    return err(`unexpected token ${JSON.stringify(positionals[1])}. ${USAGE}`);
  }
  const epic = parseStrictPositiveInt(positionals[0]);
  if (epic == null) {
    return err(
      `<epic-id> must be a positive integer; got ${JSON.stringify(positionals[0])}. ${USAGE}`,
    );
  }

  // `--story` is the standard ticket flag; the shared parser already ran
  // `parseTicketId` on it, but we need to reject "supplied-but-invalid"
  // (token present, value null) — `parseStandardCliArgs` silently coerces
  // an unparseable value to null, which would otherwise look the same as
  // the "absent" case.
  const storyTokenIdx = argv.indexOf('--story');
  if (storyTokenIdx !== -1 && values.storyId == null) {
    const rawNext = argv[storyTokenIdx + 1];
    const target = rawNext === undefined ? 'a value' : JSON.stringify(rawNext);
    return err(`--story expects a positive integer; got ${target}. ${USAGE}`);
  }

  return {
    ok: true,
    epic,
    story: values.storyId,
    tempRoot: values.tempRoot,
  };
}

function formatDuration(ms) {
  if (ms == null) return '(no end)';
  if (!Number.isFinite(ms)) return '(no end)';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = ((ms % 60_000) / 1000).toFixed(1);
  return `${mins}m${secs}s`;
}

function describeEvent(evt) {
  const ts = evt?.ts ?? '(no ts)';
  const kind = evt?.kind ?? '(no kind)';
  const phase = evt?.phase ? ` phase=${evt.phase}` : '';
  const category = evt?.category ? ` category=${evt.category}` : '';
  return `[${ts}] ${kind}${phase}${category}`;
}

/**
 * Render the span-tree to stdout. Pure formatter — every output line
 * goes through the local `println` helper (which delegates to
 * `process.stdout.write`). Logger is intentionally not used: the
 * viewer's contract is "dumb terminal compatible, parseable output".
 *
 * @param {{ epic: number | null, stories: Array<object> }} tree
 * @param {{ storyFilter?: number | null }} [opts]
 * @returns {void}
 */
export function renderTree(tree, opts = {}) {
  const filter = opts.storyFilter ?? null;
  println(`Epic #${tree.epic ?? '?'}`);
  const stories =
    filter == null ? tree.stories : tree.stories.filter((s) => s.id === filter);

  if (stories.length === 0) {
    println('  (no story spans)');
    return;
  }

  for (const story of stories) {
    const label = story.id == null ? '(no story id)' : `#${story.id}`;
    println(
      `  Story ${label}  ${formatDuration(story.durationMs)}  ` +
        `[${story.startedAt ?? '?'} → ${story.endedAt ?? '?'}]`,
    );
    if (story.events.length > 0) {
      println(
        `    (${story.events.length} story-level event${story.events.length === 1 ? '' : 's'})`,
      );
      for (const evt of story.events) {
        println(`      ${describeEvent(evt)}`);
      }
    }
  }
}

function buildConfig(tempRoot) {
  if (tempRoot == null) return undefined;
  return { project: { paths: { tempRoot } } };
}

/**
 * CLI entry point. Returns the process exit code rather than calling
 * `process.exit` directly so the unit tests can drive it as a pure
 * function.
 *
 * @param {string[]} argv — argv slice (no node, no script)
 * @param {{ read?: Function, buildSpanTree?: Function }} [deps] — test seam
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    println(parsed.error);
    return 1;
  }
  const { epic, story, tempRoot } = parsed;
  const read = deps.read ?? signals.read;
  const buildSpanTree = deps.buildSpanTree ?? signals.buildSpanTree;
  const config = buildConfig(tempRoot);

  const iter = read(story != null ? { epic, story, config } : { epic, config });

  // Eagerly collect to detect the missing-file case before we start
  // printing — when the iterator yields nothing we want a friendly
  // message, not an empty tree.
  let tree;
  try {
    tree = await buildSpanTree(iter);
  } catch (err) {
    println(
      `signals: failed to read signals for Epic #${epic}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }

  if (tree.stories.length === 0) {
    const scope = story != null ? ` (Story #${story})` : '';
    println(`No signals found for Epic #${epic}${scope}.`);
    return 0;
  }

  // The reader fans out across every Story file under the Epic when
  // `story` is omitted. If the requested Story filter doesn't match any
  // observed Story id, treat that as the missing-file case too.
  if (story != null && !tree.stories.some((s) => s.id === story)) {
    println(`No signals found for Epic #${epic} (Story #${story}).`);
    return 0;
  }

  // Pin the Epic id on the tree to the requested one — `buildSpanTree`
  // pins it from the first observed event, which is normally the same,
  // but if every event lacks an `epic` field the tree's `epic` would be
  // `null` while we still know what was requested.
  if (tree.epic == null) tree = { ...tree, epic };

  renderTree(tree, { storyFilter: story });
  return 0;
}

// Direct-CLI guard: when this module is executed (not imported by a
// test), drive `main(process.argv.slice(2))` through the framework's
// `runAsCli` helper. The helper enforces the canonical main-guard
// shape (the enforcement test in `tests/enforcement/cli-wrapper.test.js`
// fails any top-level script that bypasses it) and centralises the
// fatal-error path.
runAsCli(
  import.meta.url,
  async () => {
    const code = await main(process.argv.slice(2));
    if (code !== 0) process.exit(code);
  },
  {
    source: 'signals-view',
    onError(err) {
      println(`signals-view: unexpected error: ${err?.message ?? err}`);
      process.exit(1);
    },
  },
);
