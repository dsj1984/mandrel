/**
 * lib/audit-suite/selector.js — `selectAudits` rule-matching core.
 *
 * Extracted from `.agents/scripts/select-audits.js` (Story #1083, Epic
 * #1072) so the audit-suite SDK barrel at `./index.js` can re-export it
 * without importing upward from a top-level CLI file.
 *
 * Pure (modulo `gitSpawn`) — exposed helpers are:
 *   - matchesFilePattern    — single file × single glob (picomatch with `dot`)
 *   - matchesAnyFilePattern — file list × pattern list, short-circuiting
 *   - selectAudits          — main entry; reads audit-rules.json, runs `git
 *                             diff --name-only`, applies keyword + glob rules.
 *
 * The CLI wrapper at `.agents/scripts/select-audits.js` reduces to argv
 * parsing, provider construction, JSON stdout, and degraded-mode exit-code
 * mapping. All rule-matching lives here.
 */

import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import { getPaths, PROJECT_ROOT, resolveConfig } from '../config-resolver.js';
import { softFailOrThrow } from '../degraded-mode.js';
import { gitSpawn } from '../git-utils.js';
import { withTimeout } from '../util/with-timeout.js';

const DEFAULT_GIT_TIMEOUT_MS = 30000;

/**
 * The audit-lens identifier for the navigability lens (Epic #4131, F2/F3).
 * Authored as `.agents/workflows/audit-navigability.md`; registered here so the
 * roster, the global-lens allowlist, and the route-added routing seam all
 * reference one symbol rather than a hard-coded string.
 */
export const NAVIGABILITY_LENS = 'audit-navigability';

/**
 * The **global-lens allowlist** — lenses that evaluate a property of the
 * **whole** product (not just the Epic's change set) and are therefore exempt
 * from the cross-epic-leak guard (`#3362`) that narrows every other lens's
 * evidence to the Epic's `changedFiles`. A lens in this set still runs through
 * the SAME `runAuditSuite` / `selectAuditStrategy` engine; only the
 * change-set narrowing is bypassed, and only for the listed lenses. The guard
 * is **not** weakened for any lens absent from this set.
 *
 * Navigability is the founding member: reachability is a global property — a
 * change can orphan a route it never touched — so the lens must read the whole
 * route tree + nav registry regardless of which file triggered it.
 */
export const GLOBAL_LENS_ALLOWLIST = Object.freeze([NAVIGABILITY_LENS]);

/**
 * True when `lens` is on the global-lens allowlist and is therefore exempt
 * from the cross-epic-leak guard's change-set narrowing. Pure; the single
 * read-side of {@link GLOBAL_LENS_ALLOWLIST} so callers never hard-code the
 * membership test.
 *
 * @param {string} lens
 * @returns {boolean}
 */
export function isGlobalLens(lens) {
  return GLOBAL_LENS_ALLOWLIST.includes(lens);
}

/**
 * The canonical concern-ownership tiers a lens can declare via its
 * `scope` field in [`audit-rules.json`](../../../schemas/audit-rules.json).
 * This frozen tuple is the single source of truth for the tier vocabulary the
 * schema's `scope` enum enforces and {@link resolveLensTier} returns:
 *
 *   - `local`      — decidable from a single Story's diff; verified at
 *                    write-time and Story-scope review, not re-run at Epic close.
 *   - `cumulative` — only decidable across the Epic's combined diff; verified
 *                    at Epic close.
 *   - `global`     — evaluates a whole-product property regardless of the diff;
 *                    verified at Epic close, exempt from change-set narrowing.
 *
 * @type {readonly ['local', 'cumulative', 'global']}
 */
export const LENS_TIERS = Object.freeze(['local', 'cumulative', 'global']);

/**
 * Resolve the concern-ownership tier a lens declares in `audit-rules.json`.
 * This is the pure read-side of the `scope` field (Epic #4405, Story #4407)
 * that replaced the former `alwaysRun` special case: every downstream tier —
 * write-time checklist threading, Story-scope review, the Epic-close roster
 * split — routes off this one field instead of a maintained prose constraint.
 *
 * Deterministic given the on-disk manifest: it reads the same
 * `audit-rules.json` that {@link selectAudits} consumes (resolved through the
 * project's configured `schemasRoot`), looks up the lens, and returns its
 * `scope`. It takes no ticket, runs no git, and has no side effects.
 *
 * @param {string} lens Lens key registered in `audit-rules.json`
 *   (e.g. `audit-clean-code`).
 * @returns {'local' | 'cumulative' | 'global'} The lens's declared tier.
 * @throws {Error} When `lens` is not registered in the manifest, or the
 *   manifest cannot be read, or the registered entry carries a scope outside
 *   {@link LENS_TIERS}.
 */
