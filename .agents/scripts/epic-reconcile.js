#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-reconcile.js — CLI surface for the structural epic-spec reconciler.
 *
 * Story #1496 (Epic #1182 / Tech Spec #1483). Thin wrapper that
 * composes the existing reconciler modules into the operator-facing
 * surface specified in the Tech Spec:
 *
 *   node .agents/scripts/epic-reconcile.js <epicId>
 *     [--dry-run] (default)
 *     [--apply]
 *     [--explicit-delete]
 *     [--yes]
 *
 * Control flow (Tech Spec §"Reconciler control flow"):
 *
 *   1. Load `.agents/epics/<id>.yaml` via `lib/spec/loader.js`. Validation
 *      failure exits 1 with the failing JSON Pointer.
 *   2. Load `.agents/epics/<id>.state.json` (absent → empty mapping).
 *   3. Fetch the live GH state via the configured `ITicketingProvider`.
 *   4. Compute the plan via `epic-spec-reconciler-diff.js#diff`.
 *   5. Render the plan via `epic-spec-reconciler-format.js#formatPlan`.
 *   6. On `--dry-run` (default) — print and exit 0.
 *      On `--apply`:
 *        - When the plan carries close ops without `--explicit-delete`,
 *          exit 2.
 *        - When the plan is non-empty, in a TTY, prompt unless `--yes`.
 *          Non-TTY without `--yes` aborts (exit 1).
 *        - Invoke `apply()` with the appropriate gate flags.
 *
 * Exit codes (Story #1496 / Task #1521):
 *   - 0  No diff or successful apply.
 *   - 1  Validation error (`SpecValidationError`, `SpecParseError`,
 *        `SpecNotFoundError`), or a non-TTY `--apply` without `--yes`,
 *        or an apply-phase provider failure.
 *   - 2  Close operation requires `--explicit-delete` but the flag was
 *        absent.
 *
 * The CLI is intentionally thin: every behaviour that matters for
 * downstream automation is rooted in the underlying modules. This file
 * adds three things on top: argument parsing, the confirmation gate,
 * and the exit-code contract.
 */

import readline from 'node:readline';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  ApplyGateViolation,
  apply,
} from './lib/orchestration/epic-spec-reconciler-apply.js';
import { diff } from './lib/orchestration/epic-spec-reconciler-diff.js';
import { formatPlan } from './lib/orchestration/epic-spec-reconciler-format.js';
import { isEmptyPlan } from './lib/orchestration/epic-spec-reconciler-ops.js';
import { createProvider } from './lib/provider-factory.js';
import {
  loadSpec,
  loadState,
  SpecNotFoundError,
  SpecParseError,
  SpecValidationError,
} from './lib/spec/index.js';

/**
 * Exit-code contract (see header). Exported for tests so they can assert
 * the constants without re-deriving the integers from prose.
 */
export const EXIT_CODES = Object.freeze({
  OK: 0,
  VALIDATION_ERROR: 1,
  EXPLICIT_DELETE_REQUIRED: 2,
});

/**
 * Default writer for log/output streams. Tests inject sinks so they can
 * inspect what the CLI printed without intercepting process.stdout.
 */
function defaultStdout(line) {
  process.stdout.write(`${line}\n`);
}

function defaultStderr(line) {
  process.stderr.write(`${line}\n`);
}

/**
 * Parse the CLI argv into a typed bag. Exported for tests.
 *
 * @param {string[]} argv  argv slice (excluding `node` and the script path).
 * @returns {{
 *   epicId: number|null,
 *   dryRun: boolean,
 *   apply: boolean,
 *   explicitDelete: boolean,
 *   yes: boolean,
 *   raw: object
 * }}
 */
