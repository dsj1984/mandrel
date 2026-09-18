/**
 * Gherkin scenario index for `/mandrel-plan`, so planned ACs can be matched
 * against existing scenarios. A cheap regex pass, not a full AST; matching is
 * keyword-based (not embeddings) so re-planning is deterministic.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { Logger } from './Logger.js';

/**
 * Unreadable directories are skipped, never thrown.
 *
 * @param {string[]} roots
 * @param {{ logger?: { debug: Function } }} [opts]
 * @returns {string[]}
 */
export function listFeatureFiles(roots, opts = {}) {
  const logger = opts.logger ?? Logger;
  const out = [];
  for (const root of roots ?? []) {
    walk(root, out, logger);
  }
  return out;
}

function walk(dir, acc, logger) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    logger.debug(
      `[bdd-scenario-scanner] readdir failed for ${dir}: ${err?.message ?? err}`,
    );
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, acc, logger);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!abs.toLowerCase().endsWith('.feature')) continue;
    try {
      const stat = statSync(abs);
      if (stat.size > 256 * 1024) continue; // skip obviously bogus inputs
    } catch (err) {
      logger.debug(
        `[bdd-scenario-scanner] stat failed for ${abs}: ${err?.message ?? err}`,
      );
      continue;
    }
    acc.push(abs);
  }
}

/** Kept short: under-pruning beats pruning a verb the matcher needs. */
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'be',
  'to',
  'of',
  'in',
  'on',
  'at',
  'and',
  'or',
  'with',
  'for',
  'by',
  'as',
  'that',
  'this',
  'their',
  'there',
  'it',
  'its',
  'should',
  'will',
  'has',
  'have',
  'been',
  'was',
  'were',
]);

/**
 * @param {string} text
 * @returns {string[]}
 */
export function extractOutcomeKeywords(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  return Array.from(new Set(tokens));
}

const TAG_LINE_RE = /^\s*@([\w@\s-]+)\s*$/;
const SCENARIO_LINE_RE = /^\s*Scenario(?: Outline)?\s*:\s*(.+?)\s*$/;
const THEN_LINE_RE = /^\s*(?:Then|And|But)\s+(.+?)\s*$/i;
const STEP_KEYWORD_RE = /^\s*(?:Given|When|Then|And|But|\*)\s+/i;

/**
 * Only `Then`/`And`/`But` lines feed `outcomeKeywords`; Background steps are
 * setup, not outcomes, and are excluded.
 *
 * @param {string} body
 * @returns {Array<{ scenarioTitle: string, line: number, tags: string[], outcomeKeywords: string[] }>}
 */
export function parseFeatureBody(body) {
  if (typeof body !== 'string') return [];
  const lines = body.split(/\r?\n/);
  const scenarios = [];
  let pendingTags = [];
  let current = null;
  let inBackground = false;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const tagMatch = raw.match(TAG_LINE_RE);
    if (tagMatch) {
      for (const t of tagMatch[1].split(/\s+/)) {
        if (t.length > 0) pendingTags.push(`@${t.replace(/^@/, '')}`);
      }
      continue;
    }
    if (/^\s*Background\s*:/.test(raw)) {
      inBackground = true;
      continue;
    }
    const scenarioMatch = raw.match(SCENARIO_LINE_RE);
    if (scenarioMatch) {
      if (current) scenarios.push(finalize(current));
      current = {
        scenarioTitle: scenarioMatch[1].trim(),
        line: i + 1,
        tags: pendingTags.slice(),
        thenLines: [],
      };
      pendingTags = [];
      inBackground = false;
      continue;
    }
    if (current && !inBackground) {
      const thenMatch = raw.match(THEN_LINE_RE);
      if (thenMatch) current.thenLines.push(thenMatch[1]);
    }
    // Stray tags before any scenario don't bind.
    if (current === null && STEP_KEYWORD_RE.test(raw)) {
      pendingTags = [];
    }
  }
  if (current) scenarios.push(finalize(current));
  return scenarios;
}

function finalize(scenario) {
  const kw = new Set();
  for (const line of scenario.thenLines) {
    for (const tok of extractOutcomeKeywords(line)) kw.add(tok);
  }
  return {
    scenarioTitle: scenario.scenarioTitle,
    line: scenario.line,
    tags: scenario.tags,
    outcomeKeywords: Array.from(kw).sort(),
  };
}

/**
 * @param {{ featureRoots: string[] }} opts
 * @returns {Array<{ file: string, line: number, scenarioTitle: string, tags: string[], outcomeKeywords: string[] }>}
 */
export function scanBddScenarios(opts = {}) {
  const { featureRoots = [] } = opts;
  const logger = opts.logger ?? Logger;
  const files = listFeatureFiles(featureRoots, { logger });
  const out = [];
  for (const file of files) {
    let body;
    try {
      body = readFileSync(file, 'utf8');
    } catch (err) {
      logger.debug(
        `[bdd-scenario-scanner] readFile failed for ${file}: ${err?.message ?? err}`,
      );
      continue;
    }
    const scenarios = parseFeatureBody(body);
    for (const sc of scenarios) {
      out.push({
        file,
        line: sc.line,
        scenarioTitle: sc.scenarioTitle,
        tags: sc.tags,
        outcomeKeywords: sc.outcomeKeywords,
      });
    }
  }
  return out;
}

/**
 * Shared keywords over the smaller set's size, so terse ACs are not
 * penalised against verbose scenarios.
 *
 * @param {string} acOutcome
 * @param {{ outcomeKeywords: string[] }} scenario
 * @returns {number} Score in [0, 1].
 */
export function scoreMatch(acOutcome, scenario) {
  const acTokens = new Set(extractOutcomeKeywords(acOutcome));
  const scTokens = new Set(scenario.outcomeKeywords ?? []);
  if (acTokens.size === 0 || scTokens.size === 0) return 0;
  let overlap = 0;
  for (const t of acTokens) {
    if (scTokens.has(t)) overlap += 1;
  }
  return overlap / Math.min(acTokens.size, scTokens.size);
}

/**
 * Conservative: a false match costs more than a duplicate scenario.
 *
 * @param {string} acOutcome
 * @param {Array<{ outcomeKeywords: string[] }>} scenarios
 * @param {{ minScore?: number }} [opts]
 * @returns {{ scenario: object, score: number } | null}
 */
export function findBestScenarioMatch(acOutcome, scenarios, opts = {}) {
  const minScore = opts.minScore ?? 0.5;
  let best = null;
  for (const sc of scenarios ?? []) {
    const score = scoreMatch(acOutcome, sc);
    if (score >= minScore && (best === null || score > best.score)) {
      best = { scenario: sc, score };
    }
  }
  return best;
}
