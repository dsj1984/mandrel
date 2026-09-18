/** Audit-lens selection over `audit-rules.json`. */

import { readdirSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import { getPaths, PROJECT_ROOT, resolveConfig } from '../config-resolver.js';
import { softFailOrThrow } from '../degraded-mode.js';
import { gitSpawn } from '../git-utils.js';
import { withTimeout } from '../util/with-timeout.js';
import { readAuditRulesSync } from './audit-rules-reader.js';

const DEFAULT_GIT_TIMEOUT_MS = 30000;

/**
 * Lens `scope` vocabulary; `global` is never narrowed by change set.
 *
 * @type {readonly ['local', 'cumulative', 'global']}
 */
export const LENS_TIERS = Object.freeze(['local', 'cumulative', 'global']);

/**
 * @param {string} lens Lens key registered in `audit-rules.json`.
 * @returns {'local' | 'cumulative' | 'global'} The lens's declared tier.
 * @throws {Error} When the lens is unregistered, the manifest is unreadable, or
 *   its scope is outside {@link LENS_TIERS}.
 */
export function resolveLensTier(lens) {
  const rulesData = readAuditRulesSync();

  const entry = rulesData.audits?.[lens];
  if (!entry) {
    throw new Error(
      `resolveLensTier: unknown lens '${lens}' — not registered in audit-rules.json`,
    );
  }

  const { scope } = entry;
  if (!LENS_TIERS.includes(scope)) {
    throw new Error(
      `resolveLensTier: lens '${lens}' declares invalid scope '${scope}'; expected one of ${LENS_TIERS.join(', ')}`,
    );
  }

  return scope;
}

/**
 * Local-tier lenses whose `filePatterns` hit the change set (not
 * {@link selectAudits}, which would widen it with keyword matches).
 *
 * @param {{
 *   changedFiles?: string[],
 *   injectedRules?: { audits?: Record<string, object> },
 *   resolveLensTierFn?: typeof resolveLensTier,
 * }} [params]
 * @returns {string[]} The matched local-lens identifiers, in manifest order.
 */
export function selectLocalLenses({
  changedFiles,
  injectedRules,
  resolveLensTierFn = resolveLensTier,
} = {}) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  if (files.length === 0) return [];

  const rules = injectedRules ?? readAuditRulesSync();
  const selected = [];
  for (const [lens, entry] of Object.entries(rules.audits ?? {})) {
    if (resolveLensTierFn(lens) !== 'local') continue;
    const patterns = entry?.triggers?.filePatterns ?? [];
    if (matchesAnyFilePattern(patterns, files)) {
      selected.push(lens);
    }
  }
  return selected;
}

/**
 * Manifest `sensitivePaths` classes the change set touches (review depth).
 *
 * @param {{
 *   changedFiles?: string[],
 *   injectedRules?: { sensitivePaths?: Record<string, { filePatterns?: string[] }> },
 * }} [params]
 * @returns {string[]} The matched class names, in manifest order.
 */
export function selectSensitivePathClasses({
  changedFiles,
  injectedRules,
} = {}) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  if (files.length === 0) return [];

  const rules = injectedRules ?? readAuditRulesSync();
  const matched = [];
  for (const [name, entry] of Object.entries(rules.sensitivePaths ?? {})) {
    if (matchesAnyFilePattern(entry?.filePatterns ?? [], files)) {
      matched.push(name);
    }
  }
  return matched;
}

/**
 * @param {object|null|undefined} config Resolved `.agentrc.json` wrapper.
 * @returns {string[]} Route globs, or `[]` when unconfigured.
 */
function resolveNavigabilityRouteGlobs(config) {
  const globs = config?.delivery?.quality?.navigability?.routeGlobs;
  return Array.isArray(globs) ? globs.filter((g) => typeof g === 'string') : [];
}

/** Matched segment-wise against dependency names (`@angular/core` → `angular`). */
const WEB_FRAMEWORK_PACKAGES = Object.freeze([
  'react',
  'next',
  'vue',
  'svelte',
  'sveltekit',
  'astro',
  'nuxt',
  'remix',
  'remix-run',
  'gatsby',
  'angular',
]);

const WEB_ASSET_EXTENSIONS = Object.freeze(['.html', '.css', '.jsx', '.tsx']);

