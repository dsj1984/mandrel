/**
 * Files the retro's routed `framework`/`consumer` proposals as follow-up
 * issues via `graduate()`, as path-less pre-parsed findings, so the retro
 * body can list real issue numbers instead of paste-ready commands. Opt-in
 * via `delivery.feedbackLoop.retroProposals`; never throws.
 */

import {
  DEFAULT_FRAMEWORK_REPO,
  parseRepoSlug,
} from '../github/framework-repo.js';
import { META_LABELS } from '../label-constants.js';
import {
  contentFingerprint,
  DEFAULT_MAX_FILINGS_PER_RUN,
  graduate,
  makeIsAutoFileEnabled,
} from './graduator-core.js';

/**
 * @param {object|undefined|null} config
 * @returns {boolean}
 */
export const isAutoFileEnabled = makeIsAutoFileEnabled('retroProposals');

/**
 * Category only: the title embeds a mutable recurrence count, so hashing it
 * would re-file a duplicate whenever the count changed.
 *
 * @param {{ category?: string }} finding
 * @returns {string}
 */
function proposalFingerprint(finding) {
  return contentFingerprint({
    category: finding?.category,
    path: '',
    title: '',
  });
}

/**
 * Anchor-free: a run anchor changes every run, so a marker carrying it could
 * never match a prior filing. The category alone is the identity.
 *
 * @param {number} _epicId — unused; `graduate()` owns the signature.
 * @param {{ category?: string }} finding
 * @returns {string}
 */
export function buildContentMarker(_epicId, finding) {
  return `<!-- retro-proposal-followup: ${proposalFingerprint(finding)} -->`;
}

/**
 * The current marker plus `-<fp> -->`, the tail of every older anchored
 * marker (`…: epic-<anchor>-<fp> -->`), so those filings still dedup.
 *
 * @param {{ finding: { category?: string }, contentMarker: string }} args
 * @returns {string[]}
 */
function buildMatchTokens({ finding, contentMarker }) {
  return [contentMarker, `-${proposalFingerprint(finding)} -->`];
}

/**
 * @param {string} source
 * @returns {string}
 */
function metaSourceLabel(source) {
  return source === 'framework'
    ? META_LABELS.FRAMEWORK_GAP
    : META_LABELS.CONSUMER_IMPROVEMENT;
}

/**
 * @param {'framework'|'consumer'} source
 * @returns {object}
 */
function makeSpec(source) {
  return {
    fnName: 'graduateRetroProposals',
    isAutoFileEnabled,
    buildContentMarker,
    buildMatchTokens,
    crossRepoCommentAttrs: { graduator: 'retro-proposals' },
    decorateRecord: (record, finding) => {
      record.category = finding.category;
      record.title = finding.title;
      return record;
    },
    buildCrossRepoLog: ({ finding, routedRepo }) =>
      `[retro-proposals-graduator] cross-repo skip (would file in ${routedRepo.owner}/${routedRepo.repo}): ${
        finding.command ??
        `gh issue create --title "${finding.title}" --label "${metaSourceLabel(source)},friction::${finding.category}"`
      }`,
    buildFollowUp: ({ finding, source: routedSource, idMarker }) => {
      const labels = [
        metaSourceLabel(routedSource),
        `friction::${finding.category}`,
      ];
      const title = finding.title;
      const body = [idMarker, '', finding.body ?? ''].join('\n');
      return { title, body, labels };
    },
  };
}

/**
 * @param {object} item — a `RoutedItem` from `composeRoutedProposals`.
 * @param {'framework'|'consumer'} source
 * @param {number} index
 * @returns {object}
 */
function toFinding(item, source, index) {
  return {
    index,
    path: '',
    severity: 'friction',
    category: typeof item?.category === 'string' ? item.category : '',
    source,
    occurrences:
      typeof item?.occurrences === 'number' ? item.occurrences : undefined,
    title: typeof item?.title === 'string' ? item.title : '',
    body: typeof item?.body === 'string' ? item.body : '',
    command: typeof item?.command === 'string' ? item.command : '',
  };
}

/**
 * The per-run filing cap is threaded across both buckets. Never throws.
 *
 * @param {object} opts
 * @param {number} opts.epicId
 * @param {object} opts.provider
 * @param {object} [opts.config]
 * @param {{owner: string, repo: string}} opts.currentRepo
 * @param {{owner: string, repo: string}} [opts.platformRepo]
 * @param {{owner: string, repo: string}} [opts.frameworkRepo]
 * @param {{ framework?: object[], consumer?: object[] }} [opts.routedProposals]
 * @param {string} [opts.ghPath='gh']
 * @param {Function} [opts.spawnImpl]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxFilingsPerRun]
 * @param {{info?: Function, warn?: Function, debug?: Function}} [opts.logger]
 * @returns {Promise<{
 *   filed: Array<{ index: number, source: string, repo: string, url: string|null, category: string, title: string }>,
 *   skipped: Array<{ index?: number, reason: string, category?: string, title?: string }>,
 *   errors: string[],
 * }>}
 */
