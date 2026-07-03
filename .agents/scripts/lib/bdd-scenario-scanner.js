/**
 * bdd-scenario-scanner.js — Gherkin scenario index for /plan Phase 7.
 *
 * Story #2637 (sibling to #2634 codebase-snapshot, #2635 spec-freshness,
 * #2636 file-assumption gate). The Acceptance Engineer step of
 * `epic-plan-spec-author` currently writes ACs from Epic/Tech Spec narrative
 * alone — it never inspects the consumer project's existing `.feature`
 * files. Planned ACs frequently duplicate scenarios that already exist or
 * re-specify behaviour the codebase already proves; the duplication is
 * only discovered (at best) during `/deliver` or (at worst) after
 * a redundant PR ships.
 *
 * `scanBddScenarios` walks every configured feature root, parses each
 * `.feature` file with a Gherkin-aware regex pass (deliberately not a
 * full Gherkin AST — keep the scanner cheap and dependency-free), and
 * returns one entry per scenario with its file path, line number,
 * scenario title, tag list, and an extracted set of outcome keywords
 * (action verb + objects from the "Then" clauses). The keyword set is
 * the fuzzy-match surface the planner uses to spot ACs that already
 * have a matching scenario.
 *
 * Determinism is load-bearing: the matcher is keyword-based, not
 * embedding-based, so re-running `/plan` against the same
 * acceptance spec produces the same disposition annotations.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { Logger } from './Logger.js';

/**
 * Recursively list every file with a `.feature` extension under one of
 * the given roots. Returns absolute paths; never throws on permission
 * errors — unreadable directories are simply skipped.
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

/**
 * English stop words that carry no outcome semantics. Stripped from
 * extracted keywords so "the invoice appears in the outbox" reduces to
 * `{invoice, appears, outbox}` rather than including `{the, in}`.
 *
 * Kept short on purpose — false-negative pruning here is preferable to
 * over-pruning a verb the matcher needs.
 */
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
 * Reduce a free-text outcome ("the invoice appears in the outbox") to a
 * deterministic, lower-case keyword set ("invoice", "appears", "outbox").
 * Words of length 1 are dropped; common stop words are filtered.
 *
 * Exported so the matcher and downstream tests can share the exact
 * tokenisation contract.
 *
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
 * Parse a single `.feature` file body into an array of scenario rows.
 * The parser is deliberately minimal:
 *
 *   - `@tag` lines preceding a `Scenario:` are attached to that scenario.
 *   - `Scenario:` and `Scenario Outline:` both produce a row.
 *   - `Then` / `And` / `But` lines following the scenario (until the
 *     next scenario or EOF) feed the `outcomeKeywords` set.
 *
 * The Background block is recognised but its steps are NOT folded into
 * outcomeKeywords — Background carries setup, not outcomes.
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
    // Reset pendingTags when a step keyword in the body appears with no
    // scenario yet — stray tags before a Feature: header don't bind.
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
 * Scan every `.feature` file under the configured feature roots and
 * return the full scenario index. Each row carries the absolute path,
 * the 1-based line number of the `Scenario:` keyword, the title, the
 * tag list, and the deterministic outcome-keyword set. Returns an
 * empty array when no roots exist or no scenarios are found — the
 * caller (the spec-author skill) uses emptiness to know the project
 * hasn't adopted BDD, no warning required.
 *
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
 * Score the overlap between an acceptance criterion's outcome string
 * and a scenario's outcome-keyword set. The score is the count of
 * keywords the AC outcome shares with the scenario, normalised by the
 * smaller of the two sets so single-word ACs aren't penalised against
 * verbose scenarios (and vice versa).
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
 * Find the best matching scenario for one AC outcome string, if any.
 * Returns `null` when no scenario scores above `minScore` (default
 * `0.5`). The matcher is intentionally conservative — false positives
 * cost the planner more (rewriting the spec to "refine" a scenario
 * that doesn't actually exist) than false negatives (writing a new
 * scenario the operator can later dedupe).
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
