/**
 * knip-entry-sync.js — derive which top-level `.agents/scripts/*.js` CLIs are
 * actually invoked, and diff that set against the `entry` array of whatever
 * configuration knip itself would load (Story #5039; #5026 could only read a
 * literal `knip.json`).
 *
 * Why this exists (Story #5001 → the #5012 near-miss):
 *
 * #5001 replaced the blanket `.agents/scripts/*.js!` entry glob with an
 * explicit list, precisely so that a top-level CLI **nothing invokes** stops
 * being declared live by the glob and surfaces as dead. It simultaneously
 * promoted knip's `files` rule to `error`, so whole-file death now produces
 * `{ file, symbol: '*' }` baseline rows.
 *
 * That pairing has a silent failure mode. A CLI added *after* #5001 is not in
 * the hand-written list, so knip reads it as unreachable and emits a whole-file
 * row for it — plus transitive rows for every lib module only that CLI imports.
 * During #5012's delivery this produced 5 false rows (`check-baseline-scope.js`,
 * `prune-baseline-orphans.js`, and their three `lib/baselines/*` modules). The
 * natural remedy — accept the ratchet's diff — would have permanently recorded
 * live, working operator CLIs as expected-dead, blinding the ratchet to their
 * real death later. It was caught only because a base-sync conflict forced a
 * manual read of the diff.
 *
 * The fix is to stop depending on a human remembering to edit the config.
 * #5001's own wording already names the derivation rule — entries are derived
 * "from what package.json scripts, husky hooks, .github/workflows, and the
 * .agents workflow/skill markdown actually invoke". This module mechanizes
 * exactly that rule and asserts it in both directions:
 *
 *   missing — invoked by a real caller but absent from `entry`. This is the
 *     #5012 bug: knip will call it dead and the ratchet will offer to record
 *     the lie.
 *   stale — listed in `entry` but invoked by nothing. This is the blind spot
 *     #5001 closed: a declared entry point is immortal, so its death can never
 *     surface.
 *
 * Deliberately NOT a filesystem-derived list. Restoring `.agents/scripts/*.js!`
 * — or regenerating the array from `readdirSync` — would make every file live
 * by construction and undo #5001's AC-2. Liveness here means *invoked*, not
 * *present*.
 *
 * Deliberately NOT conferred by documentation prose. `.agents/docs/**` and
 * `docs/**` describe operator-run commands; a paragraph naming a CLI is not a
 * caller. Three CLIs are named only in prose today
 * (`check-baseline-drift.js`, `post-structured-comment.js`,
 * `provision-git-hooks.js`) and #5001 recorded all of them as whole-file dead
 * rows on purpose. Counting prose would silently resurrect them.
 *
 * A CLI that is only *imported* by another script (`cleanup-repo-test-temp.js`,
 * imported by `run-tests.js` and `run-coverage.js`) is correctly neither: it is
 * reachable through the module graph from a real entry, so knip already sees it
 * and it must not be declared an entry point of its own.
 */

import fs from 'node:fs';
import path from 'node:path';
import { stripJsComments } from '../../.agents/scripts/lib/source-text/strip-js-comments.js';
import {
  resolveKnipEntryPatterns,
  __testing as resolverTesting,
} from './knip-config-resolver.js';

// Only `resolveEntrySync` and `renderEntrySyncReport` are public — they are
// what `check-knip-entries.js` calls. Everything else is module-private and
// reached by the suite through the `__testing` bundle at the foot of this file,
// the same seam `source-classifier.js` and five sibling modules use. Exporting
// the internals individually would put seven test-only symbols on the
// production dead-export baseline and make private helpers look like API.

/** Top-level CLI directory, repo-relative. */
const SCRIPTS_DIR = path.join('.agents', 'scripts');

/**
 * Executable surfaces — a mention of a CLI here is an instruction to run it.
 *
 * `dirs` entries are walked recursively and filtered by `test`. `files` are
 * read directly. Documentation trees are absent by design (see module header).
 *
 * @type {ReadonlyArray<{ kind: 'file' | 'dir', at: string, test?: RegExp }>}
 */
