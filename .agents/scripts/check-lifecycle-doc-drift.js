#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * check-lifecycle-doc-drift.js — enforce that the listener-model table
 * in `docs/LIFECYCLE.md` stays in lockstep with the per-listener
 * `this.events = Object.freeze([...])` subscription arrays under
 * `.agents/scripts/lib/orchestration/lifecycle/listeners/`.
 *
 * Why this exists (Tech Spec F5, Epic #2880): the LIFECYCLE.md
 * listener-model table is hand-authored prose that documents the
 * lifecycle-bus contract. When a listener rebinds (e.g.
 * `epic.merge.armed` → `epic.merge.confirmed`) the table drifts
 * silently because nothing reads the code against the doc. This check
 * closes that gap by failing CI on any per-listener subscription that
 * exists in code but not in the doc — or vice versa.
 *
 * Scope:
 *   - Listener files scanned: every `*.js` under
 *     `.agents/scripts/lib/orchestration/lifecycle/listeners/` except
 *     `index.js` (the factory).
 *   - Subscription source: each listener exposes its subscription list
 *     via a `this.events = Object.freeze([...])` assignment containing
 *     a literal array of single-quoted event names. Listeners that do
 *     not match this pattern — wildcard observers (`bus.on('*', ...)`)
 *     and dynamic-event listeners that resolve subscriptions through
 *     identifiers (`Object.keys(...)`, imported constants) — are
 *     treated as **wildcard** for the purpose of this check. The doc
 *     row for a wildcard listener must carry `` `*` `` in its
 *     subscribes-to column.
 *   - Doc parsed: `docs/LIFECYCLE.md` § "4. Listener model" — every
 *     row in the listener table is keyed by the PascalCase listener
 *     name in its first column and the set of backticked event tokens
 *     in its second column.
 *
 * Drift detection:
 *   - `code-only`: a literal event in `this.events` that does not
 *     appear in the matching doc row's events column.
 *   - `doc-only`: a backticked event token in the doc row that does
 *     not appear in the listener's `this.events`.
 *   - `missing-row`: a listener file with no matching PascalCase row
 *     in the doc table.
 *   - `unknown-row`: a doc row whose listener name does not map to any
 *     file under listeners/. Listeners that ship outside the listeners/
 *     directory (LedgerWriter, TraceLogger) are exempted by allow-list.
 *
 * Exit codes:
 *   0 — clean.
 *   1 — at least one drift; offending listener + diff printed to stderr.
 *
 * Wiring:
 *   This script ships under the `baselines` CI check (see
 *   `.agentrc.json` → `github.branchProtection.requiredChecks`).
 *
 * Public test seam: `checkLifecycleDocDrift({ listenersDir, docPath })`
 * runs the scanner against an arbitrary listener tree + doc path. The
 * pure helpers `extractCodeEvents(src)`, `parseListenerTable(md)`, and
 * `diffListenerEvents({ code, doc })` are exported for unit-level
 * reuse (the contract test under tests/contract/lifecycle drives them
 * directly).
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAsCli } from './lib/cli-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_LISTENERS_DIR = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'lib',
  'orchestration',
  'lifecycle',
  'listeners',
);
const DEFAULT_DOC_PATH = path.join(REPO_ROOT, 'docs', 'LIFECYCLE.md');

/**
 * Listener classes documented in the LIFECYCLE.md listener table that
 * are intentionally NOT shipped as files under listeners/ — they live
 * in sibling modules (`ledger-writer.js`, `trace-logger.js`) but
 * register against the bus on the same wildcard contract. They are
 * exempt from the `unknown-row` check.
 */
const EXEMPT_DOC_ROWS = Object.freeze(new Set(['LedgerWriter', 'TraceLogger']));

/**
 * Convert a kebab-case basename to PascalCase, e.g.
 * `acceptance-reconciler` → `AcceptanceReconciler`.
 *
 * @param {string} basename
 * @returns {string}
 */
export function kebabToPascal(basename) {
  return basename
    .split('-')
    .map((seg) => (seg.length ? seg[0].toUpperCase() + seg.slice(1) : seg))
    .join('');
}

/**
 * Extract the array of literal event names from a listener file's
 * source. Looks for the canonical `this.events = Object.freeze([...])`
 * pattern; the array body may span multiple lines. Returns:
 *   - `{ kind: 'literals', events: [...] }` when every array entry is
 *     a single- or double-quoted string literal.
 *   - `{ kind: 'wildcard' }` when no pattern matches OR the array body
 *     contains identifiers / function calls (i.e. the subscription set
 *     is dynamic at runtime; the doc row must use `*`).
 *
 * @param {string} src
 * @returns {{ kind: 'literals', events: string[] } | { kind: 'wildcard' }}
 */
