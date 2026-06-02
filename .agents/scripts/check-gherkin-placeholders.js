#!/usr/bin/env node

// .agents/scripts/check-gherkin-placeholders.js
//
// Story #3426 (Epic #3418) — Gherkin placeholder-reference lint validator.
//
// Scans every `*.feature` file under the canonical BDD roots
// (`tests/features/**` by default) and validates that every
// `Scenario Outline` `<placeholder>` is actually consumed by the
// assertion of the step definition it binds to. A placeholder that is
// declared in the Examples header and threaded through a step's prose but
// whose bound step definition never references the captured parameter is a
// tautological test — the Examples column varies but the assertion ignores
// it, so every row passes vacuously. This validator flags that gap.
//
// The detection model:
//
//   1. Parse each `.feature` file into Scenario Outline blocks. For each
//      Outline, collect the set of `<placeholder>` tokens that appear in
//      its steps and the column headers declared in its `Examples` table.
//      Only placeholders that are BOTH used in a step and declared as an
//      Examples column are in scope (a `<placeholder>` with no Examples
//      column is a separate authoring error out of this check's lane).
//
//   2. For each Outline step containing a placeholder, resolve the bound
//      step definition by matching the step text (with `<placeholder>`
//      tokens collapsed to a sentinel) against the step-definition patterns
//      discovered in the steps tree (`tests/steps/**` by default). The step
//      definition's named parameters are the channel through which an
//      Examples value reaches an assertion.
//
//   3. A placeholder is "consumed" when its bound step definition's body
//      references the parameter that carries it — i.e. the step-def
//      function reads the captured argument inside an assertion (and is not
//      a tautological no-op such as `expect(true).toBe(true)`). A
//      placeholder that threads only into a step whose definition ignores
//      the captured value is flagged.
//
// This mirrors `.agents/scripts/check-doc-links.js`: same fence-masking of
// non-Gherkin regions, same per-file violation-collecting shape
// (`{ file, line, kind, message }`), same `{ exitCode, violations,
// scanned }` programmatic return, and the same CLI exit-code contract.
//
// Exit codes:
//   0  every Scenario-Outline placeholder is consumed by its bound step
//      definition's assertion.
//   1  at least one placeholder is unconsumed (tautological); details are
//      written to stderr (file:line).
//
// Helpers are intentionally inlined per the sibling validator's design
// constraint.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// --- Static config ---------------------------------------------------------

// Canonical BDD roots, repo-root-relative. `tests/features` holds the
// `.feature` scenarios; `tests/steps` holds the step-definition library.
// Mirrors the layout in `.agents/rules/testing-standards.md` and the
// `gherkin-authoring` skill.
export const DEFAULT_FEATURE_ROOTS = ['tests/features'];
export const DEFAULT_STEP_ROOTS = ['tests/steps'];

// Step-definition source extensions to scan.
const STEP_DEF_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

// --- File discovery --------------------------------------------------------

function walkFiles(dirAbs, predicate, out) {
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch (_err) {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walkFiles(abs, predicate, out);
    } else if (entry.isFile() && predicate(entry.name)) {
      out.push(abs);
    }
  }
}

export function discoverFeatures(rootAbs, featureRoots) {
  const out = [];
  for (const sub of featureRoots) {
    const subAbs = path.join(rootAbs, sub);
    if (fs.existsSync(subAbs)) {
      walkFiles(subAbs, (name) => name.endsWith('.feature'), out);
    }
  }
  out.sort();
  return out;
}

export function discoverStepDefs(rootAbs, stepRoots) {
  const out = [];
  for (const sub of stepRoots) {
    const subAbs = path.join(rootAbs, sub);
    if (fs.existsSync(subAbs)) {
      walkFiles(
        subAbs,
        (name) => STEP_DEF_EXTENSIONS.has(path.extname(name)),
        out,
      );
    }
  }
  out.sort();
  return out;
}

// --- Region masking --------------------------------------------------------

