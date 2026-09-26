/**
 * Shared graduator walk: route → path probe → idempotency probe → cap → file.
 * A graduator injects only its title/body/label/marker builders (`spec`).
 * The walk is bounded (spawn timeouts, per-run filing cap) and replay-safe
 * (content-hash markers survive sibling reordering).
 */

import { createHash } from 'node:crypto';

import { inNodeTestContext } from '../config/temp-paths.js';
import { classifyPathSource as defaultClassifier } from '../observability/source-classifier.js';
import { upsertStructuredComment } from '../orchestration/ticketing.js';
import {
  dedupFinding,
  fileFinding,
  probeFindingPath,
  recordRecurrence,
  routeFinding,
} from './graduate-steps.js';
import {
  DEFAULT_RUN_CHILD_TIMEOUT_MS,
  searchFollowUpByMarker,
} from './graduator-gh.js';

export {
  createFollowUpIssue,
  ensureIssueLabels,
  probePathStatus,
  runChild,
  updateFollowUpIssue,
} from './graduator-gh.js';

export const DEFAULT_MAX_FILINGS_PER_RUN = 20;

/** @returns {Promise<boolean>} */
export async function probeMarkerExists(opts) {
  return (await searchFollowUpByMarker(opts)) !== null;
}

/** Registered in `STRUCTURED_COMMENT_TYPES`. */
const CROSS_REPO_DEFERRED_COMMENT_TYPE = 'cross-repo-deferred';

/** Explicit, greppable opt-in to live filing from a context the guard refuses. */
const ALLOW_LIVE_FILING_ENV = 'MANDREL_ALLOW_LIVE_ISSUE_FILING';

const LIVE_FILING_BLOCKED_REASON = 'live-api-guard';

const NON_PRODUCTION_NODE_ENVS = new Set(['test', 'development']);

/**
 * Decide whether the walk may reach the live GitHub API. Allowed only when
 * `spawnImpl` is injected (no child reaches `gh`) or the process is provably
 * not a test/development run. Fails closed — an undecidable env refuses — and
 * refusal is a skip, never a throw: observability must not fail a close.
 *
 * @param {object} opts
 * @param {Function} [opts.spawnImpl]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string[]} [opts.execArgv]
 * @returns {{ allowed: boolean, reason: string|null }}
 */
function resolveFilingContext({
  spawnImpl,
  env = process.env,
  execArgv = process.execArgv,
} = {}) {
  const refuse = { allowed: false, reason: LIVE_FILING_BLOCKED_REASON };
  const allow = { allowed: true, reason: null };

  if (typeof spawnImpl === 'function') return allow;

  if (env === null || typeof env !== 'object' || !Array.isArray(execArgv)) {
    return refuse;
  }
  try {
    if (env[ALLOW_LIVE_FILING_ENV] === '1') return allow;
    if (inNodeTestContext(env, execArgv)) return refuse;
    // The suite stamps NODE_ENV=test; the close path sets neither value.
    return NON_PRODUCTION_NODE_ENVS.has(String(env.NODE_ENV ?? ''))
      ? refuse
      : allow;
  } catch {
    return refuse;
  }
}

/**
 * Position-independent `category|path|title` digest, so a marker survives
 * sibling reordering (SHA-256 truncated to 16 hex).
 *
 * @param {{ category?: unknown, path?: unknown, title?: unknown }} parts
 * @returns {string} 16-char lowercase hex digest.
 */