export function extractCodeEvents(src) {
  // Greedy across newlines, non-greedy on the array body. The
  // surrounding `Object.freeze([` … `])` anchors the match tightly so
  // we never swallow unrelated array literals.
  const re = /this\.events\s*=\s*Object\.freeze\(\s*\[([\s\S]*?)\]\s*\)/;
  const m = re.exec(src);
  if (!m) return { kind: 'wildcard' };
  const body = m[1];
  // Build a constant table for top-level `const|export const NAME =
  // '<literal>';` assignments so subscriptions that reference an event
  // name constant (e.g. `Object.freeze([INTERVENTION_RECORDED_EVENT])`)
  // resolve to a literal here instead of falling through to wildcard.
  const constants = collectStringConstants(src);
  // Strip comments inside the array body so they don't confuse the
  // literal-vs-identifier split.
  const bodyClean = body
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const literals = [];
  let isDynamic = false;
  for (const rawEntry of bodyClean.split(',')) {
    const entry = rawEntry.trim();
    if (entry.length === 0) continue;
    const strLit = /^'([^']*)'$|^"([^"]*)"$/.exec(entry);
    if (strLit) {
      literals.push(strLit[1] ?? strLit[2]);
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry) && constants.has(entry)) {
      literals.push(constants.get(entry));
      continue;
    }
    // Anything else (function call, spread, unknown identifier) means
    // the array is dynamic at runtime; treat as wildcard.
    isDynamic = true;
    break;
  }
  if (isDynamic) return { kind: 'wildcard' };
  if (literals.length === 0) return { kind: 'wildcard' };
  return { kind: 'literals', events: literals };
}

/**
 * Collect top-level string constants of the shape
 * `const NAME = '<literal>';` or `export const NAME = '<literal>';`
 * so the array-body parser can resolve identifier-form event names.
 *
 * @param {string} src
 * @returns {Map<string, string>}
 */
export function collectStringConstants(src) {
  const out = new Map();
  const re =
    /^\s*(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*=\s*(?:'([^']*)'|"([^"]*)")\s*;/gm;
  let m = re.exec(src);
  while (m !== null) {
    out.set(m[1], m[2] ?? m[3]);
    m = re.exec(src);
  }
  return out;
}

/**
 * Parse the LIFECYCLE.md listener-model table. Returns a Map from
 * PascalCase listener name → { events: Set<string>, hasWildcard:
 * boolean }. The table is located by looking for a markdown table
 * whose header includes "Listener" and "Subscribes to".
 *
 * @param {string} md
 * @returns {Map<string, { events: Set<string>, hasWildcard: boolean }>}
 */