// Returns a copy of `source` where the contents of every fenced doc-string
// region (Gherkin triple-quote or triple-backtick) are replaced by blank
// lines. Newlines are preserved so downstream line numbers stay aligned.
// This prevents prose inside a doc-string argument from being parsed as
// steps or placeholders.
export function maskDocStrings(source) {
  const lines = source.split('\n');
  const out = new Array(lines.length);
  let inDoc = false;
  let marker = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^(\s*)("""|```|~~~)/);
    if (inDoc) {
      out[i] = '';
      if (fenceMatch && fenceMatch[2] === marker) {
        inDoc = false;
        marker = '';
      }
      continue;
    }
    if (fenceMatch) {
      inDoc = true;
      marker = fenceMatch[2];
      out[i] = '';
      continue;
    }
    out[i] = line;
  }
  return out.join('\n');
}

// --- Feature parsing -------------------------------------------------------

const PLACEHOLDER_RE = /<([^<>]+)>/g;

export function extractPlaceholders(text) {
  const out = [];
  PLACEHOLDER_RE.lastIndex = 0;
  let m;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

// A step keyword line: Given / When / Then / And / But / *.
const STEP_LINE_RE = /^\s*(Given|When|Then|And|But|\*)\s+(.*\S)\s*$/;

// Parse a masked `.feature` source into an array of Scenario Outline blocks.
// Each block: { line, steps: [{ line, text }], exampleHeaders: Set<string> }.
// Only `Scenario Outline:` blocks are returned; plain `Scenario:` blocks are
// ignored because they cannot carry `<placeholders>`.
export function parseOutlines(masked) {
  const lines = masked.split('\n');
  const outlines = [];
  let current = null;
  let inExamples = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    const trimmed = raw.trim();

    if (/^Scenario Outline:/i.test(trimmed)) {
      current = { line: lineNo, steps: [], exampleHeaders: new Set() };
      outlines.push(current);
      inExamples = false;
      continue;
    }

    // A new Scenario / Feature / Background / Rule ends the current outline's
    // step-collection scope.
    if (
      /^(Scenario:|Feature:|Background:|Rule:|Scenario Template:)/i.test(
        trimmed,
      )
    ) {
      current = null;
      inExamples = false;
      continue;
    }

    if (!current) continue;

    if (/^(Examples|Scenarios):/i.test(trimmed)) {
      inExamples = true;
      continue;
    }

    if (inExamples) {
      // The first non-blank table row inside an Examples block is the header.
      if (trimmed.startsWith('|') && current.exampleHeaders.size === 0) {
        const cells = trimmed
          .split('|')
          .map((c) => c.trim())
          .filter((c) => c.length > 0);
        for (const cell of cells) current.exampleHeaders.add(cell);
      }
      continue;
    }

    const stepMatch = raw.match(STEP_LINE_RE);
    if (stepMatch) {
      current.steps.push({ line: lineNo, text: stepMatch[2].trim() });
    }
  }

  return outlines;
}

// --- Step-definition indexing ----------------------------------------------

// Extract step-definition entries from a step-def source file. Each entry:
//   { pattern: RegExp, paramNames: string[], body: string }
//
// We support the two dominant authoring styles:
//   - Cucumber-expression strings: Given('the {actor} has {int} invoices', fn)
//     {name} tokens become capture groups; `paramNames` records the names.
//   - Regular-expression literals: Given(/^the (.+) has (\d+)/, fn)
//     numbered capture groups; `paramNames` records `$1`, `$2`, ... markers.
//
// The body is the text of the handler function (best-effort), used to decide
// whether a captured parameter is referenced by the assertion.
export function parseStepDefs(source) {
  const defs = [];
  const callRe =
    /\b(Given|When|Then|And|But|defineStep|Step)\s*\(\s*(['"`]|\/)/g;
  let m;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((m = callRe.exec(source)) !== null) {
    const opener = m[2];
    const patStart = m.index + m[0].length - opener.length;
    const parsed =
      opener === '/'
        ? readRegexLiteral(source, patStart)
        : readStringLiteral(source, patStart, opener);
    if (!parsed) continue;

    const { raw: patternRaw, end: patternEnd } = parsed;
    const handlerParams = readHandlerParams(source, patternEnd);
    const body = readHandlerBody(source, patternEnd);
    const built =
      opener === '/'
        ? buildFromRegex(patternRaw)
        : buildFromExpression(patternRaw);
    if (!built) continue;
    defs.push({ ...built, handlerParams, body });
  }
  return defs;
}

// Read the handler's formal parameter names from the function expression that
// follows the step pattern. Supports arrow functions (`(a, b) => {`,
// `a => {`) and classic functions (`function (a, b) {`). Returns the ordered
// list of bare identifier parameter names (skipping destructured/rest forms
// we cannot map positionally). Capture group N binds to handler param N, so
// this list is the channel from an Examples value to an assertion.
function readHandlerParams(source, patternEnd) {
  // Skip the comma + whitespace separating the pattern from the handler.
  const rest = source.slice(patternEnd, patternEnd + 400);
  // `function name? ( ... )` or `( ... ) =>` or `singleArg =>`.
  let sigMatch = rest.match(
    /^\s*,\s*(?:async\s+)?function\s*\w*\s*\(([^)]*)\)/,
  );
  if (!sigMatch) sigMatch = rest.match(/^\s*,\s*(?:async\s+)?\(([^)]*)\)\s*=>/);
  if (!sigMatch) {
    const single = rest.match(/^\s*,\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/);
    if (single) return [single[1]];
    return [];
  }
  return sigMatch[1]
    .split(',')
    .map((p) => p.trim())
    .filter((p) => /^[A-Za-z_$][\w$]*$/.test(p));
}

// Read a quoted string literal starting at `start` (pointing at the opening
// quote). Returns { raw, end } where `raw` excludes the quotes and `end` is
// the index just past the closing quote.
function readStringLiteral(source, start, quote) {
  let i = start + 1;
  let out = '';
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      out += source[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (ch === quote) return { raw: out, end: i + 1 };
    out += ch;
    i++;
  }
  return null;
}

// Read a regex literal starting at `start` (pointing at the opening slash).
function readRegexLiteral(source, start) {
  let i = start + 1;
  let out = '';
  let inClass = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      out += ch + (source[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) return { raw: out, end: i + 1 };
    else if (ch === '\n') return null;
    out += ch;
    i++;
  }
  return null;
}

// Read the handler body text following the pattern. Best-effort: from the
// first `{` after the pattern to its matching `}`. Falls back to a bounded
// window when no brace block is found (e.g. arrow shorthand).
function readHandlerBody(source, patternEnd) {
  const braceIdx = source.indexOf('{', patternEnd);
  const window = source.slice(patternEnd, patternEnd + 4000);
  if (braceIdx === -1 || braceIdx > patternEnd + 400) {
    // Arrow shorthand `(...) => expr` — return the bounded window.
    return window;
  }
  let depth = 0;
  for (let i = braceIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(braceIdx, i + 1);
    }
  }
  return source.slice(braceIdx);
}

// Build a matcher from a Cucumber-expression string. {name} parameter tokens
// become capture groups; the surrounding literal text is escaped.
function buildFromExpression(expr) {
  const paramNames = [];
  let pattern = '^';
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === '{') {
      const close = expr.indexOf('}', i);
      if (close === -1) {
        pattern += escapeRegex(ch);
        i++;
        continue;
      }
      const name = expr.slice(i + 1, close).trim();
      paramNames.push(name || `arg${paramNames.length + 1}`);
      pattern += '(.+?)';
      i = close + 1;
      continue;
    }
    if (ch === '(' && expr[i + 1] === ')') {
      // Optional-text cucumber syntax `text(s)` — make the preceding char
      // optional.
      i += 2;
      pattern += '?';
      continue;
    }
    pattern += escapeRegex(ch);
    i++;
  }
  pattern += '$';
  let re;
  try {
    re = new RegExp(pattern);
  } catch (_err) {
    return null;
  }
  return { pattern: re, paramNames };
}

// Build a matcher from a regex-literal step. Numbered capture groups map to
// positional parameter markers `$1`, `$2`, ...
function buildFromRegex(regexSrc) {
  let re;
  try {
    re = new RegExp(regexSrc);
  } catch (_err) {
    return null;
  }
  const groupCount = countCaptureGroups(regexSrc);
  const paramNames = [];
  for (let n = 1; n <= groupCount; n++) paramNames.push(`$${n}`);
  return { pattern: re, paramNames };
}

function countCaptureGroups(regexSrc) {
  let count = 0;
  let inClass = false;
  for (let i = 0; i < regexSrc.length; i++) {
    const ch = regexSrc[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '(' && !inClass) {
      // Skip non-capturing `(?:` and lookarounds `(?=` `(?!` `(?<=` `(?<!`.
      if (regexSrc[i + 1] === '?' && regexSrc[i + 2] !== '<') continue;
      if (
        regexSrc[i + 1] === '?' &&
        regexSrc[i + 2] === '<' &&
        (regexSrc[i + 3] === '=' || regexSrc[i + 3] === '!')
      ) {
        continue;
      }
      count++;
    }
  }
  return count;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Step binding ----------------------------------------------------------

// Build the literal step text a step definition would see at runtime, with
// each `<placeholder>` substituted by a unique alphanumeric sentinel token.
// Returns the substituted text plus the ordered placeholder names so we can
// recover which placeholder fell into which capture group. The sentinel is a
// bare word chosen to survive cucumber-expression and regex-literal matching
// without introducing characters a pattern might treat specially.
const STANDIN_PREFIX = 'zphz';
const STANDIN_SUFFIX = 'zqz';
const STANDIN_RECOVER_RE = new RegExp(
  `${STANDIN_PREFIX}(\\d+)${STANDIN_SUFFIX}`,
);

export function substitutePlaceholders(stepText) {
  const order = [];
  const substituted = stepText.replace(PLACEHOLDER_RE, (_full, name) => {
    const token = `${STANDIN_PREFIX}${order.length}${STANDIN_SUFFIX}`;
    order.push(name.trim());
    return token;
  });
  return { substituted, order };
}

// Detect whether a step-definition body references a given parameter name —
// i.e. whether the captured Examples value reaches an assertion at all.
//
// The signal is deliberately simple and conservative: the parameter
// identifier (named cucumber parameter, e.g. `expectedOutcome`) or the
// positional capture marker (regex capture, e.g. `$1`) must appear as a
// referenced identifier inside the handler body. A tautological step
// definition — `() => { expect(true).toBe(true); }` or
// `(role) => { /* no-op */ }` — never references its captured parameter, so
// it is flagged. A genuine assertion that compares the captured value
// against observed state references the parameter and passes.
//
// For positional regex captures the handler's formal parameter name is not
// recoverable from the pattern alone, so we instead require that the handler
// reads SOME argument value in an assertion (`bodyReadsAnyArgument`).
export function bodyReferencesParam(body, paramName) {
  if (!body) return false;
  if (paramName.startsWith('$')) {
    return bodyReadsAnyArgument(body);
  }
  const re = new RegExp(`(?<![\\w$])${escapeRegex(paramName)}(?![\\w$])`);
  return re.test(body);
}

// Heuristic for positional (regex) captures: does the handler read any
// non-constant value inside an assertion? A tautological body asserts only
// over literals (`true`, numbers, strings), so stripping those and finding a
// remaining identifier inside an `expect(...)` / `assert(...)` call proves
// the handler consumes an argument.
export function bodyReadsAnyArgument(body) {
  if (!body) return false;
  // Strip literal arguments so a tautology over constants leaves empty call
  // parentheses.
  const stripped = body
    .replace(/\b(true|false|null|undefined)\b/g, '')
    .replace(/\b\d+(\.\d+)?\b/g, '')
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '');
  // Find each `expect(...)` / `assert*(...)` call and look for an identifier
  // INSIDE its argument list (not the matcher method name itself).
  const callRe = /(expect|assert(?:\.\w+)?)\s*\(([^)]*)\)/g;
  let m;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((m = callRe.exec(stripped)) !== null) {
    if (/[A-Za-z_$][\w$]*/.test(m[2])) return true;
  }
  return false;
}

// --- Step binding resolution -----------------------------------------------

// Resolve a single Outline step to its bound step definition and map each
// placeholder to the capture-group parameter it lands in. Returns
// { def, captures: [{ placeholder, paramName }] } or null when unresolved.
export function resolveBinding(stepText, stepDefs) {
  const { substituted, order } = substitutePlaceholders(stepText);
  if (order.length === 0) return null;

  for (const def of stepDefs) {
    const m = def.pattern.exec(substituted);
    if (!m) continue;
    const captures = [];
    for (let g = 1; g < m.length; g++) {
      const groupText = m[g] ?? '';
      const phMatch = groupText.match(STANDIN_RECOVER_RE);
      if (!phMatch) continue;
      const placeholder = order[Number(phMatch[1])];
      // The handler's positional formal parameter is the channel a captured
      // Examples value reaches an assertion through. Prefer it; fall back to
      // the pattern's positional marker when the signature is unreadable.
      const handlerParam = def.handlerParams?.[g - 1];
      const paramName = handlerParam ?? def.paramNames[g - 1] ?? `$${g}`;
      captures.push({ placeholder, paramName });
    }
    if (captures.length > 0) return { def, captures };
  }
  return null;
}

// --- Per-file check --------------------------------------------------------

export function checkFile(absPath, repoRoot, stepDefs) {
  const violations = [];
  const source = fs.readFileSync(absPath, 'utf8');
  const masked = maskDocStrings(source);
  const relFile = path.relative(repoRoot, absPath).split(path.sep).join('/');
  const outlines = parseOutlines(masked);

  for (const outline of outlines) {
    const consumed = new Map(); // placeholder -> boolean
    const firstSeenLine = new Map(); // placeholder -> line

    for (const step of outline.steps) {
      const used = extractPlaceholders(step.text);
      if (used.length === 0) continue;
      for (const ph of used) {
        if (!firstSeenLine.has(ph)) firstSeenLine.set(ph, step.line);
        if (!consumed.has(ph)) consumed.set(ph, false);
      }

      const binding = resolveBinding(step.text, stepDefs);
      if (!binding) continue;

      for (const { placeholder, paramName } of binding.captures) {
        if (paramName && bodyReferencesParam(binding.def.body, paramName)) {
          consumed.set(placeholder, true);
        }
      }
    }

    for (const [ph, isConsumed] of consumed) {
      // Only flag placeholders that are real Examples columns. A
      // `<placeholder>` with no matching Examples column is malformed in a
      // different way and out of this validator's lane.
      if (!outline.exampleHeaders.has(ph)) continue;
      if (!isConsumed) {
        violations.push({
          file: relFile,
          line: firstSeenLine.get(ph) ?? outline.line,
          kind: 'unconsumed-placeholder',
          message: `Scenario Outline placeholder <${ph}> is never asserted by its bound step definition`,
        });
      }
    }
  }

  return violations;
}

// --- Public entry point ----------------------------------------------------

/**
 * Run the checker programmatically. Returns `{ exitCode, violations, scanned }`.
 *
 * @param {object} [options]
 * @param {string} [options.repoRoot] Defaults to the framework repo root.
 * @param {string[]} [options.featureRoots] Defaults to `['tests/features']`.
 * @param {string[]} [options.stepRoots] Defaults to `['tests/steps']`.
 */
export function runCheck(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const featureRoots = options.featureRoots ?? DEFAULT_FEATURE_ROOTS;
  const stepRoots = options.stepRoots ?? DEFAULT_STEP_ROOTS;

  const stepDefFiles = discoverStepDefs(repoRoot, stepRoots);
  const stepDefs = [];
  for (const abs of stepDefFiles) {
    const src = fs.readFileSync(abs, 'utf8');
    stepDefs.push(...parseStepDefs(src));
  }

  const featureFiles = discoverFeatures(repoRoot, featureRoots);
  const violations = [];
  for (const abs of featureFiles) {
    violations.push(...checkFile(abs, repoRoot, stepDefs));
  }

  return {
    exitCode: violations.length === 0 ? 0 : 1,
    violations,
    scanned: featureFiles.length,
  };
}

function formatViolation(v) {
  return `${v.file}:${v.line}: [${v.kind}] ${v.message}`;
}

async function main() {
  const result = runCheck();
  if (result.violations.length === 0) {
    Logger.info(
      `[check-gherkin-placeholders] OK — scanned ${result.scanned} feature file(s); no unconsumed placeholders.`,
    );
    process.exit(0);
    return;
  }
  for (const v of result.violations) {
    process.stderr.write(`${formatViolation(v)}\n`);
  }
  process.stderr.write(
    `\n[check-gherkin-placeholders] FAILED — ${result.violations.length} violation(s) across ${result.scanned} file(s).\n`,
  );
  process.exit(1);
}

runAsCli(import.meta.url, main, { source: 'check-gherkin-placeholders' });