export async function graduateRetroProposals({
  epicId,
  provider,
  config,
  currentRepo,
  frameworkRepo,
  platformRepo,
  routedProposals,
  ghPath,
  spawnImpl,
  cwd,
  timeoutMs,
  maxFilingsPerRun = DEFAULT_MAX_FILINGS_PER_RUN,
  logger,
} = {}) {
  const envelope = { filed: [], skipped: [], errors: [] };

  if (!isAutoFileEnabled(config)) {
    return { filed: [], skipped: [{ reason: 'toggle-disabled' }], errors: [] };
  }

  const framework = Array.isArray(routedProposals?.framework)
    ? routedProposals.framework
    : [];
  const consumer = Array.isArray(routedProposals?.consumer)
    ? routedProposals.consumer
    : [];
  if (framework.length === 0 && consumer.length === 0) {
    return {
      filed: [],
      skipped: [{ reason: 'no-actionable-proposals' }],
      errors: [],
    };
  }

  const buckets = [
    { source: 'framework', items: framework },
    { source: 'consumer', items: consumer },
  ];

  // Shared across buckets: both mint the same marker for a category, so the
  // second bucket short-circuits the repeat without a spawn.
  const filedMarkers = new Set();

  const labelCache = new Map();

  let remaining = maxFilingsPerRun;
  for (const { source, items } of buckets) {
    if (items.length === 0) continue;
    const findings = items.map((item, i) => toFinding(item, source, i));
    const res = await graduate({
      epicId,
      provider,
      config,
      currentRepo,
      frameworkRepo,
      platformRepo,
      classifier: () => source,
      ghPath,
      spawnImpl,
      cwd,
      timeoutMs,
      maxFilingsPerRun: Math.max(0, remaining),
      findings,
      filedMarkers,
      labelCache,
      logger,
      spec: makeSpec(source),
    });
    envelope.filed.push(...res.filed);
    envelope.skipped.push(...res.skipped);
    envelope.errors.push(...res.errors);
    remaining -= res.filed.length;
  }

  return envelope;
}

/**
 * @param {string|null|undefined} url
 * @returns {number|null}
 */
export function issueNumberFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

/**
 * Attach `filedIssue: { url, number }` to items matched by
 * `source:category`; unmatched items render their command stanza.
 *
 * @param {{ framework?: object[], consumer?: object[], discarded?: object[] } | null | undefined} routedProposals
 * @param {Array<{ source?: string, category?: string, url?: string|null }>} filed
 * @returns {{ framework: object[], consumer: object[], discarded: object[] }}
 */
export function enrichRoutedProposalsWithFilings(routedProposals, filed) {
  const framework = Array.isArray(routedProposals?.framework)
    ? routedProposals.framework
    : [];
  const consumer = Array.isArray(routedProposals?.consumer)
    ? routedProposals.consumer
    : [];
  const discarded = Array.isArray(routedProposals?.discarded)
    ? routedProposals.discarded
    : [];

  const byKey = new Map();
  for (const record of Array.isArray(filed) ? filed : []) {
    if (!record || typeof record.url !== 'string' || record.url.length === 0) {
      continue;
    }
    const key = `${record.source}:${record.category}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        url: record.url,
        number: issueNumberFromUrl(record.url),
      });
    }
  }

  const enrich = (items, source) =>
    items.map((item) => {
      const filedIssue = byKey.get(`${source}:${item?.category}`);
      return filedIssue ? { ...item, filedIssue } : item;
    });

  return {
    framework: enrich(framework, 'framework'),
    consumer: enrich(consumer, 'consumer'),
    discarded,
  };
}

/**
 * File, then enrich the proposals with the filed issues. Never throws: a
 * failure degrades to the unenriched proposals plus an `errors[]` entry.
 *
 * @param {object} opts
 * @param {number} opts.epicId
 * @param {object} opts.provider
 * @param {object} [opts.config]
 * @param {string} [opts.frameworkRepo] — `"<owner>/<repo>"` slug.
 * @param {string} [opts.consumerRepo] — `"<owner>/<repo>"` slug.
 * @param {{ framework?: object[], consumer?: object[], discarded?: object[] }} [opts.routedProposals]
 * @param {string} [opts.ghPath]
 * @param {Function} [opts.spawnImpl]
 * @param {string} [opts.cwd]
 * @param {number} [opts.maxFilingsPerRun]
 * @param {{info?: Function, warn?: Function}} [opts.logger]
 * @param {Function} [opts.graduateFn]
 * @returns {Promise<{ routedProposals: object|null, summary: { filed: object[], skipped: object[], errors: string[] } }>}
 */
export async function fileRetroProposals({
  epicId,
  provider,
  config,
  frameworkRepo,
  consumerRepo,
  routedProposals,
  ghPath,
  spawnImpl,
  cwd,
  maxFilingsPerRun,
  logger,
  graduateFn = graduateRetroProposals,
} = {}) {
  const passthrough = (reason) => ({
    routedProposals,
    summary: { filed: [], skipped: reason ? [{ reason }] : [], errors: [] },
  });

  if (!isAutoFileEnabled(config)) return passthrough('toggle-disabled');

  const currentRepo = parseRepoSlug(consumerRepo);
  if (!currentRepo) {
    logger?.warn?.(
      '[retro-proposals-graduator] No resolvable consumer repo — skipping auto-file (falling back to command stanzas).',
    );
    return passthrough('no-current-repo');
  }
  // Fall back to the Mandrel constant, never the consumer's own repo.
  const frameworkRepoObj =
    parseRepoSlug(frameworkRepo) ?? parseRepoSlug(DEFAULT_FRAMEWORK_REPO);

  let summary;
  try {
    summary = await graduateFn({
      epicId,
      provider,
      config,
      currentRepo,
      frameworkRepo: frameworkRepoObj,
      routedProposals,
      ghPath,
      spawnImpl,
      cwd,
      maxFilingsPerRun,
      logger,
    });
  } catch (err) {
    logger?.warn?.(
      `[retro-proposals-graduator] Auto-file failed (falling back to command stanzas): ${err?.message ?? err}`,
    );
    return {
      routedProposals,
      summary: {
        filed: [],
        skipped: [],
        errors: [`fileRetroProposals: ${err?.message ?? err}`],
      },
    };
  }

  const enriched = enrichRoutedProposalsWithFilings(
    routedProposals,
    summary.filed,
  );
  return { routedProposals: enriched, summary };
}
