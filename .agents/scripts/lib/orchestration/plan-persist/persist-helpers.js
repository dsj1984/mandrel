/**
 * persist-helpers.js — pure helper surface for the flat Story `/plan` persist.
 *
 * Exports:
 *   - `resolveBaseBranchRef(config)` — the one place the persist gates learn
 *     which ref to probe.
 *   - `validateTickets(tickets, config)` — runs the cross-link, model-capacity,
 *     freshness, and task-body validators in one pass. Capacity settings are
 *     explicit inputs so the validator and decomposer share one live delivery
 *     envelope instead of silently falling back to framework defaults.
 *   - `makeDefaultFanOutCounter({ baseBranchRef, cwd, git })` — production
 *     fan-out probe used by the conflict policy.
 *
 * @module lib/orchestration/plan-persist/persist-helpers
 */

import posix from 'node:path/posix';
import { resolveListValue } from '../../config/shared.js';
import { gitSpawn } from '../../git-utils.js';
import { validateTaskBodies } from '../task-body-validator.js';
import { validateAndNormalizeTickets } from '../ticket-validator.js';
import { DEFAULT_REGISTRY_PATTERNS } from '../ticket-validator-conflicts.js';

/**
 * Extensions an import specifier may elide. Probed longest-path-first when
 * resolving an extensionless specifier back onto a concrete repo path.
 */
const RESOLVABLE_EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.jsx', '.json'];

/** Every quoted string on a candidate line — the specifier lives in one. */
const QUOTED_RE = /['"]([^'"\n]+)['"]/g;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The specifier tails an importer of `path` could plausibly write as the
 * final segment of its quoted specifier: the basename, the basename minus
 * its extension, and — for a directory-index module — the directory name
 * (`./foo` resolving to `foo/index.js`).
 *
 * This is a *candidate* net only. It is deliberately generous because the
 * resolution pass below re-checks every hit against the real path; a tail
 * that over-matches costs one extra resolve, a tail that under-matches
 * loses a genuine importer.
 */
function specifierTails(path) {
  const base = posix.basename(path);
  const ext = posix.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  const tails = new Set([base, stem]);
  if (stem === 'index') {
    const dir = posix.basename(posix.dirname(path));
    if (dir && dir !== '.') tails.add(dir);
  }
  return [...tails].filter((t) => t.length > 0);
}

/**
 * ERE matching a line that carries an `import` / `export … from` /
 * `require(` / dynamic `import(` whose quoted specifier *ends* at one of
 * `tails`. The `(^|/)`-equivalent guard (`([^'"]*\/)?`) is what keeps
 * `notification.js` from matching `push-notification.js`.
 */
function buildProbePattern(tails) {
  const alt = tails.map(escapeRegExp).join('|');
  return `(from|require|import)[[:space:]]*\\(?[[:space:]]*['"]([^'"]*/)?(${alt})['"]`;
}

/**
 * Resolve a relative specifier written in `importerPath` back onto a repo
 * path and report whether it names `deletedPath`.
 *
 * **Known boundary:** only relative (`./`, `../`) specifiers resolve. A
 * consumer repo that imports its own modules through bare specifiers or a
 * path alias (`#lib/x`, `@app/x`, a `tsconfig` `paths` entry) would
 * under-count, because resolving those needs the resolver config this probe
 * deliberately does not read. Mandrel's own internal imports are all
 * relative. Under-counting is the *quiet* failure direction — it argues for
 * a deletion rather than against one — so if alias-importing consumers
 * appear, this is the place to teach the probe their resolver.
 */
function specifierResolvesTo(importerPath, specifier, deletedPath) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false;
  const resolved = posix.normalize(
    posix.join(posix.dirname(importerPath), specifier),
  );
  for (const ext of RESOLVABLE_EXTENSIONS) {
    if (`${resolved}${ext}` === deletedPath) return true;
    if (ext && `${resolved}/index${ext}` === deletedPath) return true;
  }
  return false;
}

/**
 * Quote one argv entry so the reported probe is **runnable as emitted**.
 *
 * The probe is the operator's route to checking the number, so it has to
 * survive a paste into a shell. Unquoted, the ERE's `(`, `|`, `[[:space:]]`
 * and `?` are glob/grouping metacharacters: zsh fails the paste with
 * `no matches found` *and exits 0*, which reads as "zero importers" — the
 * gate's own audit trail would then argue for the deletion it is meant to
 * question (Story #4547).
 */
