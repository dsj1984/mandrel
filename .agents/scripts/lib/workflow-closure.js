/**
 * Workflow read-tier closures per entry point: **mandatory** (transitive
 * `mandatoryReads:` frontmatter edges — ratcheted by `check-context-budget.js`)
 * and **reachable** (transitive links — recorded, never gated). Tier is
 * per-edge, so it lives in the declaring file. An unresolvable or cyclic
 * mandatory edge throws: a ratchet that silently shrinks is worse than none.
 * Confined to `.agents/workflows/**` (`doc-tiers.js` tiers the rest). Outputs
 * are paths and byte counts, never contents.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

/**
 * @type {string}
 */
const WORKFLOWS_ROOT = '.agents/workflows';

/** Path-segment count of a top-level workflow (`.agents/workflows/x.md`). */
const TOP_LEVEL_DEPTH = 3;

// RegExp constructors, not literals: typhonjs-escomplex (the MI engine)
// crashes on `RegExpLiteral` nodes.
// biome-ignore-start lint/complexity/useRegexLiterals: typhonjs-escomplex MI workaround
const FRONTMATTER_RE = new RegExp(String.raw`^---\r?\n([\s\S]*?)\r?\n---`);
const NEWLINE_RE = new RegExp(String.raw`\r?\n`);
const MANDATORY_KEY_RE = new RegExp(String.raw`^mandatoryReads\s*:(.*)$`);
const BLOCK_ITEM_RE = new RegExp(String.raw`^\s*-\s*(.+)$`);
const MD_LINK_RE = new RegExp(String.raw`\]\(\s*([^)\s]+)`, 'g');
const COMMAND_H1_RE = new RegExp(String.raw`^#\s+/([A-Za-z0-9._-]+)`, 'm');
// biome-ignore-end lint/complexity/useRegexLiterals: typhonjs-escomplex MI workaround

/**
 * @typedef {{
 *   readdirSync: (p: string, o?: object) => any[],
 *   readFileSync: (p: string, enc: string) => string,
 *   statSync: (p: string) => { size: number },
 * }} FsLike
 */

/**
 * @typedef {{ rel: string, bytes: number, source: string }} WorkflowDoc
 */

/**
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  const t = String(value ?? '').trim();
  const quoted =
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("'") && t.endsWith("'")));
  return quoted ? t.slice(1, -1).trim() : t;
}

/**
 * @param {string} p
 * @returns {string}
 */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * @param {string} source
 * @returns {string}
 */
function frontmatterBlock(source) {
  const m = FRONTMATTER_RE.exec(String(source ?? ''));
  return m ? m[1] : '';
}

/**
 * YAML block sequence from `start`; blank lines skipped, first other line ends it.
 *
 * @param {string[]} lines
 * @param {number} start
 * @returns {string[]}
 */
function blockSequence(lines, start) {
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    const item = BLOCK_ITEM_RE.exec(lines[i]);
    if (item) {
      const value = unquote(item[1]);
      if (value) out.push(value);
    } else if (lines[i].trim() !== '') {
      break;
    }
  }
  return out;
}

/**
 * @param {string} inline
 * @returns {string[]}
 */
function flowSequence(inline) {
  const body = inline.replace('[', '').replace(']', '');
  return body
    .split(',')
    .map(unquote)
    .filter((v) => v.length > 0);
}

/**
 * `mandatoryReads:` in flow, block, or scalar form; absent key → `[]`.
 *
 * @param {string} source
 * @returns {string[]} raw specifiers, relative to the declaring file
 */
function parseMandatoryReads(source) {
  const lines = frontmatterBlock(source).split(NEWLINE_RE);
  const idx = lines.findIndex((line) => MANDATORY_KEY_RE.test(line));
  if (idx < 0) return [];
  const inline = unquote(MANDATORY_KEY_RE.exec(lines[idx])[1]);
  if (inline.startsWith('[')) return flowSequence(inline);
  if (inline.length > 0) return [inline];
  return blockSequence(lines, idx + 1);
}

/**
 * Markdown link targets, anchors stripped.
 *
 * @param {string} source
 * @returns {string[]}
 */
function parseLinkTargets(source) {
  const out = [];
  for (const m of String(source ?? '').matchAll(MD_LINK_RE)) {
    const target = m[1].split('#')[0].trim();
    if (target.length > 0) out.push(target);
  }
  return out;
}

/**
 * Resolve a specifier to a known workflow doc, or `null` when external,
 * non-markdown, or outside the workflow tree.
 *
 * @param {string} fromRel repo-relative posix path of the declaring file
 * @param {string} spec
 * @param {Map<string, WorkflowDoc>} docs
 * @returns {string | null}
 */
function resolveSpec(fromRel, spec, docs) {
  if (!spec.endsWith('.md')) return null;
  if (spec.includes('://') || spec.startsWith('mailto:')) return null;
  const rel = path.posix.join(path.posix.dirname(fromRel), spec);
  return docs.has(rel) ? rel : null;
}

/**
 * @param {WorkflowDoc} doc
 * @param {Map<string, WorkflowDoc>} docs
 * @returns {string[]}
 */
function mandatoryEdges(doc, docs) {
  const out = [];
  for (const spec of parseMandatoryReads(doc.source)) {
    const rel = resolveSpec(doc.rel, spec, docs);
    if (!rel) {
      throw new Error(
        `[workflow-closure] ${doc.rel} declares mandatoryReads "${spec}", which does not resolve to a markdown file under ${WORKFLOWS_ROOT}`,
      );
    }
    out.push(rel);
  }
  return out;
}