export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      'explicit-delete': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
    },
    strict: false,
  });

  // Default behaviour: when neither --apply nor --dry-run is set, the
  // CLI runs in dry-run mode (Tech Spec: "dry-run default"). When both
  // are passed, --dry-run wins — safer to no-op than to apply by accident.
  const explicitApply = values.apply === true;
  const explicitDryRun = values['dry-run'] === true;
  const dryRun = explicitDryRun || !explicitApply;

  const epicArg = positionals[0];
  const epicId =
    epicArg != null && /^\d+$/.test(String(epicArg))
      ? Number.parseInt(String(epicArg), 10)
      : null;

  return {
    epicId,
    dryRun,
    apply: explicitApply && !explicitDryRun,
    explicitDelete: values['explicit-delete'] === true,
    yes: values.yes === true,
    raw: values,
  };
}

/**
 * Project the GH state observation into the shape the diff engine
 * expects: `{ [issueNumber]: { title, body?, labels?, state } }`.
 *
 * Enumerates the Epic's children via the **server-side-scoped**
 * `getSubTickets(epicId)` (native sub-issue GraphQL graph → checklist
 * links → reverse-search) rather than `getTickets(epicId)`'s repo-wide
 * `state=all` scan-and-filter (Story #3455). The structural diff engine
 * never branches on `obs.state` — Close detection is driven by
 * spec-vs-mapping, `fieldChanges` compares only `title/body/labels/wave`,
 * and `ghState` is consulted only to look up an issue by the number
 * already in the state-file mapping — so dropping the repo-wide
 * closed-issue over-fetch changes nothing but cost (and removes the
 * latent spurious-Update risk on a re-plan of a partially-delivered
 * Epic). The provider's returned children come back as full ticket
 * objects (`id, title, body, labels, state`); the diff engine ignores
 * fields it doesn't use.
 *
 * @param {object} provider
 * @param {number} epicId
 * @returns {Promise<Record<number, {title:string,body?:string,labels?:string[],state?:string}>>}
 */
export async function fetchGhState(provider, epicId) {
  const ghState = {};
  // Epic itself (best-effort — older providers may stub getEpic; treat
  // a thrown call as "epic not observable" and continue with children).
  try {
    if (typeof provider.getEpic === 'function') {
      const epic = await provider.getEpic(epicId);
      if (epic && typeof epic.id === 'number') {
        ghState[epic.id] = {
          title: epic.title,
          body: epic.body ?? '',
          labels: epic.labels ?? [],
          state: epic.state ?? 'open',
        };
      }
    }
  } catch (_err) {
    /* swallow — epic body observation is non-fatal for diff */
  }

  if (typeof provider.getSubTickets === 'function') {
    const tickets = await provider.getSubTickets(epicId);
    for (const t of tickets ?? []) {
      if (typeof t.id !== 'number') continue;
      ghState[t.id] = {
        title: t.title,
        body: t.body ?? '',
        labels: t.labels ?? [],
        state: t.state ?? 'open',
      };
    }
  }
  return ghState;
}

/**
 * Walk the spec and yield one `{ slug, entity, title, parentSlug,
 * dependsOn }` record per logical entity (epic → story), mirroring the
 * diff engine's `flattenSpec`. Local to the CLI so the reseed pass
 * (below) can map spec slugs onto live GH issues without importing the
 * diff engine's private walker. Pure.
 *
 * @param {object} spec
 * @returns {Array<{slug: string, entity: string, title: string, parentSlug: string|null, dependsOn: string[]}>}
 */
export function flattenSpecForReseed(spec) {
  const out = [];
  if (!spec || typeof spec !== 'object') return out;
  if (spec.epic && typeof spec.epic === 'object') {
    out.push({
      slug: 'epic',
      entity: 'epic',
      title: String(spec.epic.title ?? ''),
      parentSlug: null,
      dependsOn: [],
    });
  }
  for (const story of spec.stories ?? []) {
    out.push({
      slug: story.slug,
      entity: 'story',
      title: String(story.title ?? ''),
      parentSlug: 'epic',
      dependsOn: story.dependsOn ?? [],
    });
  }
  return out;
}

