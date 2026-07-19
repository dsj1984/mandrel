/**
 * lib/audit-suite/checklist-threading.js — write-time local-lens checklist
 * threading (Epic #4405, Story #4410).
 *
 * Given a Story's predicted footprint (its `changes[]` / `references[]` path
 * list), select the distilled authoring checklists for the **footprint-matched
 * LOCAL lenses only** and assemble them into one payload the dispatch/hydrator
 * seam threads into the Story maker prompt. This moves each local-lens concern
 * to the innermost, write-time tier so makers author against it on fresh
 * context instead of paying an Epic-close remediation loop on stale context.
 *
 * Matching is the **light** path, deliberately NOT `selectAudits`:
 *   - tier gate  — a lens is in scope only when `resolveLensTier(lens) ===
 *                  'local'` (the pure `scope`-field read; cumulative/global
 *                  lenses are owned by the Epic-close tier, never threaded
 *                  here).
 *   - file gate  — the pure `matchesAnyFilePattern` matcher runs the lens's
 *                  own `triggers.filePatterns` (from `audit-rules.json`)
 *                  against the predicted footprint.
 *
 * `selectAudits` is the wrong tool here: it is gate-aware and provider-backed
 * (it reads the ticket through an `ITicketingProvider` and diffs the working
 * tree via `git`). The write-time path has a *predicted* footprint, not a git
 * diff, and no ticket to fetch — so this module reaches for the two pure
 * primitives directly and never touches a provider or `git`. That purity is
 * load-bearing (asserted by the test): the threading path must be a pure
 * function of the footprint and the on-disk manifest/checklists.
 *
 * A hard token budget caps the assembled payload. When the matched lenses'
 * checklists together exceed the budget, the payload is truncated
 * deterministically (a stable prefix in {@link AUDIT_LENSES} order is kept;
 * the overflowing tail is dropped) and every dropped lens is logged so the
 * elision is never silent.
 *
 * Pure (modulo the default disk reads for `audit-rules.json` and the checklist
 * artifacts, both injectable seams). No git, no provider, no network.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AUDIT_LENSES } from '../audit-to-stories/audit-lenses.js';
import { getPaths, PROJECT_ROOT, resolveConfig } from '../config-resolver.js';
import { Logger } from '../Logger.js';
import { estimateTokens } from '../orchestration/context-envelope.js';
import {
  changeSetLacksSiblingTest,
  matchesAnyFilePattern,
  resolveLensTier,
} from './selector.js';

/**
 * Hard cap on the assembled checklist payload, in the ≈4-char/token estimate
 * shared with the rest of the hydrator ({@link estimateTokens}). Generous
 * relative to the real checklist sizes (each distilled lens checklist is
 * ~130–190 tokens, and at most the seven local lenses can match), so a normal
 * Story is never truncated — the cap is a safety ceiling against a pathological
 * footprint that matches every local lens, not a routine squeeze. Callers may
 * override per-invocation via `tokenBudget`.
 */
export const DEFAULT_CHECKLIST_TOKEN_BUDGET = 4000;

/** Separator between concatenated per-lens checklist sections. */
const SECTION_SEPARATOR = '\n\n';

/**
 * The `audit-rules.json` / `resolveLensTier` lens key for a canonical lens
 * name. The taxonomy in {@link AUDIT_LENSES} carries bare names (`clean-code`);
 * the manifest and the tier resolver key off the `audit-`-prefixed form
 * (`audit-clean-code`).
 *
 * @param {string} lens
 * @returns {string}
 */
function lensKeyFor(lens) {
  return `audit-${lens}`;
}

/**
 * Absolute path to the committed distilled-checklist directory. Mirrors the
 * SSOT the generator writes to (`generate-lens-checklists.js` →
 * `<agentRoot>/audit-checklists/<lens>.md`), resolved through the same
 * `agentRoot` the rest of the config surface uses so a consumer that relocates
 * `.agents` reads its checklists from the relocated tree.
 *
 * @param {object} [config] resolved config wrapper (defaults to a fresh read).
 * @returns {string}
 */