/**
 * Cycle-fatal DFS of the mandatory-edge graph.
 *
 * @param {string} rel
 * @param {Map<string, WorkflowDoc>} docs
 * @param {string[]} stack in-progress DFS path
 * @param {Set<string>} seen finished nodes
 * @returns {Set<string>} `seen`
 */
function walkMandatory(rel, docs, stack, seen) {
  if (stack.includes(rel)) {
    throw new Error(
      `[workflow-closure] mandatoryReads cycle: ${[...stack, rel].join(' -> ')}`,
    );
  }
  if (seen.has(rel)) return seen;
  seen.add(rel);
  stack.push(rel);
  for (const next of mandatoryEdges(docs.get(rel), docs)) {
    walkMandatory(next, docs, stack, seen);
  }
  stack.pop();
  return seen;
}

/**
 * Cycle-tolerant BFS of the link graph; each file counted once.
 *
 * @param {string} rel
 * @param {Map<string, WorkflowDoc>} docs
 * @returns {Set<string>}
 */
function walkReachable(rel, docs) {
  const seen = new Set();
  const queue = [rel];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const spec of parseLinkTargets(docs.get(current).source)) {
      const next = resolveSpec(current, spec, docs);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

/**
 * Recursive `.md` listing; an unreadable directory yields nothing.
 *
 * @param {FsLike} fs
 * @param {string} dirAbs
 * @param {string} root
 * @param {string[]} out
 * @returns {string[]} `out`
 */
function listMarkdown(fs, dirAbs, root, out) {
  let dirents;
  try {
    dirents = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirent of dirents) {
    const abs = path.join(dirAbs, dirent.name);
    if (dirent.isDirectory()) listMarkdown(fs, abs, root, out);
    else if (dirent.name.endsWith('.md'))
      out.push(toPosix(path.relative(root, abs)));
  }
  return out;
}

/**
 * @param {string} root absolute repo root
 * @param {FsLike} fs
 * @returns {Map<string, WorkflowDoc>}
 */
function loadDocs(root, fs) {
  const dirAbs = path.resolve(root, WORKFLOWS_ROOT);
  const docs = new Map();
  for (const rel of listMarkdown(fs, dirAbs, root, []).sort()) {
    const abs = path.resolve(root, rel);
    try {
      docs.set(rel, {
        rel,
        bytes: fs.statSync(abs).size,
        source: fs.readFileSync(abs, 'utf8'),
      });
    } catch {
      // Unreadable file — skipped.
    }
  }
  return docs;
}

/**
 * Top-level workflow, or a helper whose H1 slash command matches its own
 * filename — an appendix titled after the command it documents is not.
 *
 * @param {WorkflowDoc} doc
 * @returns {boolean}
 */
function isEntryPoint(doc) {
  if (doc.rel.split('/').length === TOP_LEVEL_DEPTH) return true;
  const h1 = COMMAND_H1_RE.exec(doc.source);
  return h1 ? h1[1] === path.posix.basename(doc.rel, '.md') : false;
}

/**
 * @param {Iterable<string>} rels
 * @param {Map<string, WorkflowDoc>} docs
 * @returns {Array<{ path: string, bytes: number }>}
 */
function toEntries(rels, docs) {
  return [...rels]
    .map((rel) => ({ path: rel, bytes: docs.get(rel)?.bytes ?? 0 }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * @param {Iterable<string>} rels
 * @param {Map<string, WorkflowDoc>} docs
 * @returns {number}
 */
function sumBytes(rels, docs) {
  let total = 0;
  for (const rel of rels) total += docs.get(rel)?.bytes ?? 0;
  return total;
}

/**
 * Resolve every entry point's closures, partitioned into mandatory and
 * on-demand; empty collections when `.agents/workflows` is absent.
 *
 * @param {string} root absolute repo root
 * @param {{ fs?: FsLike }} [opts]
 * @returns {{
 *   entryPoints: Array<{ path: string, mandatoryBytes: number, reachableBytes: number }>,
 *   mandatoryFiles: Array<{ path: string, bytes: number }>,
 *   onDemandFiles: Array<{ path: string, bytes: number }>,
 *   mandatoryTotalBytes: number,
 *   reachableTotalBytes: number,
 * }}
 * @throws {Error} on an unresolvable `mandatoryReads` entry or a mandatory cycle
 */
export function resolveWorkflowClosures(root, { fs = nodeFs } = {}) {
  const docs = loadDocs(root, fs);
  const entryPoints = [];
  const mandatoryUnion = new Set();
  const reachableUnion = new Set();

  for (const doc of docs.values()) {
    if (!isEntryPoint(doc)) continue;
    const mandatory = walkMandatory(doc.rel, docs, [], new Set());
    const reachable = walkReachable(doc.rel, docs);
    for (const rel of mandatory) mandatoryUnion.add(rel);
    for (const rel of reachable) reachableUnion.add(rel);
    entryPoints.push({
      path: doc.rel,
      mandatoryBytes: sumBytes(mandatory, docs),
      reachableBytes: sumBytes(reachable, docs),
    });
  }

  const onDemandUnion = [...reachableUnion].filter(
    (rel) => !mandatoryUnion.has(rel),
  );
  return {
    entryPoints: entryPoints.sort((a, b) => a.path.localeCompare(b.path)),
    mandatoryFiles: toEntries(mandatoryUnion, docs),
    onDemandFiles: toEntries(onDemandUnion, docs),
    mandatoryTotalBytes: sumBytes(mandatoryUnion, docs),
    reachableTotalBytes: sumBytes(reachableUnion, docs),
  };
}