/**
 * Read and parse the `audit-rules.json` manifest synchronously from the
 * project's configured `schemasRoot`. Shared by the synchronous, ticket-free
 * readers ({@link resolveLensTier}, {@link selectLocalLenses}) so the path
 * resolution and read-failure handling live in one place rather than being
 * duplicated per reader.
 *
 * @returns {{ audits?: Record<string, object> }} Parsed manifest.
 * @throws {Error} When the manifest cannot be read or parsed.
 */
function readAuditRulesSync() {
  const { agentSettings } = resolveConfig();
  const rulesPath = path.join(
    PROJECT_ROOT,
    getPaths({ agentSettings }).schemasRoot,
    'audit-rules.json',
  );
  try {
    return JSON.parse(readFileSync(rulesPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `audit-suite: failed to read audit-rules from ${rulesPath}: ${err.message}`,
    );
  }
}

export function resolveLensTier(lens) {
  const rulesData = readAuditRulesSync();

  const entry = rulesData.audits?.[lens];
  if (!entry) {
    throw new Error(
      `resolveLensTier: unknown lens '${lens}' — not registered in audit-rules.json`,
    );
  }

  const { scope } = entry;
  if (!LENS_TIERS.includes(scope)) {
    throw new Error(
      `resolveLensTier: lens '${lens}' declares invalid scope '${scope}'; expected one of ${LENS_TIERS.join(', ')}`,
    );
  }

  return scope;
}

/**
 * Select the LOCAL-tier lenses whose `filePatterns` triggers match a change
 * set. This is the Story-scope roster used by the maker-blind story-close
 * review (Epic #4405, Story #4409): a lens is selected iff
 * `resolveLensTier(lens) === 'local'` **and** the pure
 * {@link matchesAnyFilePattern} matcher hits at least one of `changedFiles`
 * against the lens's registered `triggers.filePatterns`.
 *
 * This deliberately does **not** call {@link selectAudits}: `selectAudits`
 * unions in keyword-matched and gate-scoped lenses and has no per-tier gate,
 * so it would widen the roster beyond the local, footprint-matched set the
 * shift-left Story-scope tier owns. A local lens with a universal
 * `filePatterns` glob (e.g. `audit-clean-code`, whose sole pattern matches
 * every path) matches every change set here, so its concern is verified at
 * BOTH innermost tiers — the
 * write-time checklist threading and this Story-scope lens pass — and excluded
 * from Epic close (a local lens is dropped by {@link selectEpicCloseLenses}).
 * A local lens with an empty `filePatterns` list matches nothing here, so a
 * diff matching no local lens's patterns yields an empty roster and adds no
 * lens work.
 *
 * Pure over its injected seams: `injectedRules` skips the disk read of the
 * manifest and `resolveLensTierFn` overrides the tier resolver, so callers can
 * exercise the selection without touching the filesystem. Selection order
 * follows the manifest's declaration order, which is deterministic.
 *
 * @param {{
 *   changedFiles?: string[],
 *   injectedRules?: { audits?: Record<string, object> },
 *   resolveLensTierFn?: typeof resolveLensTier,
 * }} [params]
 * @returns {string[]} The matched local-lens identifiers, in manifest order.
 */
export function selectLocalLenses({
  changedFiles,
  injectedRules,
  resolveLensTierFn = resolveLensTier,
} = {}) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  if (files.length === 0) return [];

  const rules = injectedRules ?? readAuditRulesSync();
  const selected = [];
  for (const [lens, entry] of Object.entries(rules.audits ?? {})) {
    if (resolveLensTierFn(lens) !== 'local') continue;
    const patterns = entry?.triggers?.filePatterns ?? [];
    if (matchesAnyFilePattern(patterns, files)) {
      selected.push(lens);
    }
  }
  return selected;
}

/**
 * Resolve the consumer's navigability route globs from the resolved config.
 * Reads `delivery.quality.navigability.routeGlobs` — the route-tree SSOT the
 * navigability lens enumerates and the route-added routing predicate matches
 * against. Returns an empty array when the block (or any ancestor) is absent,
 * so an unconfigured consumer routes nothing and the lens degrades to a silent
 * no-op (Epic #4131 — "no-op when unconfigured").
 *
 * @param {object|null|undefined} config Resolved `.agentrc.json` wrapper.
 * @returns {string[]} Route globs, or `[]` when unconfigured.
 */