/**
 * Story #3905 — recover the slug→issue mapping from live GitHub state
 * when `state.json` is missing or incomplete.
 *
 * The reconciler's idempotency on `--resume` rests entirely on the
 * gitignored `temp/epic-<id>/<id>.state.json` slug→issue map. When that
 * file is absent (a fresh checkout, a reaped temp dir, the exact
 * situation `--resume` exists to recover from), `loadState` returns an
 * empty mapping, the diff engine sees every spec slug as unmapped, and
 * `apply` recreates the entire Story set on top of the existing
 * one — duplicating every child. This is precisely the failure `--resume`
 * is meant to prevent.
 *
 * This pass closes the gap: for every spec slug that is **not** already
 * in the mapping, it looks for an **open** GH issue whose title matches
 * the spec entity's title (and whose issue number is not already claimed
 * by another mapping entry). A match seeds a mapping entry carrying the
 * structural edges (`entity`, `parentSlug`, `dependsOn`) the diff engine
 * reads, so the slug diffs as an Update/no-op rather than a Create.
 *
 * Pure: it mutates and returns a shallow clone of `state.mapping`; it
 * performs no I/O (the caller supplies the already-fetched `ghState`).
 * Title matching is intentionally conservative — an unmatched slug is
 * left unmapped so a genuinely-missing child is still created (the
 * partial-persist case `--resume` also serves). Returns the reseeded
 * state plus the list of slugs it recovered so the caller can log them.
 *
 * @param {{epicId: number, mapping: Record<string, object>}} state
 * @param {object} spec
 * @param {Record<string|number, {title?: string, state?: string}>} ghState
 * @returns {{ state: object, reseeded: Array<{slug: string, issueNumber: number}> }}
 */
export function reseedMappingFromGh(state, spec, ghState) {
  const reseeded = [];
  const mapping = { ...(state?.mapping ?? {}) };
  if (!spec || typeof spec !== 'object' || !ghState) {
    return { state: { ...state, mapping }, reseeded };
  }

  // Issue numbers already claimed by the current mapping must not be
  // re-bound to a second slug.
  const claimed = new Set();
  for (const entry of Object.values(mapping)) {
    if (entry && typeof entry.issueNumber === 'number') {
      claimed.add(entry.issueNumber);
    }
  }

  // Index OPEN gh issues by title → [issueNumber]. Closed issues are
  // skipped: a `--force`/`--resume` should never re-bind a slug to a
  // tombstoned issue.
  const openByTitle = new Map();
  for (const [num, obs] of Object.entries(ghState)) {
    const issueNumber = Number(num);
    if (!Number.isInteger(issueNumber)) continue;
    if (obs?.state && obs.state !== 'open') continue;
    const title = typeof obs?.title === 'string' ? obs.title : null;
    if (title == null) continue;
    if (!openByTitle.has(title)) openByTitle.set(title, []);
    openByTitle.get(title).push(issueNumber);
  }

  for (const entity of flattenSpecForReseed(spec)) {
    // Epic #4474 (PR3) — a mapping entry WITHOUT an issue number is a
    // partial-failure tombstone (the apply's state writer persists every
    // spec slug; only completed creations carry `issueNumber`). Treat it
    // as unmapped here so a title-matched live issue reseeds it instead
    // of leaving a numberless entry the diff engine can neither update
    // nor (post-fix) skip-create.
    if (Number.isInteger(mapping[entity.slug]?.issueNumber)) continue; // already mapped
    const candidates = openByTitle.get(entity.title) ?? [];
    // Pick the lowest unclaimed candidate for determinism.
    const match = candidates
      .filter((n) => !claimed.has(n))
      .sort((a, b) => a - b)[0];
    if (typeof match !== 'number') continue;
    claimed.add(match);
    mapping[entity.slug] = {
      issueNumber: match,
      contentHash: '',
      lastObservedAgentState: null,
      entity: entity.entity,
      parentSlug: entity.parentSlug,
      ...(entity.dependsOn.length > 0 ? { dependsOn: entity.dependsOn } : {}),
    };
    reseeded.push({ slug: entity.slug, issueNumber: match });
  }

  return { state: { ...state, mapping }, reseeded };
}

