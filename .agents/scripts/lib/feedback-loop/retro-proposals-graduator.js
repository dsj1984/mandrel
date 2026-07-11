/**
 * retro-proposals-graduator.js — Auto-graduate the retro's actionable
 * routed proposals into GitHub follow-up issues. Story #4418 / Epic #4406.
 *
 * This is the loop's terminal junction: the retro composer
 * (`retro-proposals.js`) already split the Epic's source-tagged friction
 * into `framework` / `consumer` actionable items, each carrying a
 * pre-drafted `gh issue create` command stanza. Historically an operator
 * had to copy-paste those stanzas by hand, so `/plan` Phase 0's
 * `recurringDefectClasses` stayed empty unless someone remembered to run
 * the commands. This module files them mechanically instead — the retro
 * body then lists the real filed issue numbers rather than paste-ready
 * commands.
 *
 * Built on the graduator-core **pre-parsed-findings seam** (Story #4415):
 * the routed proposals are handed to `graduate()` as a pre-parsed
 * `findings` array, so there is no structured-comment parsing. The
 * proposals are not file-scoped, so each finding is **path-less** — the
 * seam skips the `git cat-file` path-exists gate rather than misclassifying
 * the finding `file-removed`.
 *
 * Routing correctness: a routed item already knows its source
 * (`framework` / `consumer`), so we file each source bucket with its own
 * constant classifier and thread the graduator's per-run filing cap across
 * the two buckets. The `meta::<framework-gap|consumer-improvement>` +
 * `friction::<category>` labels are lifted verbatim from the routed item.
 *
 * Behind the `delivery.feedbackLoop.retroProposals` toggle (default ON,
 * per `graduator-core.js#makeIsAutoFileEnabled`). NEVER throws — every
 * failure path is captured in `errors[]`.
 */

import { META_LABELS } from '../label-constants.js';
import { DEFAULT_FRAMEWORK_REPO } from '../orchestration/retro/phases/gather-signals.js';
import {
  contentFingerprint,
  DEFAULT_MAX_FILINGS_PER_RUN,
  graduate,
  makeIsAutoFileEnabled,
} from './graduator-core.js';

/**
 * Resolve the toggle from the resolved agentrc config. Defaults to `true`
 * — the feature is opt-out (mirrors auditResultsAutoFile).
 *
 * @param {object|undefined|null} config
 * @returns {boolean}
 */
export const isAutoFileEnabled = makeIsAutoFileEnabled('retroProposals');

/**
 * Build the content-hash idempotency marker embedded in freshly filed
 * follow-up bodies. Derived from the proposal's CATEGORY (retro proposals
 * are path-less and the rendered title embeds a mutable recurrence count)
 * so the marker is stable across sibling insert/remove/reorder churn AND
 * across re-runs that change the count. An HTML comment so it survives
 * markdown rendering but stays indexable via `gh search`.
 *
 * @param {number} epicId
 * @param {{ category?: string, title?: string }} finding
 * @returns {string}
 */
export function buildContentMarker(epicId, finding) {
  // Fingerprint on the CATEGORY only — never the rendered title. The
  // title embeds the mutable recurrence count ("… recurred <N> times in
  // Epic #X"), so hashing it made a retro re-run after the count changed
  // mint a fresh fingerprint and re-file a duplicate issue for the same
  // category. The idempotency identity of a retro proposal is
  // (epic, category); the epic id is already carried in the marker text.
  const fp = contentFingerprint({
    category: finding.category,
    path: '',
    title: '',
  });
  return `<!-- retro-proposal-followup: epic-${epicId}-${fp} -->`;
}

/**
 * Map a routed source to its `meta::*` routing label.
 *
 * @param {string} source
 * @returns {string}
 */
function metaSourceLabel(source) {
  return source === 'framework'
    ? META_LABELS.FRAMEWORK_GAP
    : META_LABELS.CONSUMER_IMPROVEMENT;
}

/**
 * The per-graduator behaviour bundle for the retro-proposals walk. Bound to
 * a single source so the constant classifier routes every finding in the
 * bucket to the correct repo (and the label reflects that source).
 *
 * @param {'framework'|'consumer'} source
 * @returns {object}
 */
