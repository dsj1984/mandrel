/**
 * resolve-selection.js — scenario-selection resolver for the agent-driven
 * QA harness (Epic #3214, Story #3296).
 *
 * The harness is invoked with a single selector that scopes a sweep to a
 * concrete set of `.feature` files (and, for tag selectors, the specific
 * scenarios within them) under the contract's `featureRoot`. This module
 * turns one of three selector shapes into that concrete set:
 *
 *   - **feature id** — `{ kind: 'feature', id: 'login' }` resolves to the
 *     single `.feature` file whose path stem (basename without the
 *     `.feature` extension) equals the id, or whose `featureRoot`-relative
 *     POSIX path (with or without the extension) equals the id. Matching is
 *     exact and case-insensitive; ambiguous ids (more than one match) throw.
 *
 *   - **tag expression** — `{ kind: 'tag', expression: '@smoke and not @wip' }`
 *     resolves to the scenario set whose tag list satisfies the boolean
 *     expression. The expression grammar is the cucumber-common subset:
 *     `@tag` atoms, `and` / `or` / `not` operators (case-insensitive), and
 *     parentheses. A scenario inherits no implicit tags; only the tags the
 *     scanner attached to it (feature-level + scenario-level, as collected
 *     by `parseFeatureBody`) participate.
 *
 *   - **domain** — `{ kind: 'domain', name: 'billing' }` resolves to every
 *     scenario under the `featureRoot`-relative subdirectory `name`. A
 *     domain is a first-level (or nested) directory grouping beneath the
 *     feature root; the selector matches any scenario whose file lives at
 *     or below `<featureRoot>/<name>/`.
 *
 * Determinism is load-bearing — the QA harness re-runs the same selector
 * across sweeps and must scope the identical scenario set each time. All
 * outputs are sorted by `(file, line)` so the order never depends on
 * filesystem iteration order.
 *
 * This module is pure resolution: it does no browser work, reads no config
 * beyond the `featureRoot` passed in, and never mutates state. The harness
 * workflow (Story #3297) consumes the resolved set; this layer only answers
 * "which scenarios does this selector name?".
 */

import path from 'node:path';

import { listFeatureFiles, scanBddScenarios } from '../bdd-scenario-scanner.js';

/**
 * Normalise a path to POSIX separators so `featureRoot`-relative matching
 * behaves identically on Windows and POSIX hosts.
 *
 * @param {string} p
 * @returns {string}
 */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Compute a scenario's `featureRoot`-relative POSIX path. Used by the
 * feature-id and domain matchers so selectors are written against the
 * stable, repo-relative shape rather than absolute worktree paths.
 *
 * @param {string} featureRoot - Absolute path to the feature root.
 * @param {string} file - Absolute path to a `.feature` file.
 * @returns {string} POSIX-style path relative to `featureRoot`.
 */
function relFromRoot(featureRoot, file) {
  return toPosix(path.relative(featureRoot, file));
}

/**
 * Strip the trailing `.feature` extension (case-insensitive) from a
 * relative path, leaving the path stem the feature-id selector matches on.
 *
 * @param {string} relPath
 * @returns {string}
 */
function stripFeatureExt(relPath) {
  return relPath.replace(/\.feature$/i, '');
}

// ---------------------------------------------------------------------------
// Tag-expression evaluation
// ---------------------------------------------------------------------------

/**
 * Classify a single matched lexeme into a token. `@tag` atoms keep their
 * raw value; `(` / `)` / `and` / `or` / `not` produce structural tokens.
 * Anything else is a malformed expression and throws.
 *
 * @param {string} raw
 * @returns {{ type: string, value?: string }}
 */
function classifyToken(raw) {
  if (raw === '(' || raw === ')') {
    return { type: raw };
  }
  if (raw.startsWith('@')) {
    return { type: 'tag', value: raw };
  }
  const lower = raw.toLowerCase();
  if (lower === 'and' || lower === 'or' || lower === 'not') {
    return { type: lower };
  }
  throw new Error(
    `[resolve-selection] unknown operator "${raw}" in tag expression`,
  );
}