/**
 * Prompt the operator for confirmation on the supplied plan. Resolves
 * `true` when the user answers `y`/`yes` (case-insensitive), `false`
 * otherwise. Uses `readline` against `process.stdin`/`process.stdout` so
 * stubs (test) and the real TTY both work.
 *
 * @param {object} [opts]
 * @param {NodeJS.ReadableStream} [opts.input]
 * @param {NodeJS.WritableStream} [opts.output]
 * @returns {Promise<boolean>}
 */
export function confirmInteractive(opts = {}) {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    rl.question('Apply this plan? [y/N] ', (answer) => {
      rl.close();
      const trimmed = String(answer ?? '')
        .trim()
        .toLowerCase();
      resolve(trimmed === 'y' || trimmed === 'yes');
    });
  });
}

/**
 * Identify whether the plan carries any close ops. The exit-code
 * contract gates close ops behind `--explicit-delete`; this predicate
 * is the canonical "needs --explicit-delete" check. Exported so the
 * contract tests can pin the predicate without re-deriving it.
 *
 * @param {object} plan
 * @returns {boolean}
 */
export function planHasCloses(plan) {
  return Array.isArray(plan?.closes) && plan.closes.length > 0;
}

/**
 * Render the operator-facing message printed on the exit-2 path. Names
 * every close-op slug so the operator can audit precisely what would be
 * removed before re-running with `--explicit-delete`. Exported so the
 * contract tests assert the rendering without re-implementing it.
 *
 * @param {object} plan
 * @returns {string}
 */
export function renderExplicitDeleteMessage(plan) {
  const closes = Array.isArray(plan?.closes) ? plan.closes : [];
  const slugList = closes
    .map((op) => `#${op.issueNumber ?? '?'} (${op.slug})`)
    .join(', ');
  return (
    `Plan carries ${closes.length} close operation(s): ${slugList}. ` +
    `Re-run with --explicit-delete to apply.`
  );
}

/**
 * Format the spec-validation failure for stderr — names the failing
 * JSON Pointer and the underlying schema message so operators can fix
 * the spec without re-running with --verbose.
 *
 * @param {SpecValidationError|SpecParseError|SpecNotFoundError} err
 * @returns {string}
 */
function formatSpecError(err) {
  if (err instanceof SpecValidationError) {
    // Render every issue on its own line so scripts that grep stderr for
    // a JSON Pointer find each failure individually. The first issue is
    // duplicated into the headline so existing log scrapers reading line 1
    // keep working.
    const issues = Array.isArray(err.issues) ? err.issues : [];
    if (issues.length === 0) {
      return `Spec validation failed: ${err.message}`;
    }
    const head = issues[0];
    const lines = [
      `Spec validation failed at ${head.path}: ${head.message}`,
      ...issues.slice(1).map((iss) => `  · ${iss.path}: ${iss.message}`),
    ];
    return lines.join('\n');
  }
  if (err instanceof SpecParseError) {
    return `Spec YAML parse error in ${err.filePath}: ${err.cause?.message ?? err.message}`;
  }
  if (err instanceof SpecNotFoundError) {
    return `Spec file missing for epic ${err.epicId}: ${err.filePath}`;
  }
  return `Spec error: ${err.message ?? err}`;
}

