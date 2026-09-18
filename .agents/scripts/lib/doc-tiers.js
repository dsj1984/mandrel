/**
 * Doc-tier resolver: partition the repo's docs into read-tiers with byte
 * sizes for the context-budget ratchet (`alwaysLoaded` = CLAUDE.md's
 * `@`-import closure; `agentBoot` and `workflowOnDemand` are recorded, not
 * gated). A path lives only in its highest tier. Emits paths and byte
 * counts, never file contents.
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import { resolveWorkflowClosures } from './workflow-closure.js';

/**
 * @type {string}
 */
const ENTRY_DOC = 'CLAUDE.md';

/**
 * @type {string[]}
 */
const ALWAYS_ON_RULES = ['security-baseline.md', 'git-conventions.md'];

/**
 * @type {string[]}
 */
const CONDITIONAL_DOCS = ['style-guide.md', 'web-routes.md'];

/** Candidates only; the file-existence check filters out prose `@` tokens. */
const IMPORT_RE = /(?:^|\s)@([^\s'"`)\]}>,]+)/gm;

/**
 * @typedef {{
 *   existsSync: (p: string) => boolean,
 *   readFileSync: (p: string, enc: string) => string,
 *   statSync: (p: string) => { size: number },
 * }} FsLike
 */

/**
 * Trailing `.`/`:` is trimmed so `@AGENTS.md.` still resolves.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function parseImportSpecifiers(source) {
  const specs = [];
  for (const m of String(source ?? '').matchAll(IMPORT_RE)) {
    let spec = m[1];
    while (spec.length > 0 && (spec.endsWith('.') || spec.endsWith(':'))) {
      spec = spec.slice(0, -1);
    }
    if (spec.length > 0) specs.push(spec);
  }
  return specs;
}

/**
 * @param {string} root
 * @param {string} abs
 * @returns {string}
 */
function toRepoRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {FsLike} fs
 * @returns {{ path: string, bytes: number } | null}
 */
function fileEntry(root, rel, fs) {
  const abs = path.resolve(root, rel);
  if (!fs.existsSync(abs)) return null;
  let bytes = 0;
  try {
    bytes = fs.statSync(abs).size;
  } catch {
    return null;
  }
  return { path: toRepoRel(root, abs), bytes };
}

/**
 * Cycle-safe; nested imports resolve relative to the importing file.
 *
 * @param {string} root
 * @param {{ fs?: FsLike }} [opts]
 * @returns {Array<{ path: string, bytes: number }>}
 */
export function resolveAlwaysLoadedClosure(root, { fs = nodeFs } = {}) {
  const entryAbs = path.resolve(root, ENTRY_DOC);
  if (!fs.existsSync(entryAbs)) return [];

  const visited = new Set();
  const entries = new Map();
  const queue = [entryAbs];

  while (queue.length > 0) {
    const abs = queue.shift();
    const rel = toRepoRel(root, abs);
    if (visited.has(rel)) continue;
    visited.add(rel);

    if (!fs.existsSync(abs)) continue;
    let bytes = 0;
    let source = '';
    try {
      bytes = fs.statSync(abs).size;
      source = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    entries.set(rel, { path: rel, bytes });

    const dir = path.dirname(abs);
    for (const spec of parseImportSpecifiers(source)) {
      const targetAbs = path.resolve(dir, spec);
      const targetRel = toRepoRel(root, targetAbs);
      if (!visited.has(targetRel) && fs.existsSync(targetAbs)) {
        queue.push(targetAbs);
      }
    }
  }

  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Reads `project.*` first, then the legacy top-level keys.
 *
 * @param {object} config
 * @returns {string[]}
 */
export function docsContextPaths(config) {
  const project = config?.project ?? config;
  const contextDocs = Array.isArray(project?.docsContextFiles)
    ? project.docsContextFiles
    : Array.isArray(config?.docsContextFiles)
      ? config.docsContextFiles
      : [];
  const docsRoot =
    project?.paths?.docsRoot ?? config?.paths?.docsRoot ?? 'docs';
  return contextDocs.map((f) => path.posix.join(docsRoot, f));
}

/**
 * @param {object} config
 * @param {{ root?: string, fs?: FsLike }} [opts]
 * @returns {{
 *   tiers: {
 *     alwaysLoaded: Array<{ path: string, bytes: number }>,
 *     mandatoryRead: Array<{ path: string, bytes: number }>,
 *     digestVisible: Array<{ path: string, bytes: number }>,
 *     onDemand: Array<{ path: string, bytes: number }>,
 *     agentBoot: Array<{ path: string, bytes: number }>,
 *     workflow: Array<{ path: string, bytes: number }>,
 *     workflowOnDemand: Array<{ path: string, bytes: number }>,
 *   },
 *   workflowClosure: {
 *     mandatoryTotalBytes: number,
 *     reachableTotalBytes: number,
 *     entryPoints: Array<{ path: string, mandatoryBytes: number, reachableBytes: number }>,
 *   },
 * }}
 * @throws {Error} on an unresolvable `mandatoryReads` entry or a mandatory cycle
 */
export function resolveDocTiers(
  config,
  { root = process.cwd(), fs = nodeFs } = {},
) {
  const claimed = new Set();
  const collect = (relPaths) => {
    const out = [];
    for (const rel of relPaths) {
      const entry = fileEntry(root, rel, fs);
      if (!entry) continue;
      if (claimed.has(entry.path)) continue;
      claimed.add(entry.path);
      out.push(entry);
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  };

  // Pre-claim the closure so a lower tier never re-lists a member.
  const alwaysLoaded = resolveAlwaysLoadedClosure(root, { fs });
  for (const e of alwaysLoaded) claimed.add(e.path);

  const docsRoot =
    config?.project?.paths?.docsRoot ?? config?.paths?.docsRoot ?? 'docs';
  const mandatoryRead = collect(docsContextPaths(config));

  const digestVisible = collect(
    CONDITIONAL_DOCS.map((f) => path.posix.join(docsRoot, f)),
  );

  const onDemand = collect(listOnDemandRules(root, fs));

  const agentBoot = collect(listAgentDefs(root, fs));

  const closure = resolveWorkflowClosures(root, { fs });
  const workflow = collect(closure.mandatoryFiles.map((e) => e.path));
  const workflowOnDemand = collect(closure.onDemandFiles.map((e) => e.path));

  return {
    tiers: {
      alwaysLoaded,
      mandatoryRead,
      digestVisible,
      onDemand,
      agentBoot,
      workflow,
      workflowOnDemand,
    },
    workflowClosure: {
      mandatoryTotalBytes: closure.mandatoryTotalBytes,
      reachableTotalBytes: closure.reachableTotalBytes,
      entryPoints: closure.entryPoints,
    },
  };
}

/**
 * @param {string} root
 * @param {FsLike} fs
 * @returns {string[]}
 */
function listAgentDefs(root, fs) {
  const agentsDir = path.resolve(root, '.agents', 'agents');
  let names;
  try {
    names = fs.readdirSync(agentsDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.md'))
    .map((n) => path.posix.join('.agents', 'agents', n))
    .sort();
}

/**
 * @param {string} root
 * @param {FsLike} fs
 * @returns {string[]}
 */
function listOnDemandRules(root, fs) {
  const rulesDir = path.resolve(root, '.agents', 'rules');
  let names;
  try {
    names = fs.readdirSync(rulesDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.md') && !ALWAYS_ON_RULES.includes(n))
    .map((n) => path.posix.join('.agents', 'rules', n))
    .sort();
}

/**
 * @param {Array<{ bytes: number }>} entries
 * @returns {number}
 */
export function tierTotalBytes(entries) {
  return (entries ?? []).reduce((sum, e) => sum + (e?.bytes ?? 0), 0);
}