/** A dependency's or fixture's asset says nothing about the consumer's own surface. */
const WEB_SCAN_SKIP_DIRS = Object.freeze([
  'node_modules',
  '.git',
  '.worktrees',
  'dist',
  'build',
  'out',
  'coverage',
  'temp',
  'tmp',
  'tests',
  'test',
  '__tests__',
  '__mocks__',
  'spec',
  'e2e',
  'fixtures',
]);

const WEB_SCAN_MAX_DEPTH = 6;
const WEB_SCAN_MAX_ENTRIES = 4000;

/**
 * Filesystem half only, so a different config never reads a stale answer.
 *
 * @type {Map<string, boolean>}
 */
const _webSurfaceFsCache = new Map();

/** Test-only. */
export function _resetWebSurfaceCache() {
  _webSurfaceFsCache.clear();
}

/**
 * Tri-state: `null` when the manifest exists but is unreadable/unparseable
 * (callers fail open); an absent manifest is a determinate `false`.
 *
 * @param {string} root
 * @param {readonly string[]} packageList
 * @returns {boolean|null}
 */
function declaresDependencyIn(root, packageList) {
  let raw;
  try {
    raw = readFileSync(path.join(root, 'package.json'), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    return null;
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }
  const names = [
    ...Object.keys(pkg?.dependencies ?? {}),
    ...Object.keys(pkg?.devDependencies ?? {}),
  ];
  return names.some((name) =>
    name
      .replace(/^@/, '')
      .split('/')
      .some((segment) => packageList.includes(segment)),
  );
}

/**
 * @param {string} root
 * @returns {boolean|null}
 */
function declaresWebFramework(root) {
  return declaresDependencyIn(root, WEB_FRAMEWORK_PACKAGES);
}

/**
 * `null` on an unreadable root or exhausted budget: a half-walked tree must
 * not report "no web surface".
 *
 * @param {string} root
 * @returns {boolean|null}
 */
function scanForWebAssets(root) {
  let budget = WEB_SCAN_MAX_ENTRIES;
  const queue = [{ dir: root, depth: 0 }];
  let rootRead = false;

  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // An unreadable subdirectory is skipped; an unreadable root is indeterminate.
      if (dir === root) return null;
      continue;
    }
    if (dir === root) rootRead = true;

    for (const entry of entries) {
      if (budget-- <= 0) return null; // truncated ⇒ indeterminate
      if (entry.isDirectory()) {
        if (WEB_SCAN_SKIP_DIRS.includes(entry.name)) continue;
        if (depth + 1 <= WEB_SCAN_MAX_DEPTH) {
          queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        }
        continue;
      }
      if (WEB_ASSET_EXTENSIONS.includes(path.extname(entry.name))) return true;
    }
  }
  return rootRead ? false : null;
}

/**
 * `target: "web"` applicability from the consumer's checkout: route globs, a
 * web framework dependency, or a web asset. Fails OPEN when indeterminate — a
 * wasted lens run is recoverable, silently dropped coverage is not.
 *
 * @param {{ config?: object|null, projectRoot?: string }} [params]
 * @returns {boolean}
 */
export function hasWebSurface({ config, projectRoot = PROJECT_ROOT } = {}) {
  if (resolveNavigabilityRouteGlobs(config).length > 0) return true;

  if (_webSurfaceFsCache.has(projectRoot)) {
    return _webSurfaceFsCache.get(projectRoot);
  }

  const declared = declaresWebFramework(projectRoot);
  // `null` is indeterminate, not false — fail open.
  const result =
    declared === null || declared === true
      ? true
      : scanForWebAssets(projectRoot) !== false;

  _webSurfaceFsCache.set(projectRoot, result);
  return result;
}

/** ORMs / query builders, matched segment-wise (`@prisma/client` → `prisma`). */
const ORM_PACKAGES = Object.freeze([
  'prisma',
  'drizzle-orm',
  'typeorm',
  'sequelize',
  'mongoose',
  'knex',
  'objection',
  'kysely',
  'mikro-orm',
  'bookshelf',
  'waterline',
]);

const PERSISTENCE_SCHEMA_EXTENSIONS = Object.freeze(['.sql', '.prisma']);

const MIGRATION_DIR_NAMES = Object.freeze(['migrations', 'migrate']);

/**
 * A migrations directory counts only under one of these parents, so unrelated
 * ones (e.g. Mandrel's own `lib/migrations/`) are not persistence markers.
 */