/**
 * Run one reconcile cycle for a given Epic. Pure dependency-injection
 * surface — every external collaborator (provider, loaders, formatter,
 * apply, confirm prompt, log sinks) is overridable so the contract tests
 * can drive the CLI without hitting the network, the file system, or a
 * real TTY.
 *
 * @param {{
 *   epicId: number,
 *   dryRun: boolean,
 *   apply: boolean,
 *   explicitDelete: boolean,
 *   yes: boolean,
 * }} args
 * @param {{
 *   provider?: object,
 *   loadSpec?: typeof loadSpec,
 *   loadState?: typeof loadState,
 *   diff?: typeof diff,
 *   apply?: typeof apply,
 *   formatPlan?: typeof formatPlan,
 *   fetchGhState?: typeof fetchGhState,
 *   confirm?: typeof confirmInteractive,
 *   isTty?: () => boolean,
 *   stdout?: (line: string) => void,
 *   stderr?: (line: string) => void,
 *   loaderOpts?: object,
 * }} [deps]
 * @returns {Promise<{exitCode: number, plan?: object, applyResult?: object}>}
 */
export async function runReconcile(args, deps = {}) {
  const stdout = deps.stdout ?? defaultStdout;
  const stderr = deps.stderr ?? defaultStderr;
  const loadSpecFn = deps.loadSpec ?? loadSpec;
  const loadStateFn = deps.loadState ?? loadState;
  const diffFn = deps.diff ?? diff;
  const applyFn = deps.apply ?? apply;
  const formatFn = deps.formatPlan ?? formatPlan;
  const fetchGhStateFn = deps.fetchGhState ?? fetchGhState;
  const confirmFn = deps.confirm ?? confirmInteractive;
  const isTtyFn = deps.isTty ?? (() => Boolean(process.stdin.isTTY));
  const loaderOpts = deps.loaderOpts ?? {};

  if (!Number.isInteger(args.epicId) || args.epicId <= 0) {
    stderr('[epic-reconcile] Error: epic id is required and must be positive');
    stderr(
      'Usage: epic-reconcile.js <epicId> [--dry-run] [--apply] [--explicit-delete] [--yes]',
    );
    return { exitCode: EXIT_CODES.VALIDATION_ERROR };
  }

  // 1. Load + validate the spec.
  let spec;
  try {
    spec = loadSpecFn(args.epicId, loaderOpts);
  } catch (err) {
    stderr(`[epic-reconcile] ${formatSpecError(err)}`);
    return { exitCode: EXIT_CODES.VALIDATION_ERROR };
  }

  // 2. Load the state (absent file → empty mapping).
  let state;
  try {
    state = loadStateFn(args.epicId, loaderOpts);
  } catch (_err) {
    state = { epicId: args.epicId, mapping: {} };
  }
  if (!state || typeof state !== 'object') {
    state = { epicId: args.epicId, mapping: {} };
  }

  // 2a. Seed the synthetic `epic` slug mapping. The diff engine's
  // `flattenSpec` unconditionally yields an entity for the epic, and
  // `applyCreate` carries a long-standing comment asserting the epic
  // "is bootstrapped before reconciliation". On a fresh apply with no
  // state.json, nothing previously did that — so diff emitted a Create
  // op for the epic and `provider.createTicket` materialised a duplicate
  // GH issue (Story #1820). The CLI is the right seam to seed it: keeps
  // diff/apply pure and one-shot per reconcile run.
  if (!state.mapping || typeof state.mapping !== 'object') {
    state.mapping = {};
  }
  if (!state.mapping.epic) {
    state.mapping.epic = {
      issueNumber: args.epicId,
      contentHash: '',
      lastObservedAgentState: null,
      entity: 'epic',
      parentSlug: null,
    };
  }

  // 3. Resolve provider, fetch GH state.
  let provider = deps.provider;
  if (!provider) {
    const config = deps.config ?? resolveConfig({});
    provider = createProvider(config);
  }
  const ghState = await fetchGhStateFn(provider, args.epicId);

  // 3a. Reseed the slug→issue mapping from live GH state for any spec
  // slug the state file did not cover (Story #3905). Without this, a
  // `--resume` (or any apply) run with a missing/empty `state.json` but
  // open children present would diff every spec slug as a Create and
  // duplicate the entire Feature/Story tree. Title-matched recovery turns
  // those spurious Creates into Updates/no-ops. Pure — no I/O.
  const { state: reseededState, reseeded } = reseedMappingFromGh(
    state,
    spec,
    ghState,
  );
  state = reseededState;
  if (reseeded.length > 0) {
    stderr(
      `[epic-reconcile] Reseeded ${reseeded.length} slug→issue mapping(s) from live GitHub state ` +
        `(state.json was missing/incomplete): ${reseeded
          .map((r) => `${r.slug}→#${r.issueNumber}`)
          .join(', ')}.`,
    );
  }

  // 4. Compute the plan.
  const plan = diffFn({ spec, state, ghState });

  // 5. Render.
  stdout(formatFn(plan));

  // 6a. Dry-run path — print and exit 0 regardless of plan size.
  if (args.dryRun) {
    return { exitCode: EXIT_CODES.OK, plan };
  }

  // 6b. Empty plan: nothing to apply. Exit 0 without prompting.
  if (isEmptyPlan(plan)) {
    return { exitCode: EXIT_CODES.OK, plan };
  }

  // 6c. Explicit-delete pre-flight: any close op requires the flag. We
  // gate at the CLI surface (before apply) so the exit code is stable
  // regardless of whether apply's discriminator would also reject — the
  // task contract pins exit 2 to "would close without --explicit-delete",
  // not "apply engine rejected".
  if (planHasCloses(plan) && !args.explicitDelete) {
    stderr(`[epic-reconcile] ${renderExplicitDeleteMessage(plan)}`);
    return { exitCode: EXIT_CODES.EXPLICIT_DELETE_REQUIRED, plan };
  }

  // 6d. Confirmation gate.
  if (!args.yes) {
    if (!isTtyFn()) {
      stderr(
        '[epic-reconcile] --apply requires either --yes or an interactive TTY.',
      );
      return { exitCode: EXIT_CODES.VALIDATION_ERROR, plan };
    }
    const confirmed = await confirmFn();
    if (!confirmed) {
      stdout('[epic-reconcile] Aborted by operator.');
      return { exitCode: EXIT_CODES.OK, plan };
    }
  }

  // 6e. Apply.
  let applyResult;
  try {
    applyResult = await applyFn(plan, provider, {
      epicId: args.epicId,
      spec,
      priorState: state,
      explicitDelete: args.explicitDelete,
    });
  } catch (err) {
    if (
      err instanceof ApplyGateViolation &&
      err.reason === 'explicit-delete-required'
    ) {
      stderr(`[epic-reconcile] ${err.message}`);
      return { exitCode: EXIT_CODES.EXPLICIT_DELETE_REQUIRED, plan };
    }
    stderr(`[epic-reconcile] Apply failed: ${err.message ?? err}`);
    return { exitCode: EXIT_CODES.VALIDATION_ERROR, plan };
  }

  if (applyResult?.failure) {
    stderr(
      `[epic-reconcile] Apply completed with partial failure: ${applyResult.failure.message ?? applyResult.failure}`,
    );
    return { exitCode: EXIT_CODES.VALIDATION_ERROR, plan, applyResult };
  }

  stdout('[epic-reconcile] Apply complete.');
  return { exitCode: EXIT_CODES.OK, plan, applyResult };
}

/**
 * CLI entry point. Parses argv, delegates to `runReconcile`, and exits
 * with the contract-defined integer.
 */
async function main(argv = process.argv.slice(2)) {
  const args = parseCli(argv);
  const { exitCode } = await runReconcile(args);
  process.exit(exitCode);
}

runAsCli(import.meta.url, main, {
  source: 'epic-reconcile',
  onError: (err) => {
    Logger.error('[epic-reconcile] Fatal error:', err?.message ?? err);
    process.exit(EXIT_CODES.VALIDATION_ERROR);
  },
});