export function resolveNavigabilityRouteGlobs(config) {
  const globs = config?.delivery?.quality?.navigability?.routeGlobs;
  return Array.isArray(globs) ? globs.filter((g) => typeof g === 'string') : [];
}

/**
 * Decide whether a change set routes the navigability lens. The lens is routed
 * when any `changedFiles` entry matches a consumer-configured route glob
 * (`delivery.quality.navigability.routeGlobs`) — i.e. the change set adds or
 * touches a route file. When no route globs are configured, this returns
 * `false` (the unconfigured no-op), so the existing change-set-scoped lens
 * selection is unchanged.
 *
 * This is a pure predicate over the SAME inputs the existing risk-routed-lens
 * union already consumes; the caller folds its result into `riskRoutedAudits`
 * via the existing `unionAudits` — no new routing machinery is added.
 *
 * @param {{ changedFiles?: string[], config?: object|null }} params
 * @returns {boolean}
 */
export function routesNavigabilityLens({ changedFiles, config } = {}) {
  const globs = resolveNavigabilityRouteGlobs(config);
  if (globs.length === 0) return false;
  return matchesAnyFilePattern(globs, changedFiles ?? []);
}

/**
 * Test a single filename against a single glob pattern using the project's
 * configured matcher semantics (`picomatch` with `dot: true`). Exported so
 * regression tests can pin engine behaviour without stubbing audit-rules.
 */
export function matchesFilePattern(pattern, file) {
  return picomatch(pattern, { dot: true })(file);
}

/**
 * Return true when any of `files` matches any of `patterns`.
 * Same semantics as `matchesFilePattern`; matchers are compiled once per call.
 */
export function matchesAnyFilePattern(patterns, files) {
  if (!patterns?.length || !files?.length) return false;
  const matchers = patterns.map((p) => picomatch(p, { dot: true }));
  return files.some((file) => matchers.some((m) => m(file)));
}

/**
 * Filter audits based on logic in audit-rules.json (validated against
 * audit-rules.schema.json).
 *
 * @param {object} params
 * @param {number} params.ticketId
 * @param {string} params.gate
 * @param {import('../ITicketingProvider.js').ITicketingProvider} params.provider
 * @param {string} [params.baseBranch]
 * @param {string} [params.headRef]
 *   Git ref whose diff-against-`baseBranch` defines the change set. Defaults
 *   to `HEAD` (the working-copy tip) for ticket-scoped callers. Epic-mode
 *   callers MUST pass the requested Epic's own branch ref (e.g.
 *   `refs/heads/epic/<id>`) so the change set is pinned to that Epic's branch
 *   rather than whatever HEAD the shared checkout happens to sit on. Under two
 *   concurrent `/deliver` runs sharing one checkout, diffing against
 *   `HEAD` silently resolves the *other* Epic's change set (Story #3362). When
 *   `headRef` cannot be resolved in the repo, the selector returns a
 *   `degraded: true` envelope (or hard-fails in gate-mode) instead of diffing
 *   the wrong tree.
 * @param {(cwd: string, ...args: string[]) => Promise<{status:number, stdout:string, stderr:string}>} [params.injectedGitSpawn]
 *   Test-only seam. Production callers leave unset; the real (synchronous) `gitSpawn`
 *   is wrapped in `Promise.resolve` so `withTimeout` can still race it. Tests can
 *   inject a promise that never resolves to exercise the ETIMEDOUT fallback.
 * @param {number} [params.gitTimeoutMsOverride]
 *   Test-only seam to shrink the git-spawn timeout below the configured default
 *   (which is 30_000 ms) so timeout tests don't stall the suite.
 * @param {{ argv?: string[], env?: NodeJS.ProcessEnv }} [params.gateModeOpts]
 *   Test-only seam to drive the `--gate-mode` / `MANDREL_GATE_MODE=1`
 *   detection; production callers leave unset and `isGateMode` reads
 *   `process.argv` / `process.env`.
 *
 * Returns either the success envelope (`{ selectedAudits, ticketId, gate, context }`)
 * OR the degraded envelope (`{ ok: false, degraded: true, reason, detail }`)
 * when the git-diff probe times out OR `headRef` cannot be resolved and
 * gate-mode is unset. In gate-mode, the same conditions throw.
 */