function checklistsDir(config = resolveConfig()) {
  return path.join(
    PROJECT_ROOT,
    getPaths(config).agentRoot,
    'audit-checklists',
  );
}

/**
 * Read and parse `audit-rules.json` (the same manifest {@link selectAudits}
 * and {@link resolveLensTier} consume), resolved through the configured
 * `schemasRoot`. Synchronous — this is a pure-ish read with no git and no
 * provider.
 *
 * @param {object} [config] resolved config wrapper (defaults to a fresh read).
 * @returns {{ audits?: Record<string, { triggers?: { filePatterns?: string[] } }> }}
 */
export function readAuditRules(config = resolveConfig()) {
  const rulesPath = path.join(
    PROJECT_ROOT,
    getPaths(config).schemasRoot,
    'audit-rules.json',
  );
  return JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
}

/**
 * The `triggers.filePatterns` a lens declares in the manifest, or `[]` when
 * the lens declares none. (`audit-clean-code` carries the universal
 * match-everything glob, so it footprint-matches every non-empty change
 * set — the selector.js twin comment documents the same post-#4405
 * follow-up fix.)
 *
 * @param {object} rules parsed `audit-rules.json`.
 * @param {string} lens canonical lens name.
 * @returns {string[]}
 */
function filePatternsFor(rules, lens) {
  return rules?.audits?.[lensKeyFor(lens)]?.triggers?.filePatterns ?? [];
}

/**
 * The full `triggers` block a lens declares in the manifest (or `undefined`).
 * Used to read non-glob trigger fields (e.g. `sourceWithoutSiblingTest`).
 *
 * @param {object} rules parsed `audit-rules.json`.
 * @param {string} lens canonical lens name.
 * @returns {object|undefined}
 */
function triggerFor(rules, lens) {
  return rules?.audits?.[lensKeyFor(lens)]?.triggers;
}

/**
 * Normalize a predicted footprint into a clean path list. Accepts a plain
 * `string[]` (the shape the caller derives from a Story's `changes[]` /
 * `references[]` entries); drops empty and non-string entries.
 *
 * @param {unknown} footprint
 * @returns {string[]}
 */