const INVOCATION_SURFACES = Object.freeze([
  { kind: 'file', at: 'package.json' },
  { kind: 'dir', at: '.husky', test: /^(?!.*[/\\]_[/\\]).*$/ },
  { kind: 'dir', at: path.join('.github', 'workflows'), test: /\.ya?ml$/ },
  { kind: 'dir', at: path.join('.agents', 'workflows'), test: /\.md$/ },
  { kind: 'dir', at: path.join('.agents', 'skills'), test: /\.md$/ },
  { kind: 'dir', at: path.join('.agents', 'agents'), test: /\.md$/ },
  { kind: 'dir', at: path.join('.agents', 'rules'), test: /\.md$/ },
  { kind: 'dir', at: SCRIPTS_DIR, test: /\.js$/ },
  // Contributor-only CLIs moved out of the payload (Story #5381) still invoke
  // payload CLIs — `run-lint.js` is what runs `check-gherkin-corpus.js`.
  { kind: 'dir', at: 'scripts', test: /\.js$/ },
]);

/**
 * Blank the specifier of every static `import … from` / `export … from`.
 *
 * An import is not an invocation. Inside `.agents/scripts/` the distinction
 * never mattered — a sibling is imported as `./foo.js`, which no invocation
 * pattern matches — but a contributor CLI under repo-root `scripts/` imports a
 * payload module as `../.agents/scripts/foo.js`, which reads exactly like a
 * path-literal invocation (Story #5381).
 *
 * @param {string} text comment-stripped JavaScript source
 * @returns {string}
 */
