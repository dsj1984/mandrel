/**
 * Write-time checklists for LOCAL lenses matching a predicted footprint,
 * under a token budget. Not `selectAudits`: this must stay a pure function of
 * footprint + on-disk files — no git, provider, or network (tested).
 */

import fs from 'node:fs';
import path from 'node:path';
import { AUDIT_LENSES } from '../audit-to-stories/audit-lenses.js';
import { getPaths, PROJECT_ROOT, resolveConfig } from '../config-resolver.js';
import { Logger } from '../Logger.js';
import {
  changeSetLacksSiblingTest,
  matchesAnyFilePattern,
  resolveLensTier,
} from './selector.js';

/**
 * ~4 chars per token; what matters is that payload and cap agree on one number.
 *
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

/**
 * Safety ceiling, not a routine squeeze: all seven local lenses together fit.
 */
export const DEFAULT_CHECKLIST_TOKEN_BUDGET = 4000;

const SECTION_SEPARATOR = '\n\n';

/**
 * Manifest key for a bare taxonomy lens name (`clean-code` → `audit-clean-code`).
 *
 * @param {string} lens
 * @returns {string}
 */
function lensKeyFor(lens) {
  return `audit-${lens}`;
}

/**
 * `<agentRoot>/audit-checklists`, honouring a relocated agent root.
 *
 * @param {object} [config]
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
 * Parse `audit-rules.json` from the configured `schemasRoot`.
 *
 * @param {object} [config]
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
 * @param {object} rules parsed `audit-rules.json`.
 * @param {string} lens canonical lens name.
 * @returns {string[]}
 */
function filePatternsFor(rules, lens) {
  return rules?.audits?.[lensKeyFor(lens)]?.triggers?.filePatterns ?? [];
}

/**
 * @param {object} rules parsed `audit-rules.json`.
 * @param {string} lens canonical lens name.
 * @returns {object|undefined}
 */
function triggerFor(rules, lens) {
  return rules?.audits?.[lensKeyFor(lens)]?.triggers;
}

/**
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
 * LOCAL lenses matching the footprint, in {@link AUDIT_LENSES} order. A lens
 * whose tier cannot be resolved is skipped rather than failing the selection.
 *
 * @param {object} params
 * @param {string[]} params.footprint predicted footprint path list.
 * @param {object} [params.rules] parsed `audit-rules.json`.
 * @param {(lens: string) => string} [params.resolveTier]
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
    // Same sibling-test predicate as the selector: a source change without a
    // test gets the quality checklist up front.
    const siblingMatch =
      triggerFor(rules, lens)?.sourceWithoutSiblingTest === true &&
      changeSetLacksSiblingTest(paths);
    if (fileMatch || siblingMatch) matched.push(lens);
  }
  return matched;
}

/**
 * @param {string} lens
 * @param {object} [config]
 * @returns {string|null} `null` when the checklist artifact is absent
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
 * Prefix truncation: the first overflowing lens and all later ones are
 * dropped and logged.
 *
 * @param {object} params
 * @param {string[]} params.footprint predicted footprint path list.
 * @param {number} [params.tokenBudget]
 * @param {object} [params.rules] parsed `audit-rules.json`.
 * @param {(lens: string) => string} [params.resolveTier]
 * @param {(lens: string) => (string|null)} [params.readChecklist]
 * @param {{ warn?: (msg: string) => void }} [params.logger]
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
      // Missing artifact is drift, not a budget drop: surface and skip.
      logger?.warn?.(
        `[checklist-threading] no checklist artifact for matched local lens '${lens}' — skipping`,
      );
      continue;
    }

    const trimmed = content.trim();
    const candidate = [...sections, trimmed].join(SECTION_SEPARATOR);
    if (estimateTokens(candidate) > tokenBudget) {
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