/**
 * Tokenise a cucumber-style tag expression into a flat token stream.
 * Recognised tokens: `(`, `)`, `and`, `or`, `not`, and `@tag` atoms.
 * Whitespace separates tokens; parentheses need no surrounding space.
 *
 * @param {string} expression
 * @returns {Array<{ type: string, value?: string }>}
 */
function tokenizeTagExpression(expression) {
  const tokens = [];
  const re = /\s*(\(|\)|@[\w-]+|[A-Za-z]+)/g;
  let lastIndex = 0;
  for (
    let match = re.exec(expression);
    match !== null;
    match = re.exec(expression)
  ) {
    // Guard against runs of unmatched garbage between tokens.
    const between = expression.slice(lastIndex, match.index).trim();
    if (between.length > 0) {
      throw new Error(
        `[resolve-selection] unexpected token "${between}" in tag expression`,
      );
    }
    lastIndex = re.lastIndex;
    tokens.push(classifyToken(match[1]));
  }
  const tail = expression.slice(lastIndex).trim();
  if (tail.length > 0) {
    throw new Error(
      `[resolve-selection] unexpected token "${tail}" in tag expression`,
    );
  }
  return tokens;
}

/**
 * Recursive-descent parser for the tag-expression grammar:
 *
 *   expr   := term  ( 'or'  term  )*
 *   term   := factor( 'and' factor)*
 *   factor := 'not' factor | '(' expr ')' | tag
 *
 * Produces a predicate `(tagSet: Set<string>) => boolean`. Tag atoms match
 * case-insensitively against the scenario's tag set (which carries the
 * leading `@`).
 *
 * @param {string} expression
 * @returns {(tags: Set<string>) => boolean}
 */
export function parseTagExpression(expression) {
  if (typeof expression !== 'string' || expression.trim().length === 0) {
    throw new Error(
      '[resolve-selection] tag expression must be a non-empty string',
    );
  }
  const tokens = tokenizeTagExpression(expression);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr() {
    let left = parseTerm();
    while (peek() && peek().type === 'or') {
      next();
      const right = parseTerm();
      const l = left;
      left = (tags) => l(tags) || right(tags);
    }
    return left;
  }

  function parseTerm() {
    let left = parseFactor();
    while (peek() && peek().type === 'and') {
      next();
      const right = parseFactor();
      const l = left;
      left = (tags) => l(tags) && right(tags);
    }
    return left;
  }

  function parseFactor() {
    const tok = peek();
    if (!tok) {
      throw new Error('[resolve-selection] unexpected end of tag expression');
    }
    if (tok.type === 'not') {
      next();
      const operand = parseFactor();
      return (tags) => !operand(tags);
    }
    if (tok.type === '(') {
      next();
      const inner = parseExpr();
      const close = next();
      if (!close || close.type !== ')') {
        throw new Error('[resolve-selection] missing closing parenthesis');
      }
      return inner;
    }
    if (tok.type === 'tag') {
      next();
      const wanted = tok.value.toLowerCase();
      return (tags) => tags.has(wanted);
    }
    throw new Error(
      `[resolve-selection] unexpected token "${tok.type}" in tag expression`,
    );
  }

  const predicate = parseExpr();
  if (pos !== tokens.length) {
    throw new Error('[resolve-selection] trailing tokens in tag expression');
  }
  return predicate;
}

/**
 * Build a lower-cased tag `Set` for a scanned scenario so the predicate can
 * test membership case-insensitively.
 *
 * @param {{ tags?: string[] }} scenario
 * @returns {Set<string>}
 */