function stripStaticImports(text) {
  return text.replace(/\bfrom\s*(['"])[^'"]*\1/g, "from ''");
}

/**
 * Recursively list files under `dir`, skipping `node_modules` and `.git`.
 *
 * @param {string} dir absolute path
 * @param {typeof fs} fsImpl
 * @param {string[]} [acc]
 * @returns {string[]} absolute file paths
 */
function walk(dir, fsImpl, acc = []) {
  let entries;
  try {
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(full, fsImpl, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Read every executable surface under `repoRoot`.
 *
 * `.js` surfaces arrive comment-stripped; every other surface arrives verbatim.
 * Test files are excluded: a test importing or naming a CLI does not make it
 * invoked, which is the same test-only-importer discount `--production` applies
 * to the dead-exports ratchet itself.
 *
 * @param {{ repoRoot: string, fsImpl?: typeof fs }} opts
 * @returns {Array<{ path: string, text: string }>} repo-relative path + content
 */
function collectInvocationSurfaces({ repoRoot, fsImpl = fs }) {
  const surfaces = [];
  const push = (absolute) => {
    const rel = path.relative(repoRoot, absolute);
    if (rel.includes('__tests__') || /\.test\.[cm]?js$/.test(rel)) return;
    let text;
    try {
      text = fsImpl.readFileSync(absolute, 'utf8');
    } catch {
      return;
    }
    surfaces.push({
      path: rel.split(path.sep).join('/'),
      text: rel.endsWith('.js')
        ? stripStaticImports(stripJsComments(text))
        : text,
    });
  };

  for (const surface of INVOCATION_SURFACES) {
    const absolute = path.join(repoRoot, surface.at);
    if (surface.kind === 'file') {
      push(absolute);
      continue;
    }
    for (const file of walk(absolute, fsImpl)) {
      const rel = path.relative(repoRoot, file);
      if (surface.test && !surface.test.test(rel)) continue;
      push(file);
    }
  }
  return surfaces;
}

/**
 * Build the two recognizers for one CLI basename.
 *
 * `pathLiteral` — the CLI named by its repo path (`.agents/scripts/foo.js`),
 *   in either separator style. This is how package.json scripts, husky hooks,
 *   workflow `run:` blocks and workflow markdown spell an invocation.
 *
 * `joinedSpawn` — the CLI named by bare basename as the tail of a
 *   `path.join(…, 'scripts', 'foo.js')` construction, which is how
 *   `lib/bootstrap/project-bootstrap.js` spawns `check-windows-git-perf.js`
 *   into a consumer checkout. Requiring the `'scripts'` sibling argument is
 *   what separates a real spawn from the several *data* inventories that list
 *   the same basenames as plain array elements (`source-classifier.js`'s
 *   `FRAMEWORK_SCRIPT_BASENAMES`, `check-lifecycle-lint.js`'s allowlist) —
 *   those are catalogues of names, not calls.
 *
 * @param {string} cli basename, e.g. `check-dead-exports.js`
 * @returns {{ pathLiteral: RegExp, joinedSpawn: RegExp }}
 */
function buildInvocationPatterns(cli) {
  const escaped = cli.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    pathLiteral: new RegExp(`\\.agents[/\\\\]scripts[/\\\\]${escaped}`),
    joinedSpawn: new RegExp(
      `['"\`]scripts['"\`]\\s*,\\s*['"\`]${escaped}['"\`]`,
    ),
  };
}

/**
 * List the top-level CLI basenames actually present in `.agents/scripts/`.
 *
 * @param {{ repoRoot: string, fsImpl?: typeof fs }} opts
 * @returns {string[]} sorted basenames
 */
function listTopLevelClis({ repoRoot, fsImpl = fs }) {
  let entries;
  try {
    entries = fsImpl.readdirSync(path.join(repoRoot, SCRIPTS_DIR), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => e.name)
    .sort();
}

/**
 * Read the `.agents/scripts/*.js` basenames declared as knip entry points.
 *
 * Resolution goes through knip's own loader — see
 * `knip-config-resolver.js` for why, and for the skipped / error / resolved
 * contract this forwards. All this adds is the projection onto top-level CLI
 * basenames: glob-bearing patterns are dropped, so what remains is the explicit
 * enumeration #5001 made authoritative.
 *
 * The trailing `!` is knip's production-mode marker and is load-bearing, not
 * decoration: in a `--production` run knip keeps only the suffixed entries and
 * *negates* the rest (`WorkspaceWorker`'s `hasProductionSuffix` /
 * `hasNoProductionSuffix` split). So an entry written without it leaves the CLI
 * unreachable in exactly the pass that emits whole-file rows — the #5012 shape
 * this gate exists to catch. Reading it as satisfied would point the operator
 * away from the cause, so unsuffixed entries are reported as their own
 * divergence rather than silently normalized. `createOptions` preserves the
 * suffix, so the marker survives resolution.
 *
 * @param {{ repoRoot: string, loadKnipSession?: () => Promise<object> }} opts
 * @returns {Promise<{
 *   entries: string[],
 *   unsuffixed: string[],
 *   configFilePath: string | null,
 *   skipped: string | null,
 *   error: string | null,
 * }>}
 */
async function readKnipEntries({ repoRoot, loadKnipSession }) {
  const { patterns, configFilePath, skipped, error } =
    await resolveKnipEntryPatterns({ repoRoot, loadKnipSession });
  if (skipped || error) {
    return { entries: [], unsuffixed: [], configFilePath, skipped, error };
  }

  const prefix = '.agents/scripts/';
  const declared = patterns
    .filter((e) => e.startsWith(prefix) && !e.includes('*'))
    .map((e) => ({
      cli: e.slice(prefix.length).replace(/!$/, ''),
      suffixed: e.endsWith('!'),
    }))
    .filter((e) => !e.cli.includes('/'));

  return {
    entries: [...new Set(declared.map((e) => e.cli))].sort(),
    unsuffixed: [
      ...new Set(declared.filter((e) => !e.suffixed).map((e) => e.cli)),
    ].sort(),
    configFilePath,
    skipped: null,
    error: null,
  };
}

/**
 * Resolve the full entry-sync report for a repository.
 *
 * Async because knip's config loader is: a `knip.config.ts` has to be
 * *evaluated*, not read. `EntrySync` names entry-list synchronization, not
 * synchronous I/O, so the name still describes what this returns.
 *
 * @param {{
 *   repoRoot: string,
 *   fsImpl?: typeof fs,
 *   loadKnipSession?: () => Promise<object>,
 * }} opts
 * @returns {Promise<{
 *   error: string | null,
 *   skipped: string | null,
 *   configFilePath: string | null,
 *   clis: string[],
 *   declared: string[],
 *   missing: Array<{ cli: string, invokers: string[] }>,
 *   stale: string[],
 *   phantom: string[],
 *   unsuffixed: string[],
 * }>}
 *   `skipped` — nothing to check; the caller passes rather than failing.
 *   `missing` — invoked but not declared (the #5012 bug).
 *   `stale` — declared but invoked by nothing.
 *   `phantom` — declared but no such file on disk (a rename left the list behind).
 *   `unsuffixed` — declared without the `!` production marker, which knip's
 *     production pass negates rather than honours (the #5012 bug wearing a
 *     declared entry).
 */
export async function resolveEntrySync({
  repoRoot,
  fsImpl = fs,
  loadKnipSession,
}) {
  const {
    entries: declared,
    unsuffixed,
    configFilePath,
    skipped,
    error,
  } = await readKnipEntries({ repoRoot, loadKnipSession });
  const empty = {
    skipped: null,
    configFilePath,
    clis: [],
    declared,
    missing: [],
    stale: [],
    phantom: [],
    unsuffixed: [],
  };
  if (skipped) return { error: null, ...empty, skipped };
  if (error) return { error, ...empty };

  const clis = listTopLevelClis({ repoRoot, fsImpl });
  if (clis.length === 0) {
    return { error: `no CLIs found under ${SCRIPTS_DIR}`, ...empty };
  }
  const surfaces = collectInvocationSurfaces({ repoRoot, fsImpl });
  const declaredSet = new Set(declared);

  const missing = [];
  const stale = [];
  for (const cli of clis) {
    const self = `${SCRIPTS_DIR.split(path.sep).join('/')}/${cli}`;
    const { pathLiteral, joinedSpawn } = buildInvocationPatterns(cli);
    const invokers = surfaces
      .filter(
        (s) =>
          s.path !== self &&
          (pathLiteral.test(s.text) ||
            (s.path.endsWith('.js') && joinedSpawn.test(s.text))),
      )
      .map((s) => s.path);
    const isDeclared = declaredSet.has(cli);
    if (invokers.length > 0 && !isDeclared) missing.push({ cli, invokers });
    if (invokers.length === 0 && isDeclared) stale.push(cli);
  }

  const onDisk = new Set(clis);
  const phantom = declared.filter((cli) => !onDisk.has(cli));

  return {
    error: null,
    skipped: null,
    configFilePath,
    clis,
    declared,
    missing,
    stale,
    phantom,
    unsuffixed,
  };
}

/**
 * Total divergences across every direction. Single source of the gate's
 * pass/fail arithmetic so a newly added direction cannot be counted in the
 * report but missed by the exit code.
 *
 * @param {ReturnType<typeof resolveEntrySync>} report
 * @returns {number}
 */
export function countDivergences(report) {
  return (
    report.missing.length +
    report.stale.length +
    report.phantom.length +
    report.unsuffixed.length
  );
}

/**
 * Render the human-readable report. Each divergence names its own remedy —
 * the whole point of the gate is that the *wrong* remedy (accepting the
 * dead-exports ratchet's diff) is the tempting one.
 *
 * @param {ReturnType<typeof resolveEntrySync>} report
 * @returns {string}
 */
export function renderEntrySyncReport(report) {
  const lines = [];
  for (const { cli, invokers } of report.missing) {
    lines.push(
      `+ ${cli} — invoked by ${invokers.slice(0, 3).join(', ')}${
        invokers.length > 3 ? ` (+${invokers.length - 3} more)` : ''
      }`,
    );
    lines.push(
      `    add ".agents/scripts/${cli}!" to knip.json "entry" — until you do, knip`,
    );
    lines.push(
      '    reads it as unreachable and check-dead-exports will offer a false whole-file row.',
    );
  }
  for (const cli of report.stale) {
    lines.push(
      `- ${cli} — declared in knip.json "entry" but nothing invokes it`,
    );
    lines.push(
      '    remove the entry so its death can surface, or wire up the caller.',
    );
  }
  for (const cli of report.phantom) {
    lines.push(`? ${cli} — declared in knip.json "entry" but not on disk`);
    lines.push('    drop the stale path (the file was renamed or removed).');
  }
  for (const cli of report.unsuffixed) {
    lines.push(`! ${cli} — declared in knip.json "entry" without a "!" suffix`);
    lines.push(
      `    write it as ".agents/scripts/${cli}!" — the production pass negates an`,
    );
    lines.push(
      '    unsuffixed entry, so knip still reads the CLI as unreachable.',
    );
  }
  const total = countDivergences(report);
  lines.push(
    `[knip-entries] clis=${report.clis.length} declared=${report.declared.length} ` +
      `missing=${report.missing.length} stale=${report.stale.length} ` +
      `phantom=${report.phantom.length} unsuffixed=${report.unsuffixed.length} ` +
      `${total > 0 ? '(gate fail)' : '(ok)'}`,
  );
  return lines.join('\n');
}

/**
 * Test-only seam. Not API: these helpers are exercised directly by
 * `tests/check-knip-entries.test.js` so the recognizers can be pinned
 * independently of a full fixture tree.
 */
export const __testing = Object.freeze({
  buildInvocationPatterns,
  // Re-exported from `knip-config-resolver.js` so the suite reaches the whole
  // gate through one seam rather than importing two modules to test one gate.
  collectEntryPatterns: resolverTesting.collectEntryPatterns,
  collectInvocationSurfaces,
  INVOCATION_SURFACES,
  listTopLevelClis,
  readKnipEntries,
  SCRIPTS_DIR,
  stripJsComments,
});