const DB_MIGRATION_PARENTS = Object.freeze([
  'db',
  'database',
  'prisma',
  'drizzle',
  'supabase',
  'sql',
]);

/** @type {Map<string, boolean>} */
const _persistenceFsCache = new Map();

/** Test-only. */
export function _resetPersistenceLayerCache() {
  _persistenceFsCache.clear();
}

/**
 * @param {string} root
 * @returns {boolean|null}
 */
function declaresOrmDependency(root) {
  return declaresDependencyIn(root, ORM_PACKAGES);
}

/**
 * Unlike the web scan, an exhausted budget is `false` (these artifacts live
 * near the root); only an unreadable root is `null`.
 *
 * @param {string} root
 * @returns {boolean|null}
 */
function scanForPersistenceArtifacts(root) {
  let budget = WEB_SCAN_MAX_ENTRIES;
  const queue = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      if (dir === root) return null;
      continue;
    }

    for (const entry of entries) {
      if (budget-- <= 0) return false; // bounded near-root scan exhausted
      if (entry.isDirectory()) {
        if (WEB_SCAN_SKIP_DIRS.includes(entry.name)) continue;
        if (
          MIGRATION_DIR_NAMES.includes(entry.name) &&
          DB_MIGRATION_PARENTS.includes(path.basename(dir))
        ) {
          return true;
        }
        if (depth + 1 <= WEB_SCAN_MAX_DEPTH) {
          queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        }
        continue;
      }
      if (PERSISTENCE_SCHEMA_EXTENSIONS.includes(path.extname(entry.name))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Applicability predicate for `target: "data-model"` lenses: an ORM
 * dependency or a schema artifact. Fails OPEN like {@link hasWebSurface}.
 *
 * @param {{ config?: object|null, projectRoot?: string }} [params]
 * @returns {boolean}
 */
export function hasPersistenceLayer({ projectRoot = PROJECT_ROOT } = {}) {
  if (_persistenceFsCache.has(projectRoot)) {
    return _persistenceFsCache.get(projectRoot);
  }

  const declared = declaresOrmDependency(projectRoot);
  // `null` is indeterminate, not false — fail open.
  const result =
    declared === null || declared === true
      ? true
      : scanForPersistenceArtifacts(projectRoot) !== false;

  _persistenceFsCache.set(projectRoot, result);
  return result;
}

/** Single file × single glob, with the project's matcher semantics (`dot: true`). */
export function matchesFilePattern(pattern, file) {
  return picomatch(pattern, { dot: true })(file);
}

export function matchesAnyFilePattern(patterns, files) {
  if (!patterns?.length || !files?.length) return false;
  const matchers = patterns.map((p) => picomatch(p, { dot: true }));
  return files.some((file) => matchers.some((m) => m(file)));
}

const SOURCE_CODE_EXTENSIONS = Object.freeze([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
]);

// biome-ignore lint/complexity/useRegexLiterals: constructor form keeps the MI walker able to score this module.
const TEST_FILE_RE = new RegExp(String.raw`\.(test|spec)\.[cm]?[jt]sx?$`);
// biome-ignore lint/complexity/useRegexLiterals: constructor form keeps the MI walker able to score this module.
const TEST_DIR_RE = new RegExp(
  '(^|/)(tests?|__tests__|spec|e2e|__mocks__)(/|$)',
);
// biome-ignore lint/complexity/useRegexLiterals: constructor form keeps the MI walker able to score this module.
const CODE_EXT_RE = new RegExp(String.raw`\.[cm]?[jt]sx?$`);

/**
 * @param {string} file
 * @returns {boolean}
 */
function isTestFile(file) {
  return TEST_FILE_RE.test(file) || TEST_DIR_RE.test(file);
}

/**
 * Basename without `.test`/`.spec` infix and code extension.
 *
 * @param {string} file
 * @returns {string}
 */
function stemOf(file) {
  const base = file.split('/').pop() ?? file;
  return base.replace(TEST_FILE_RE, '').replace(CODE_EXT_RE, '');
}

/**
 * `sourceWithoutSiblingTest`: a source file changed with no same-stem test
 * in the change set.
 *
 * @param {string[]|null|undefined} changedFiles
 * @returns {boolean}
 */
export function changeSetLacksSiblingTest(changedFiles) {
  const files = (Array.isArray(changedFiles) ? changedFiles : []).filter(
    (f) => typeof f === 'string' && f.length > 0,
  );
  const testStems = new Set(
    files.filter((f) => isTestFile(f)).map((f) => stemOf(f)),
  );
  const sources = files.filter(
    (f) => !isTestFile(f) && SOURCE_CODE_EXTENSIONS.includes(path.extname(f)),
  );
  return sources.some((src) => !testStems.has(stemOf(src)));
}

/**
 * Returns `{ selectedAudits, ticketId, gate, context }`, or a degraded
 * envelope (gate-mode throws) on git timeout or an unresolvable `headRef`.
 *
 * @param {object} params
 * @param {number} params.ticketId
 * @param {string} params.gate
 * @param {import('../ITicketingProvider.js').ITicketingProvider} params.provider
 * @param {string[]} [params.changedFiles] Known change set (skips `git diff`);
 *   required post-land, where `base...head` is empty.
 * @param {string} [params.baseBranch]
 * @param {string} [params.headRef] Pass explicitly in a shared checkout.
 * @param {(cwd: string, ...args: string[]) => Promise<{status:number, stdout:string, stderr:string}>} [params.injectedGitSpawn]
 * @param {number} [params.gitTimeoutMsOverride]
 * @param {{ argv?: string[], env?: NodeJS.ProcessEnv }} [params.gateModeOpts]
 * @param {typeof hasWebSurface} [params.hasWebSurfaceFn]
 */
export async function selectAudits({
  ticketId,
  gate,
  provider,
  changedFiles: injectedChangedFiles,
  baseBranch = 'main',
  headRef = 'HEAD',
  injectedGitSpawn,
  gitTimeoutMsOverride,
  gateModeOpts,
  hasWebSurfaceFn = hasWebSurface,
  hasPersistenceLayerFn = hasPersistenceLayer,
}) {
  const config = resolveConfig();
  const timeoutMs = gitTimeoutMsOverride ?? DEFAULT_GIT_TIMEOUT_MS;
  const rulesData = await loadAuditRules(config);

  const ticket = await provider.getTicket(ticketId);
  const contentToSearch = ticketSearchText(ticket);

  const runGit = injectedGitSpawn ?? (async (...args) => gitSpawn(...args));

  const hasInjectedChangedFiles = Array.isArray(injectedChangedFiles);

  if (!hasInjectedChangedFiles && headRef !== 'HEAD') {
    const degraded = await resolveHeadRefOrDegrade({
      runGit,
      headRef,
      timeoutMs,
      gateModeOpts,
    });
    if (degraded) return degraded;
  }

  let changedFiles;
  if (hasInjectedChangedFiles) {
    changedFiles = injectedChangedFiles
      .map((f) => String(f).trim())
      .filter(Boolean);
  } else {
    const acquired = await acquireChangedFilesFromDiff({
      runGit,
      baseBranch,
      headRef,
      timeoutMs,
      gateModeOpts,
    });
    if (acquired.degraded) return acquired.degraded;
    changedFiles = acquired.files;
  }

  const selectedAudits = matchAuditRules({
    audits: rulesData.audits ?? {},
    gate,
    contentToSearch,
    changedFiles,
    projectSupportsTarget: makeTargetApplicabilityProbe({
      config,
      hasWebSurfaceFn,
      hasPersistenceLayerFn,
    }),
  });

  return {
    selectedAudits,
    ticketId,
    gate,
    context: {
      changedFiles,
      changedFilesCount: changedFiles.length,
      // Callers assert this matches the requested branch. `null` when injected:
      // no ref was diffed, so none may pass that assertion.
      resolvedRef: hasInjectedChangedFiles ? null : headRef,
      ticketTitle: ticket.title,
    },
  };
}

/**
 * @param {object} config Resolved `.agentrc.json` wrapper.
 * @returns {Promise<object>}
 */
async function loadAuditRules(config) {
  const rulesPath = path.join(
    PROJECT_ROOT,
    getPaths(config).schemasRoot,
    'audit-rules.json',
  );
  try {
    return JSON.parse(await fs.readFile(rulesPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Failed to read audit-rules from ${rulesPath}: ${err.message}`,
    );
  }
}

function ticketSearchText(ticket) {
  return `${ticket.title || ''} ${ticket.body || ''}`.toLowerCase();
}

/**
 * An unresolvable `headRef` would silently diff a different change set, so it
 * degrades instead. Returns `null` when it resolves.
 *
 * @param {{ runGit: Function, headRef: string, timeoutMs: number, gateModeOpts?: object }} params
 * @returns {Promise<object|null>}
 */
async function resolveHeadRefOrDegrade({
  runGit,
  headRef,
  timeoutMs,
  gateModeOpts,
}) {
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
  return null;
}

/**
 * A non-zero diff yields `{ files: [] }`; a timeout yields `{ degraded }`.
 *
 * @param {{ runGit: Function, baseBranch: string, headRef: string, timeoutMs: number, gateModeOpts?: object }} params
 * @returns {Promise<{ files?: string[], degraded?: object }>}
 */
async function acquireChangedFilesFromDiff({
  runGit,
  baseBranch,
  headRef,
  timeoutMs,
  gateModeOpts,
}) {
  let diff;
  try {
    diff = await withTimeout(
      runGit(
        process.cwd(),
        'diff',
        '--name-only',
        `${baseBranch}...${headRef}`,
      ),
      timeoutMs,
      { label: 'select-audits git diff' },
    );
  } catch (err) {
    if (err?.code === 'ETIMEDOUT') {
      // Degrade rather than fall through to keyword-only matching.
      return {
        degraded: softFailOrThrow(
          'GIT_DIFF_TIMEOUT',
          `select-audits: git diff against ${baseBranch} timed out after ${timeoutMs} ms`,
          gateModeOpts,
        ),
      };
    }
    throw err;
  }
  if (diff?.status !== 0) return { files: [] };
  return {
    files: diff.stdout
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean),
  };
}

/**
 * Whole-word match: a substring test fires on fragments ("auth" in "author").
 *
 * @param {string[]} keywords
 * @param {string} content Lower-cased ticket text.
 * @returns {boolean}
 */
function matchesAnyKeyword(keywords, content) {
  return keywords.some((kw) => {
    const escaped = kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(content);
  });
}

/**
 * Lazily memoized per target, so a roster without a `web` lens never pays the
 * filesystem scan.
 *
 * @param {{ config: object, hasWebSurfaceFn: Function, hasPersistenceLayerFn: Function }} params
 * @returns {(target: string) => boolean}
 */
function makeTargetApplicabilityProbe({
  config,
  hasWebSurfaceFn,
  hasPersistenceLayerFn,
}) {
  const probes = {
    web: hasWebSurfaceFn,
    'data-model': hasPersistenceLayerFn,
  };
  const memo = new Map();
  return (target) => {
    if (!memo.has(target)) {
      const probe = probes[target];
      memo.set(target, probe ? probe({ config }) : true);
    }
    return memo.get(target);
  };
}

/**
 * @param {object} triggers The lens's `triggers` block.
 * @param {string} contentToSearch Lower-cased ticket text.
 * @param {string[]} changedFiles
 * @returns {boolean}
 */
function lensTriggerFires(triggers, contentToSearch, changedFiles) {
  return (
    matchesAnyKeyword(triggers.keywords || [], contentToSearch) ||
    matchesAnyFilePattern(triggers.filePatterns || [], changedFiles) ||
    (triggers.sourceWithoutSiblingTest === true &&
      changeSetLacksSiblingTest(changedFiles))
  );
}

/**
 * @param {{
 *   audits: Record<string, object>,
 *   gate: string,
 *   contentToSearch: string,
 *   changedFiles: string[],
 *   projectSupportsTarget: (target: string) => boolean,
 * }} params
 * @returns {string[]} Selected lens identifiers, in manifest order.
 */
function matchAuditRules({
  audits,
  gate,
  contentToSearch,
  changedFiles,
  projectSupportsTarget,
}) {
  const selectedAudits = [];
  for (const [auditName, ruleOpts] of Object.entries(audits)) {
    const triggers = ruleOpts.triggers || {};

    if (!triggers.gates?.includes(gate)) continue;

    // An inapplicable lens still keyword-matches prose (`audit-seo` on
    // `<!-- meta: -->`); listing it teaches operators to skip listed lenses.
    const { target } = ruleOpts;
    if (target && target !== 'any' && !projectSupportsTarget(target)) continue;

    if (lensTriggerFires(triggers, contentToSearch, changedFiles)) {
      selectedAudits.push(auditName);
    }
  }
  return selectedAudits;
}
