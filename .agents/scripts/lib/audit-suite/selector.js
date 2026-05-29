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

import fs from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import { getPaths, PROJECT_ROOT, resolveConfig } from '../config-resolver.js';
import { softFailOrThrow } from '../degraded-mode.js';
import { gitSpawn } from '../git-utils.js';
import { withTimeout } from '../util/with-timeout.js';

const DEFAULT_GIT_TIMEOUT_MS = 30000;

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
 *   concurrent `/epic-deliver` runs sharing one checkout, diffing against
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

    if (triggers.alwaysRun) {
      selectedAudits.push(auditName);
      continue;
    }

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