function shellQuote(value) {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Parse one `git grep -n` output line of the form `<ref>:<path>:<lineno>:<text>`.
 */
function parseGrepLine(line, baseBranchRef) {
  const prefix = `${baseBranchRef}:`;
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  const pathEnd = rest.indexOf(':');
  if (pathEnd === -1) return null;
  const path = rest.slice(0, pathEnd);
  const afterPath = rest.slice(pathEnd + 1);
  const lineEnd = afterPath.indexOf(':');
  if (lineEnd === -1) return null;
  return { path, text: afterPath.slice(lineEnd + 1) };
}

/**
 * Default fan-out probe — resolves the *importers* of the deleted module at
 * `baseBranchRef`, and reports the referencing files alongside the exact
 * probe that produced them.
 *
 * Two-stage, because accuracy and cost pull in opposite directions:
 *
 *   1. `git grep -n -E` narrows the tree to lines whose quoted import /
 *      require specifier could name the module (final-segment match).
 *   2. Each candidate specifier is resolved against its own importer's
 *      directory and compared to the deleted path. Only a real resolution
 *      counts.
 *
 * The predecessor (Story #2962) grepped the basename stem as a bare word
 * across the whole tree, so a module named `notification` or `options`
 * reported dozens of call sites drawn from prose, schemas, and unrelated
 * modules — and the gate that fired on that number told the operator to
 * split a migration that did not exist. It also returned 0 without probing
 * for any stem under three characters, under-reporting in silence. Both are
 * gone: coupling is measured by resolution, not vocabulary (Story #4547).
 *
 * @returns {(arg: { path: string }) => { count: number, files: string[], probe: string }}
 */
export function makeDefaultFanOutCounter({ baseBranchRef, cwd, git } = {}) {
  const spawn = git?.gitSpawn ?? gitSpawn;
  return ({ path }) => {
    const tails = specifierTails(path);
    const pattern = buildProbePattern(tails);
    const args = ['grep', '-n', '-E', '--full-name', pattern, baseBranchRef];
    const probe = `git ${args.map(shellQuote).join(' ')}`;
    const result = spawn(cwd ?? process.cwd(), ...args);
    // git grep exits 1 on "no matches" — an empty result, not a failure.
    if (result.status !== 0) return { count: 0, files: [], probe };
    const files = new Set();
    for (const line of result.stdout.split('\n')) {
      if (line.trim().length === 0) continue;
      const hit = parseGrepLine(line, baseBranchRef);
      // The deleted module's own self-references are not call sites.
      if (!hit || hit.path === path) continue;
      for (const match of hit.text.matchAll(QUOTED_RE)) {
        if (specifierResolvesTo(hit.path, match[1], path)) {
          files.add(hit.path);
          break;
        }
      }
    }
    const sorted = [...files].sort();
    return { count: sorted.length, files: sorted, probe };
  };
}

/**
 * Resolve the cross-Story conflict-finding policy from `_config.planning`.
 */
function resolveConflictPolicy(cfg) {
  const planning = cfg?.planning;
  const policy = {
    failOnSharedEditors: planning?.failOnSharedEditors === true,
    requireExplicitCrossStoryDeps:
      planning?.requireExplicitCrossStoryDeps === true,
    failOnRegistryConflicts: planning?.failOnRegistryConflicts === true,
    failOnLargeFanOut: planning?.failOnLargeFanOut === true,
  };
  if (Number.isFinite(planning?.largeFanOutThreshold)) {
    policy.largeFanOutThreshold = planning.largeFanOutThreshold;
  }
  if (planning?.crossCuttingRegistries !== undefined) {
    policy.registries = resolveListValue(
      DEFAULT_REGISTRY_PATTERNS,
      planning.crossCuttingRegistries,
    );
  }
  return policy;
}

/**
 * Resolve the ref the persist gates probe against.
 *
 * The canonical resolved config carries the base branch at
 * `project.baseBranch` (`lib/config-resolver.js` defaults it to `main`).
 * This helper used to read `config.baseBranch` — a key the resolver never
 * produces — so every freshness / file-assumption / fan-out probe silently
 * targeted the literal `main` regardless of configuration. Benign in a repo
 * whose base branch *is* `main`; wrong for any consumer that configured
 * something else (Story #4541).
 *
 * The flat `config.baseBranch` fallback is retained for the legacy
 * `settings`-bag callers that pass `{ baseBranch, paths, planning }`.
 *
 * @param {object} [config] Resolved config, or a legacy settings bag.
 * @returns {string}
 */
export function resolveBaseBranchRef(config) {
  return config?.project?.baseBranch ?? config?.baseBranch ?? 'main';
}

export function validateTickets(tickets, config, opts = {}) {
  const baseBranchRef = resolveBaseBranchRef(config);
  const conflictPolicy = resolveConflictPolicy(config);
  if (typeof opts.fanOutCounter === 'function') {
    conflictPolicy.fanOutCounter = opts.fanOutCounter;
  } else {
    conflictPolicy.fanOutCounter = makeDefaultFanOutCounter({
      baseBranchRef,
      cwd: opts.cwd,
    });
  }
  const validated = validateAndNormalizeTickets(tickets, {
    baseBranchRef,
    conflictPolicy,
    modelCapacity: opts.modelCapacity,
    // Thread the repo cwd into the AC-freshness / file-assumption git
    // probes (#4474 PR7) — without it they silently ran against
    // process.cwd(), which is only the repo root by coincidence.
    cwd: opts.cwd,
  });
  validateTaskBodies(validated);
  return validated;
}