export async function selectAudits({
  ticketId,
  gate,
  provider,
  baseBranch = 'main',
  headRef = 'HEAD',
  injectedGitSpawn,
  gitTimeoutMsOverride,
  gateModeOpts,
}) {
  const { agentSettings } = resolveConfig();
  const timeoutMs = gitTimeoutMsOverride ?? DEFAULT_GIT_TIMEOUT_MS;

  const rulesPath = path.join(
    PROJECT_ROOT,
    getPaths({ agentSettings }).schemasRoot,
    'audit-rules.json',
  );
  let rulesData;
  try {
    rulesData = JSON.parse(await fs.readFile(rulesPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Failed to read audit-rules from ${rulesPath}: ${err.message}`,
    );
  }

  const ticket = await provider.getTicket(ticketId);
  const contentToSearch =
    `${ticket.title || ''} ${ticket.body || ''}`.toLowerCase();

  const runGit = injectedGitSpawn ?? (async (...args) => gitSpawn(...args));

  // Resolve `headRef` to a commit before diffing. A non-default `headRef`
  // (Epic-mode callers pass `refs/heads/epic/<id>`) that the repo can't
  // resolve means the requested Epic's branch is not present in this
  // checkout — diffing `baseBranch...HEAD` would silently report a
  // *different* Epic's change set (Story #3362). Surface that as an explicit
  // degraded signal instead of leaking the wrong scope. `HEAD` is always
  // resolvable in a valid repo, so the default-path callers skip the probe
  // cost on the common case.
  if (headRef !== 'HEAD') {
    let resolved;
    try {
      resolved = await withTimeout(
        runGit(process.cwd(), 'rev-parse', '--verify', '--quiet', headRef),
        timeoutMs,
        { label: 'select-audits rev-parse headRef' },
      );
    } catch (err) {
      if (err?.code === 'ETIMEDOUT') {
        return softFailOrThrow(
          'GIT_DIFF_TIMEOUT',
          `select-audits: git rev-parse ${headRef} timed out after ${timeoutMs} ms`,
          gateModeOpts,
        );
      }
      throw err;
    }
    if (resolved?.status !== 0 || !resolved.stdout.trim()) {
      return softFailOrThrow(
        'HEAD_REF_UNRESOLVED',
        `select-audits: requested ref '${headRef}' could not be resolved in this checkout; refusing to diff against a phantom change set`,
        gateModeOpts,
      );
    }
  }

  let changedFiles = [];
  try {
    const diff = await withTimeout(
      runGit(
        process.cwd(),
        'diff',
        '--name-only',
        `${baseBranch}...${headRef}`,
      ),
      timeoutMs,
      { label: 'select-audits git diff' },
    );
    if (diff?.status === 0) {
      changedFiles = diff.stdout
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean);
    }
  } catch (err) {
    if (err?.code === 'ETIMEDOUT') {
      // Soft-fail contract (Tech Spec #819): in default mode, return a
      // degraded envelope so the caller sees the explicit signal instead of
      // silently falling through to keyword-only matching. In gate-mode,
      // hard-fail closed.
      return softFailOrThrow(
        'GIT_DIFF_TIMEOUT',
        `select-audits: git diff against ${baseBranch} timed out after ${timeoutMs} ms`,
        gateModeOpts,
      );
    }
    throw err;
  }

  const selectedAudits = [];

  for (const [auditName, ruleOpts] of Object.entries(rulesData.audits || {})) {
    const triggers = ruleOpts.triggers || {};

    const gateMatch = triggers.gates?.includes(gate);
    if (!gateMatch) continue;

    const keywords = triggers.keywords || [];
    let keywordMatch = false;
    for (const kw of keywords) {
      if (contentToSearch.includes(kw.toLowerCase())) {
        keywordMatch = true;
        break;
      }
    }

    const fileMatch = matchesAnyFilePattern(
      triggers.filePatterns || [],
      changedFiles,
    );

    if (keywordMatch || fileMatch) {
      selectedAudits.push(auditName);
    }
  }

  return {
    selectedAudits,
    ticketId,
    gate,
    context: {
      // Full file list, exposed so Epic-mode callers (e.g. epic-audit) can
      // pass it through as the {{changedFiles}} substitution value. Existing
      // callers that read only `changedFilesCount` remain unaffected.
      changedFiles,
      changedFilesCount: changedFiles.length,
      // The ref the change set was actually diffed against. Epic-mode callers
      // assert this matches the requested Epic branch (Story #3362) so a
      // mis-pinned diff never reaches the audit-lens selector silently.
      resolvedRef: headRef,
      ticketTitle: ticket.title,
    },
  };
}