export function contentFingerprint({ category, path, title } = {}) {
  const norm = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const canonical = `${norm(category)}|${norm(path)}|${norm(title)}`;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Opt-in `delivery.feedbackLoop.<key>` reader: only an explicit `true`
 * enables filing, because unattended filings were dominated by noise.
 *
 * @param {string} toggleKey
 * @returns {(config: object|undefined|null) => boolean}
 */
export function makeIsAutoFileEnabled(toggleKey) {
  return function isAutoFileEnabled(config) {
    return config?.delivery?.feedbackLoop?.[toggleKey] === true;
  };
}

/**
 * `null` when all pass, else a partial envelope to short-circuit on. The
 * provider is deliberately not gated: only the best-effort cross-repo upsert
 * needs it, and that reports its own faults.
 */
function checkGraduatePreconditions({ epicId, currentRepo, config, spec }) {
  if (!spec.isAutoFileEnabled(config)) {
    return { skipped: [{ reason: 'toggle-disabled' }] };
  }
  if (!Number.isInteger(epicId) || epicId < 1) {
    return { errors: [`${spec.fnName}: missing or invalid epicId`] };
  }
  if (
    !currentRepo ||
    typeof currentRepo.owner !== 'string' ||
    typeof currentRepo.repo !== 'string'
  ) {
    return { errors: [`${spec.fnName}: missing currentRepo {owner,repo}`] };
  }
  return null;
}

function makeSkip({ envelope, decorate, finding }) {
  return (reason) =>
    envelope.skipped.push(
      decorate(
        {
          index: finding.index,
          reason,
          path: finding.path,
          severity: finding.severity,
        },
        finding,
      ),
    );
}

/** Walk one finding; every outcome lands on `ctx.envelope`. */
async function processGraduateFinding(ctx) {
  const { finding, epicId, spec } = ctx;
  const skip = makeSkip(ctx);
  const pathSkip = await probeFindingPath(ctx);
  if (pathSkip) return skip(pathSkip);

  const route = routeFinding(ctx);
  if (route.deferred) {
    ctx.crossRepoDeferred.push(route.deferred);
    return skip(route.skipReason);
  }

  const contentMarker = spec.buildContentMarker(epicId, finding);
  // In-process memo closes the same-invocation race the search index cannot.
  if (ctx.filedMarkers?.has(contentMarker)) return skip('already-filed');

  const walk = { ...ctx, ...route, contentMarker, skip };
  const existing = await dedupFinding(walk);
  // The strong read scopes by these labels and a recurrence writes this body.
  const followUp = spec.buildFollowUp({
    finding,
    source: route.source,
    epicId,
    idMarker: contentMarker,
  });
  if (existing) return recordRecurrence(walk, existing, followUp.body);
  return fileFinding(walk, followUp);
}

function renderCrossRepoDeferredBody(deferred, spec) {
  const header =
    spec.crossRepoCommentHeader ??
    '### Cross-repo-deferred findings\n\nThese findings route to a different repository and were **not** filed here. They are recorded for a cross-repo follow-up pass.';
  const rows = deferred.map(({ finding, routedRepo, logLine, missingKey }) => {
    const path =
      typeof finding.path === 'string' && finding.path.length > 0
        ? `\`${finding.path}\``
        : '_(no path)_';
    const destination = routedRepo
      ? `${routedRepo.owner}/${routedRepo.repo}`
      : `**unroutable** (\`${missingKey}\` is unset)`;
    return [
      `- ${path} (severity: ${finding.severity ?? 'n/a'}) → ${destination}`,
      `  - ${logLine}`,
    ].join('\n');
  });
  return [header, '', ...rows].join('\n');
}

/** Best-effort upsert; failures land in `envelope.errors`, never thrown. */
async function persistCrossRepoDeferred({
  epicId,
  provider,
  crossRepoDeferred,
  spec,
  envelope,
}) {
  if (typeof provider?.postComment !== 'function') return;
  try {
    const body = renderCrossRepoDeferredBody(crossRepoDeferred, spec);
    await upsertStructuredComment(
      provider,
      epicId,
      CROSS_REPO_DEFERRED_COMMENT_TYPE,
      body,
      spec.crossRepoCommentAttrs ?? null,
    );
  } catch (err) {
    envelope.errors.push(
      `cross-repo-deferred comment upsert failed: ${err?.message ?? err}`,
    );
  }
}

/**
 * Never throws; every failure lands in `errors[]`. Each finding carries
 * `{ severity, path, summary, index }`. `spec` supplies `buildContentMarker`,
 * `buildLegacyMarker`, optional `buildMatchTokens` (strong-read substrings,
 * default `[contentMarker]`), `buildFollowUp`, `buildCrossRepoLog`,
 * `decorateRecord`, and `crossRepoCommentAttrs`.
 *
 * @param {object} opts
 * @param {number} opts.epicId
 * @param {object} opts.provider
 * @param {object} [opts.config]
 * @param {{owner: string, repo: string}} opts.currentRepo
 * @param {{owner: string, repo: string}} [opts.frameworkRepo] — absent means
 *   unroutable, never the consumer's repo.
 * @param {{owner: string, repo: string}} [opts.platformRepo]
 * @param {string} [opts.gitRef='HEAD']
 * @param {Function} [opts.classifier=classifyPathSource]
 * @param {string} [opts.ghPath='gh']
 * @param {Function} [opts.spawnImpl]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxFilingsPerRun]
 * @param {Array<object>} opts.findings — a non-array is an error, not a no-op.
 * @param {Set<string>} [opts.filedMarkers] — share across calls of one
 *   invocation so a repeat short-circuits without a spawn.
 * @param {Map<string, Set<string>>} [opts.labelCache] — share likewise.
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string[]} [opts.execArgv]
 * @param {{info?: Function, warn?: Function, debug?: Function}} [opts.logger]
 * @param {object} opts.spec
 * @returns {Promise<{ filed: object[], skipped: object[], errors: string[] }>}
 */
export async function graduate({
  epicId,
  provider,
  config,
  currentRepo,
  frameworkRepo,
  platformRepo,
  gitRef = 'HEAD',
  classifier = defaultClassifier,
  ghPath = 'gh',
  spawnImpl,
  cwd,
  timeoutMs = DEFAULT_RUN_CHILD_TIMEOUT_MS,
  maxFilingsPerRun = DEFAULT_MAX_FILINGS_PER_RUN,
  findings: preParsedFindings,
  filedMarkers = new Set(),
  labelCache = new Map(),
  env,
  execArgv,
  logger,
  spec,
}) {
  const envelope = { filed: [], skipped: [], errors: [] };
  const decorate =
    typeof spec.decorateRecord === 'function'
      ? spec.decorateRecord
      : (record) => record;

  const precondition = checkGraduatePreconditions({
    epicId,
    currentRepo,
    config,
    spec,
  });
  if (precondition) return { ...envelope, ...precondition };

  if (!Array.isArray(preParsedFindings)) {
    return {
      ...envelope,
      errors: [`${spec.fnName}: findings[] is required and must be an array`],
    };
  }
  const findings = preParsedFindings;

  // Decided once, before any spawn.
  const filing = resolveFilingContext({
    spawnImpl,
    ...(env === undefined ? {} : { env }),
    ...(execArgv === undefined ? {} : { execArgv }),
  });
  if (!filing.allowed) {
    logger?.warn?.(
      `[${spec.fnName}] refusing to reach the live GitHub API: no injected spawn seam in a test or undecidable context. Set ${ALLOW_LIVE_FILING_ENV}=1 to override deliberately.`,
    );
    for (const finding of findings) {
      envelope.skipped.push(
        decorate(
          {
            index: finding.index,
            reason: filing.reason,
            path: finding.path,
            severity: finding.severity,
          },
          finding,
        ),
      );
    }
    return envelope;
  }

  const repos = {
    consumer: currentRepo,
    framework: frameworkRepo ?? null,
    platform: platformRepo ?? null,
  };
  const gh = { ghPath, spawnImpl, cwd, timeoutMs };
  const crossRepoDeferred = [];
  for (const finding of findings) {
    await processGraduateFinding({
      finding,
      envelope,
      decorate,
      epicId,
      currentRepo,
      repos,
      classifier,
      gitRef,
      gh,
      maxFilingsPerRun,
      crossRepoDeferred,
      filedMarkers,
      labelCache,
      logger,
      spec,
    });
  }

  if (crossRepoDeferred.length > 0) {
    await persistCrossRepoDeferred({
      epicId,
      provider,
      crossRepoDeferred,
      spec,
      envelope,
    });
  }

  return envelope;
}