function tagSetOf(scenario) {
  return new Set((scenario.tags ?? []).map((t) => t.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Public resolver
// ---------------------------------------------------------------------------

/**
 * Sort scanned scenarios deterministically by `(file, line)`.
 *
 * @param {Array<{ file: string, line: number }>} scenarios
 * @returns {Array<object>}
 */
function sortScenarios(scenarios) {
  return scenarios
    .slice()
    .sort((a, b) =>
      a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
    );
}

/**
 * Resolve a selector into a concrete scenario set under `featureRoot`.
 *
 * @param {object} args
 * @param {string} args.featureRoot - Absolute path to the contract's
 *   `.feature` root. The harness prefers the `qa.featureRoot` contract
 *   value over auto-detection; this resolver takes it as given.
 * @param {object} args.selector - One of the three selector shapes:
 *   `{ kind: 'feature', id }`, `{ kind: 'tag', expression }`, or
 *   `{ kind: 'domain', name }`.
 * @param {{ logger?: object }} [opts]
 * @returns {{ kind: string, featureRoot: string, files: string[], scenarios: Array<object> }}
 *   `files` is the deduped, sorted set of absolute `.feature` paths the
 *   selection touches; `scenarios` is the sorted scenario rows (for tag
 *   selection it is the satisfying subset, for feature/domain it is every
 *   scenario in the matched files).
 */
export function resolveSelection(args = {}, opts = {}) {
  const { featureRoot, selector } = args;
  if (typeof featureRoot !== 'string' || featureRoot.length === 0) {
    throw new Error('[resolve-selection] featureRoot is required');
  }
  if (!selector || typeof selector !== 'object') {
    throw new Error('[resolve-selection] selector is required');
  }

  switch (selector.kind) {
    case 'feature':
      return resolveFeature(featureRoot, selector, opts);
    case 'tag':
      return resolveTag(featureRoot, selector, opts);
    case 'domain':
      return resolveDomain(featureRoot, selector, opts);
    default:
      throw new Error(
        `[resolve-selection] unknown selector kind "${selector.kind}"`,
      );
  }
}

function resolveFeature(featureRoot, selector, opts) {
  const id = selector.id;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error(
      '[resolve-selection] feature selector requires a non-empty id',
    );
  }
  const want = stripFeatureExt(toPosix(id.trim())).toLowerCase();
  const files = listFeatureFiles([featureRoot], opts);
  const matched = files.filter((file) => {
    const rel = relFromRoot(featureRoot, file);
    const relStem = stripFeatureExt(rel).toLowerCase();
    const baseStem = stripFeatureExt(path.basename(rel)).toLowerCase();
    return relStem === want || baseStem === want;
  });
  if (matched.length === 0) {
    throw new Error(
      `[resolve-selection] no .feature file matched feature id "${id}" under ${featureRoot}`,
    );
  }
  if (matched.length > 1) {
    throw new Error(
      `[resolve-selection] feature id "${id}" is ambiguous; matched ${matched.length} files: ${matched
        .map((f) => relFromRoot(featureRoot, f))
        .join(', ')}. Qualify with a featureRoot-relative path.`,
    );
  }
  const all = scanBddScenarios({ featureRoots: [featureRoot], ...opts });
  const scenarios = sortScenarios(all.filter((s) => s.file === matched[0]));
  return {
    kind: 'feature',
    featureRoot,
    files: matched,
    scenarios,
  };
}

function resolveTag(featureRoot, selector, opts) {
  const predicate = parseTagExpression(selector.expression);
  const all = scanBddScenarios({ featureRoots: [featureRoot], ...opts });
  const scenarios = sortScenarios(all.filter((s) => predicate(tagSetOf(s))));
  const files = Array.from(new Set(scenarios.map((s) => s.file))).sort();
  return {
    kind: 'tag',
    featureRoot,
    files,
    scenarios,
  };
}

function resolveDomain(featureRoot, selector, opts) {
  const name = selector.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error(
      '[resolve-selection] domain selector requires a non-empty name',
    );
  }
  // Normalise to a trailing-slash POSIX prefix so "billing" matches
  // "billing/checkout.feature" but not "billing-archive/x.feature".
  const prefix = `${toPosix(name.trim()).replace(/\/+$/, '')}/`;
  const all = scanBddScenarios({ featureRoots: [featureRoot], ...opts });
  const scenarios = sortScenarios(
    all.filter((s) => relFromRoot(featureRoot, s.file).startsWith(prefix)),
  );
  if (scenarios.length === 0) {
    throw new Error(
      `[resolve-selection] no scenarios found under domain "${name}" in ${featureRoot}`,
    );
  }
  const files = Array.from(new Set(scenarios.map((s) => s.file))).sort();
  return {
    kind: 'domain',
    featureRoot,
    files,
    scenarios,
  };
}