export function parseListenerTable(md) {
  const out = new Map();
  const lines = md.split(/\r?\n/);
  // Find the header row that names "Listener" and "Subscribes to".
  let inTable = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!inTable) {
      if (line.includes('| Listener') && line.includes('Subscribes to')) {
        // Header row found; skip the separator on the next line and
        // start parsing data rows.
        inTable = true;
        i += 1; // skip separator
      }
      continue;
    }
    // Data row or end-of-table.
    if (!line.startsWith('|')) break;
    const cells = line.split('|').map((c) => c.trim());
    // cells[0] is empty before leading '|'; cells[1] is the listener,
    // cells[2] is the subscribes-to column.
    if (cells.length < 3) continue;
    const nameCell = cells[1];
    const subsCell = cells[2];
    const nameMatch = /`([A-Za-z][A-Za-z0-9_]*)`/.exec(nameCell);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const events = new Set();
    let hasWildcard = false;
    const tokenRe = /`([^`]+)`/g;
    let tm = tokenRe.exec(subsCell);
    while (tm !== null) {
      const tok = tm[1];
      if (tok === '*') hasWildcard = true;
      // Event tokens look like `<word>.<word>(.<word>)*`. Anything
      // else (e.g. `epic-*`, prose tokens) is ignored — wildcard rows
      // already cover those cases.
      else if (/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/i.test(tok)) {
        events.add(tok);
      }
      tm = tokenRe.exec(subsCell);
    }
    out.set(name, { events, hasWildcard });
  }
  return out;
}

/**
 * Diff a code-side event extraction against a doc-side row.
 *
 * @param {object} input
 * @param {{ kind: 'literals', events: string[] } | { kind: 'wildcard' }} input.code
 * @param {{ events: Set<string>, hasWildcard: boolean } | undefined} input.doc
 * @returns {{ codeOnly: string[], docOnly: string[], wildcardMismatch: boolean }}
 */
export function diffListenerEvents({ code, doc }) {
  const codeOnly = [];
  const docOnly = [];
  let wildcardMismatch = false;
  if (!doc) {
    // Caller surfaces this as `missing-row`; nothing to diff here.
    if (code.kind === 'literals')
      return { codeOnly: code.events.slice(), docOnly, wildcardMismatch };
    return { codeOnly, docOnly, wildcardMismatch };
  }
  if (code.kind === 'wildcard') {
    if (!doc.hasWildcard) wildcardMismatch = true;
    return { codeOnly, docOnly, wildcardMismatch };
  }
  // Literal code-side; compare both directions.
  const codeSet = new Set(code.events);
  for (const ev of code.events) {
    if (!doc.events.has(ev)) codeOnly.push(ev);
  }
  for (const ev of doc.events) {
    if (!codeSet.has(ev)) docOnly.push(ev);
  }
  return { codeOnly, docOnly, wildcardMismatch };
}

/**
 * Walk the listeners directory and return [{ pascalName, filePath,
 * code }] for every `.js` file (excluding `index.js`).
 *
 * @param {string} listenersDir
 * @param {{ read?: typeof readFileSync, readDir?: typeof readdirSync }} [opts]
 * @returns {Array<{ pascalName: string, filePath: string, code: ReturnType<typeof extractCodeEvents> }>}
 */
export function loadCodeListeners(
  listenersDir,
  { read = readFileSync, readDir = readdirSync } = {},
) {
  const out = [];
  const entries = readDir(listenersDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith('.js')) continue;
    if (ent.name === 'index.js') continue;
    const basename = ent.name.replace(/\.js$/, '');
    const pascalName = kebabToPascal(basename);
    const filePath = path.join(listenersDir, ent.name);
    const src = read(filePath, 'utf8');
    const code = extractCodeEvents(src);
    out.push({ pascalName, filePath, code });
  }
  return out;
}

/**
 * Run the drift check end-to-end. Returns an array of findings; each
 * finding carries a `kind` discriminator and the offending listener
 * name + details.
 *
 * @param {object} [opts]
 * @param {string} [opts.listenersDir] override the default listeners/
 *   path (used by tests + fixture injection).
 * @param {string} [opts.docPath] override the default LIFECYCLE.md
 *   path.
 * @param {typeof readFileSync} [opts.read]
 * @param {typeof readdirSync} [opts.readDir]
 * @returns {Array<{ kind: string, listener: string, detail?: string, codeOnly?: string[], docOnly?: string[] }>}
 */
export function checkLifecycleDocDrift({
  listenersDir = DEFAULT_LISTENERS_DIR,
  docPath = DEFAULT_DOC_PATH,
  read = readFileSync,
  readDir = readdirSync,
} = {}) {
  const findings = [];
  const md = read(docPath, 'utf8');
  const docRows = parseListenerTable(md);
  const codeListeners = loadCodeListeners(listenersDir, { read, readDir });
  const codePascalNames = new Set(codeListeners.map((c) => c.pascalName));

  for (const { pascalName, code } of codeListeners) {
    const doc = docRows.get(pascalName);
    if (!doc) {
      findings.push({
        kind: 'missing-row',
        listener: pascalName,
        detail: `listener file present in code but no matching row in LIFECYCLE.md listener table`,
      });
      continue;
    }
    const diff = diffListenerEvents({ code, doc });
    if (diff.wildcardMismatch) {
      findings.push({
        kind: 'wildcard-mismatch',
        listener: pascalName,
        detail: `listener registers a wildcard or dynamic subscription in code but the doc row carries no \`*\` token`,
      });
    }
    if (diff.codeOnly.length > 0 || diff.docOnly.length > 0) {
      findings.push({
        kind: 'event-drift',
        listener: pascalName,
        codeOnly: diff.codeOnly,
        docOnly: diff.docOnly,
      });
    }
  }

  for (const [docName] of docRows) {
    if (codePascalNames.has(docName)) continue;
    if (EXEMPT_DOC_ROWS.has(docName)) continue;
    findings.push({
      kind: 'unknown-row',
      listener: docName,
      detail: `LIFECYCLE.md lists this listener but no matching file exists under listeners/`,
    });
  }

  return findings;
}

/**
 * Format a single finding as a human-readable diff line.
 *
 * @param {{ kind: string, listener: string, detail?: string, codeOnly?: string[], docOnly?: string[] }} f
 * @returns {string}
 */
export function formatFinding(f) {
  if (f.kind === 'event-drift') {
    const parts = [];
    if (f.codeOnly && f.codeOnly.length > 0) {
      parts.push(`code-only: [${f.codeOnly.join(', ')}]`);
    }
    if (f.docOnly && f.docOnly.length > 0) {
      parts.push(`doc-only: [${f.docOnly.join(', ')}]`);
    }
    return `[lifecycle-doc-drift][event-drift] ${f.listener}\n  ${parts.join(' | ')}`;
  }
  return `[lifecycle-doc-drift][${f.kind}] ${f.listener}\n  ${f.detail ?? ''}`;
}

async function main() {
  const findings = checkLifecycleDocDrift();
  if (findings.length === 0) {
    process.stdout.write(
      '[lifecycle-doc-drift] clean: listener subscriptions match docs/LIFECYCLE.md listener-model table.\n',
    );
    return 0;
  }
  for (const f of findings) {
    process.stderr.write(`${formatFinding(f)}\n`);
  }
  return 1;
}

await runAsCli(import.meta.url, main, {
  source: 'check-lifecycle-doc-drift',
  propagateExitCode: true,
});