function normalizeFootprint(footprint) {
  if (!Array.isArray(footprint)) return [];
  return footprint
    .filter((p) => typeof p === 'string')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Select, in stable {@link AUDIT_LENSES} order, the LOCAL lenses whose
 * `filePatterns` match the predicted footprint. This is the whole matching
 * contract — `resolveLensTier(lens) === 'local'` for the tier gate plus the
 * pure `matchesAnyFilePattern` matcher for the file gate — with no provider and
 * no git diff.
 *
 * A lens whose tier cannot be resolved (not registered / malformed scope) is
 * skipped rather than allowed to throw the whole selection; the generator and
 * schema keep the manifest well-formed, so this only guards against drift.
 *
 * @param {object} params
 * @param {string[]} params.footprint predicted footprint path list.
 * @param {object} [params.rules] parsed `audit-rules.json` (injectable seam).
 * @param {(lens: string) => string} [params.resolveTier] tier resolver
 *   (injectable seam; defaults to {@link resolveLensTier}).
 * @returns {string[]} matched local lens names, in taxonomy order.
 */
export function matchLocalLenses({
  footprint,
  rules = readAuditRules(),
  resolveTier = resolveLensTier,
} = {}) {
  const paths = normalizeFootprint(footprint);
  if (paths.length === 0) return [];

  const matched = [];
  for (const lens of AUDIT_LENSES) {
    let tier;
    try {
      tier = resolveTier(lensKeyFor(lens));
    } catch {
      continue;
    }
    if (tier !== 'local') continue;

    const patterns = filePatternsFor(rules, lens);
    const fileMatch =
      patterns.length > 0 && matchesAnyFilePattern(patterns, paths);
    // Coverage-gap routing (#4628): thread the quality checklist at write-time
    // on the same sibling-test predicate the selector uses, so a source change
    // that ships without a test is reminded of the quality lens up front.
    const siblingMatch =
      triggerFor(rules, lens)?.sourceWithoutSiblingTest === true &&
      changeSetLacksSiblingTest(paths);
    if (fileMatch || siblingMatch) matched.push(lens);
  }
  return matched;
}

/**
 * Default checklist reader: read `<agentRoot>/audit-checklists/<lens>.md`.
 * Returns `null` when the artifact is absent (a matched lens with no committed
 * checklist), so the caller skips it rather than crashing.
 *
 * @param {string} lens
 * @param {object} [config]
 * @returns {string|null}
 */
function readChecklistFile(lens, config = resolveConfig()) {
  const file = path.join(checklistsDir(config), `${lens}.md`);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Build the write-time checklist payload for a Story's predicted footprint.
 *
 * Returns the assembled payload string plus the accounting the caller (and the
 * test) asserts against: which lenses were included, which were dropped by the
 * budget, the full matched set, and the payload's estimated token count.
 *
 * Truncation is deterministic prefix truncation: lenses are considered in
 * stable {@link AUDIT_LENSES} order and appended while the running payload
 * estimate stays within `tokenBudget`; the first lens that would overflow — and
 * every remaining matched lens — is dropped, and the drop is logged. The
 * returned `payload` therefore always satisfies
 * `estimateTokens(payload) <= tokenBudget`.
 *
 * @param {object} params
 * @param {string[]} params.footprint predicted footprint (`changes[]` /
 *   `references[]` path list).
 * @param {number} [params.tokenBudget] hard cap (defaults to
 *   {@link DEFAULT_CHECKLIST_TOKEN_BUDGET}).
 * @param {object} [params.rules] parsed `audit-rules.json` (injectable seam).
 * @param {(lens: string) => string} [params.resolveTier] tier resolver
 *   (injectable seam).
 * @param {(lens: string) => (string|null)} [params.readChecklist] checklist
 *   reader (injectable seam; defaults to the on-disk reader).
 * @param {{ warn?: (msg: string) => void }} [params.logger] logger for the drop
 *   record (defaults to {@link Logger}).
 * @returns {{
 *   payload: string,
 *   includedLenses: string[],
 *   droppedLenses: string[],
 *   matchedLenses: string[],
 *   estimatedTokens: number,
 *   tokenBudget: number,
 * }}
 */
export function buildChecklistPayload({
  footprint,
  tokenBudget = DEFAULT_CHECKLIST_TOKEN_BUDGET,
  rules,
  resolveTier,
  readChecklist = readChecklistFile,
  logger = Logger,
} = {}) {
  const resolvedRules = rules ?? readAuditRules();
  const matchedLenses = matchLocalLenses({
    footprint,
    rules: resolvedRules,
    resolveTier,
  });

  const includedLenses = [];
  const droppedLenses = [];
  const sections = [];
  let payload = '';

  for (let i = 0; i < matchedLenses.length; i++) {
    const lens = matchedLenses[i];
    const content = readChecklist(lens);
    if (content == null) {
      // Matched a lens with no committed checklist artifact — skip it (never a
      // budget drop). The generator keeps every lens's checklist in tree, so
      // this only trips on drift, which we surface rather than swallow.
      logger?.warn?.(
        `[checklist-threading] no checklist artifact for matched local lens '${lens}' — skipping`,
      );
      continue;
    }

    const trimmed = content.trim();
    const candidate = [...sections, trimmed].join(SECTION_SEPARATOR);
    if (estimateTokens(candidate) > tokenBudget) {
      // Deterministic prefix truncation: this lens and every remaining matched
      // lens are dropped, keeping the payload within budget.
      droppedLenses.push(...matchedLenses.slice(i));
      break;
    }

    sections.push(trimmed);
    includedLenses.push(lens);
    payload = candidate;
  }

  if (droppedLenses.length > 0) {
    logger?.warn?.(
      `[checklist-threading] token budget ${tokenBudget} exceeded — dropped ` +
        `${droppedLenses.length} footprint-matched local-lens checklist(s): ` +
        `${droppedLenses.join(', ')}`,
    );
  }

  return {
    payload,
    includedLenses,
    droppedLenses,
    matchedLenses,
    estimatedTokens: estimateTokens(payload),
    tokenBudget,
  };
}