function makeSpec(source) {
  return {
    fnName: 'graduateRetroProposals',
    isAutoFileEnabled,
    // Pre-parsed seam: the comment marker / parser are never consulted
    // (findings are supplied directly), but the fields are declared for the
    // shared walk's shape.
    commentMarker: '<!-- structured-comment: retro -->',
    noCommentReason: 'no-retro-comment',
    parseFindings: () => [],
    buildContentMarker,
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
 * Convert a routed-proposal item into a pre-parsed, path-less finding for
 * the shared `graduate()` walk.
 *
 * @param {object} item — a `RoutedItem` from `composeRoutedProposals`.
 * @param {'framework'|'consumer'} source
 * @param {number} index
 * @returns {object}
 */
function toFinding(item, source, index) {
  return {
    index,
    // Path-less — the retro proposals are not file-scoped, so the seam
    // skips the path-exists gate rather than probing an empty path.
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
 * File the retro's actionable routed proposals as GitHub follow-up issues
 * via the graduator pre-parsed-findings seam. Files the `framework` and
 * `consumer` buckets, threading the per-run filing cap across both so the
 * overall cap is respected. Never throws.
 *
 * @param {object} opts
 * @param {number} opts.epicId
 * @param {object} opts.provider — ticketing provider (getTicketComments;
 *   postComment for the cross-repo-deferred persistence).
 * @param {object} [opts.config] — resolved agentrc.
 * @param {{owner: string, repo: string}} opts.currentRepo — the repo the
 *   retro is running inside (the consumer's own repo); the cross-repo guard's
 *   anchor.
 * @param {{owner: string, repo: string}} [opts.frameworkRepo] — where
 *   framework-tagged proposals route.
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
      // Each bucket's source is known — a constant classifier routes the
      // whole bucket to the correct repo and stamps the correct label.
      classifier: () => source,
      ghPath,
      spawnImpl,
      cwd,
      timeoutMs,
      maxFilingsPerRun: Math.max(0, remaining),
      findings,
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
 * Pure: extract the trailing issue number from a `gh issue create` URL
 * (`https://github.com/o/r/issues/123` → 123). Returns `null` when no
 * trailing number is present.
 *
 * @param {string|null|undefined} url
 * @returns {number|null}
 */
export function issueNumberFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

/**
 * Pure: return a NEW `routedProposals` whose `framework` / `consumer` items
 * each carry a `filedIssue` field ({ url, number }) when the graduator filed
 * an issue for that item's `source` + `category`. Items with no matching
 * filing are copied unchanged (the body renderer then falls back to the
 * command stanza). The `discarded` bucket is passed through untouched.
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
 * Parse an `"<owner>/<repo>"` slug into `{ owner, repo }`, or `null` when
 * the slug is empty / malformed.
 *
 * @param {string|null|undefined} slug
 * @returns {{ owner: string, repo: string } | null}
 */
export function parseRepoSlug(slug) {
  if (typeof slug !== 'string') return null;
  const parts = slug.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Orchestrating seam invoked by the retro post-and-mirror phase: gate the
 * toggle, file the routed proposals, and return the routed proposals
 * enriched with the filed issue references so the body composer renders real
 * issue numbers instead of command stanzas. Never throws — a filing failure
 * degrades to the unenriched proposals (the composer falls back to command
 * stanzas) and the error is surfaced in `errors[]`.
 *
 * @param {object} opts
 * @param {number} opts.epicId
 * @param {object} opts.provider
 * @param {object} [opts.config]
 * @param {string} [opts.frameworkRepo] — `"<owner>/<repo>"` slug.
 * @param {string} [opts.consumerRepo] — `"<owner>/<repo>"` slug (currentRepo).
 * @param {{ framework?: object[], consumer?: object[], discarded?: object[] }} [opts.routedProposals]
 * @param {string} [opts.ghPath]
 * @param {Function} [opts.spawnImpl]
 * @param {string} [opts.cwd]
 * @param {number} [opts.maxFilingsPerRun]
 * @param {{info?: Function, warn?: Function}} [opts.logger]
 * @param {Function} [opts.graduateFn] — test seam; defaults to
 *   {@link graduateRetroProposals}.
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

  // Toggle OFF → leave proposals unenriched; the composer renders the
  // paste-ready command stanzas.
  if (!isAutoFileEnabled(config)) return passthrough('toggle-disabled');

  const currentRepo = parseRepoSlug(consumerRepo);
  if (!currentRepo) {
    // No resolvable consumer repo — the retro already disables the consumer
    // pane loudly; skip filing and fall back to command stanzas.
    logger?.warn?.(
      '[retro-proposals-graduator] No resolvable consumer repo — skipping auto-file (falling back to command stanzas).',
    );
    return passthrough('no-current-repo');
  }
  // Framework-repo fallback parity with `gatherRetroSignals`
  // (gather-signals.js): an unconfigured `github.frameworkRepo` falls
  // back to the Mandrel mirror constant, NEVER to the consumer's own
  // repo — the prior `?? currentRepo` fallback silently auto-filed
  // framework-tagged proposals into the consumer's repo while the retro
  // body rendered them under "framework repo" (masked in this repo only
  // because consumer === framework here).
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

export default graduateRetroProposals;
