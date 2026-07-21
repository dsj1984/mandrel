/**
 * graduator-core.js — shared mechanism for the feedback-loop graduators.
 *
 * Story #3845 / Epic #3823. The audit-results graduator
 * (`audit-results-graduator.js`) and the code-review graduator
 * (the since-retired `code-review-graduator.js`) duplicated ~90% of their mechanism: a
 * `spawn`-based child runner, the `git cat-file` path probe, the
 * `gh search issues` idempotency probe, the `gh issue create` filer, the
 * `isAutoFileEnabled` toggle reader, and the route → probe → file
 * envelope walk. This module folds all of that into one place so the two
 * graduators become thin shells that inject the bits that genuinely
 * differ (the finding parser and the body/title/label builders).
 *
 * The third `runGh` spawn copy in `prior-feedback-fetcher.js` is also
 * collapsed onto the single `runChild` helper here.
 *
 * Story #4415 / Epic #4406 hardens the walk so it is bounded and
 * replay-safe — the shared mechanism the retro auto-filer will reuse:
 *
 *   - **Content-hash idempotency markers.** Follow-up markers derive from
 *     a `category|path|title` digest (`contentFingerprint`) instead of a
 *     `(epicId, parse-index)` ordinal, so a finding keeps its marker when
 *     sibling findings are added, removed, or reordered in the source
 *     comment, and two distinct findings never collide.
 *   - **Legacy-marker recognition.** The idempotency probe also checks the
 *     legacy `(epicId, parse-index)` marker so findings filed before the
 *     fingerprint cutover are not re-filed.
 *   - **Bounded spawns.** `runChild` enforces a caller-overridable timeout
 *     (default 30000 ms) and kills a child that overruns instead of
 *     hanging finalize forever.
 *   - **Probe-error vs confirmed-missing.** A `git cat-file` spawn failure
 *     (or timeout) records the finding as skipped `probe-error`, not the
 *     confirmed-missing `file-removed`.
 *   - **Per-run filing cap.** `graduate()` stops filing once
 *     `maxFilingsPerRun` issues are created and records the excess as
 *     skipped `cap-reached`.
 *   - **Pre-parsed / path-less seam.** `graduate()` accepts a pre-parsed
 *     `findings` array (bypassing structured-comment parsing), and a
 *     path-less finding skips the path-exists gate instead of being
 *     misclassified `file-removed` — the seam the retro auto-filer
 *     consumes.
 *   - **Durable cross-repo deferral.** Cross-repo-deferred findings are
 *     upserted into a structured comment on the Epic instead of only a
 *     log line.
 */

import { spawn as defaultSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { classifyPathSource as defaultClassifier } from '../observability/source-classifier.js';
import {
  structuredCommentMarker,
  upsertStructuredComment,
} from '../orchestration/ticketing.js';

/**
 * The single structured-comment marker for the unified `verification-results`
 * findings contract (Story #4411, Epic #4405). It replaces the two retired
 * per-graduator markers (the former code-review and audit-results
 * structured-comment markers). Both feedback-loop graduators
 * search the Epic's comments for this one marker so they file follow-ups
 * from the same unified source comment that `runCodeReview` upserts (comment
 * type `verification-results`). Derived from the canonical
 * `structuredCommentMarker` builder so the read-side marker stays byte-stable
 * with the write side rather than being hand-copied.
 */
export const VERIFICATION_RESULTS_MARKER = structuredCommentMarker(
  'verification-results',
);

/**
 * The single "no source comment" skip reason for the unified contract. Both
 * graduators surface this reason when the Epic carries no
 * `verification-results` comment, replacing the two retired
 * `no-code-review-comment` / `no-audit-results-comment` reasons.
 */
export const NO_VERIFICATION_RESULTS_COMMENT_REASON =
  'no-verification-results-comment';

/**
 * Default child-process timeout. A hung `gh`/`git` spawn previously blocked
 * finalize indefinitely; the walk now caps every spawn at this bound unless
 * a caller overrides it.
 */
export const DEFAULT_RUN_CHILD_TIMEOUT_MS = 30000;

/**
 * Default per-run filing cap. `graduate()` files at most this many follow-up
 * issues per invocation; the remainder is recorded as skipped `cap-reached`.
 */
export const DEFAULT_MAX_FILINGS_PER_RUN = 20;

/**
 * Structured-comment type used to durably persist cross-repo-deferred
 * findings on the Epic. Registered in `STRUCTURED_COMMENT_TYPES`.
 */
export const CROSS_REPO_DEFERRED_COMMENT_TYPE = 'cross-repo-deferred';

/**
 * Compute a stable content fingerprint for a finding from its
 * `category|path|title` triple. Pure — the digest depends only on the
 * finding content, never on its position in the source comment, so the
 * marker survives sibling insert/remove/reorder churn. Distinct triples
 * yield distinct digests (SHA-256, truncated to 16 hex chars for a compact
 * marker that still has a negligible collision probability across a single
 * Epic's finding set).
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
 * Spawn a child process and resolve to
 * `{ code, stdout, stderr, spawnError, timedOut }`. Never throws — spawn-time
 * errors are captured as `spawnError` and an overrun is captured as
 * `timedOut: true` with a matching `spawnError`.
 *
 * This is the single spawn helper for the feedback-loop modules. Both
 * graduators and `prior-feedback-fetcher.js` route their child-process
 * reads through it so the error envelope stays consistent. `stdio` is
 * always `['ignore', 'pipe', 'pipe']`; callers that need extra spawn
 * options (e.g. omitting `cwd`) pass `undefined` and the option is
 * dropped by the child_process layer.
 *
 * A caller-overridable `timeoutMs` (default {@link DEFAULT_RUN_CHILD_TIMEOUT_MS})
 * bounds the wait: when it elapses the child is SIGKILL'd and the promise
 * resolves with `{ code: null, timedOut: true, spawnError }` rather than
 * hanging. Pass `0`/`Infinity` to disable the watchdog.
 *
 * @param {object} opts
 * @param {string} opts.cmd — binary to spawn (e.g. "git", "gh")
 * @param {string[]} opts.args — positional + flag arguments
 * @param {Function} [opts.spawnImpl] — test seam; defaults to node:child_process spawn
 * @param {string} [opts.cwd] — working directory for the child
 * @param {number} [opts.timeoutMs] — watchdog bound in ms
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, spawnError: Error|null, timedOut: boolean }>}
 */
export function runChild({
  cmd,
  args,
  spawnImpl = defaultSpawn,
  cwd,
  timeoutMs = DEFAULT_RUN_CHILD_TIMEOUT_MS,
}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
      });
    } catch (err) {
      resolve({
        code: null,
        stdout: '',
        stderr: '',
        spawnError: err,
        timedOut: false,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill?.('SIGKILL');
        } catch {
          // Killing an already-dead / stub child is a no-op we ignore.
        }
        finish({
          code: null,
          stdout,
          stderr,
          spawnError: Object.assign(
            new Error(
              `child process '${cmd}' exceeded ${timeoutMs}ms and was killed`,
            ),
            { code: 'ETIMEDOUT' },
          ),
          timedOut: true,
        });
      }, timeoutMs);
      // Intentionally NOT unref'd: this is a watchdog timer that MUST keep
      // the event loop alive until it fires (or the child settles). A real
      // spawned child keeps the loop alive via its stdio handles, but a
      // child whose handles close early — or a stub in tests — leaves the
      // loop idle; an unref'd timer would then never fire, so the timeout
      // silently would not bound a hung spawn (and the awaiting promise
      // would hang forever). `finish()` always clearTimeout()s it, so the
      // ref'd timer never outlives its purpose.
    }
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      spawnError = err;
    });
    child.on('close', (code) => {
      finish({ code, stdout, stderr, spawnError, timedOut: false });
    });
  });
}

/**
 * Build an `isAutoFileEnabled(config)` reader bound to a specific
 * `delivery.feedbackLoop.<key>` toggle. The feature is opt-out: the
 * toggle defaults to `true` and only an explicit `false` disables it.
 *
 * @param {string} toggleKey — key under `config.delivery.feedbackLoop`
 *   (e.g. "auditResultsAutoFile", "retroProposals")
 * @returns {(config: object|undefined|null) => boolean}
 */
export function makeIsAutoFileEnabled(toggleKey) {
  return function isAutoFileEnabled(config) {
    const value = config?.delivery?.feedbackLoop?.[toggleKey];
    if (value === false) return false;
    return true;
  };
}

/**
 * Probe whether the cited path exists in the merged tree at the given git
 * ref, distinguishing a confirmed-missing file from a probe failure.
 * Resolves `{ exists, probeError }`:
 *
 *   - `git cat-file -e <ref>:<path>` exit 0        → `{ exists: true,  probeError: false }`
 *   - clean non-zero exit (file genuinely absent)  → `{ exists: false, probeError: false }`
 *   - spawn failure / timeout (cannot decide)      → `{ exists: false, probeError: true  }`
 *
 * @param {object} opts
 * @param {string} opts.ref
 * @param {string} opts.path
 * @param {Function} [opts.spawnImpl]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ exists: boolean, probeError: boolean }>}
 */
export async function probePathStatus({
  ref,
  path,
  spawnImpl,
  cwd,
  timeoutMs,
}) {
  const res = await runChild({
    cmd: 'git',
    args: ['cat-file', '-e', `${ref}:${path}`],
    spawnImpl,
    cwd,
    timeoutMs,
  });
  if (res.spawnError || res.timedOut) {
    return { exists: false, probeError: true };
  }
  return { exists: res.code === 0, probeError: false };
}

/**
 * Normalize an idempotency marker into a `gh search issues` query. Markers
 * are HTML comments (`<!-- … -->`) so they survive markdown rendering
 * without leaking into the visible body, but the `<` / `>` delimiters are
 * NOT index-safe as a query: GitHub full-text search DOES index the text
 * inside an HTML comment, yet a query that carries the `<!--` / `-->`
 * delimiters never matches that indexed text (measured against this repo,
 * Story #4657). Stripping the delimiters and trimming yields the bare marker
 * text — `retro-proposal-followup: epic-1-<fp>` — which the index matches.
 * The caller-facing marker is left untouched; normalization is the probe's
 * own concern.
 *
 * @param {string} marker
 * @returns {string}
 */
function normalizeMarkerQuery(marker) {
  if (typeof marker !== 'string') return '';
  return marker.replaceAll('<!--', '').replaceAll('-->', '').trim();
}

/**
 * Probe whether a follow-up issue carrying the given idempotency marker
 * already exists in the routed repo. Uses `gh search issues` so we hit
 * the body field directly, querying the delimiter-stripped marker text
 * (see {@link normalizeMarkerQuery}) — the raw `<!-- … -->` form never
 * matches the index. Returns `true` when at least one match is present;
 * degrades to `false` on any spawn/parse error (better to risk a duplicate
 * than swallow the finding entirely).
 */
export async function probeMarkerExists({
  marker,
  owner,
  repo,
  ghPath,
  spawnImpl,
  cwd,
  timeoutMs,
}) {
  const args = [
    'search',
    'issues',
    normalizeMarkerQuery(marker),
    '--repo',
    `${owner}/${repo}`,
    '--json',
    'number',
    '--limit',
    '1',
  ];
  const res = await runChild({ cmd: ghPath, args, spawnImpl, cwd, timeoutMs });
  if (res.spawnError || (typeof res.code === 'number' && res.code !== 0)) {
    return false;
  }
  try {
    const parsed = JSON.parse(res.stdout || '[]');
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/**
 * Strongly-consistent confirmation that a follow-up carrying `marker`
 * already exists, run ONLY on the would-file path as the last gate before
 * creating. `gh search issues` reads an eventually-consistent index whose
 * catch-up latency (measured under 20s against this repo, Story #4657) is
 * exactly wide enough to miss a byte-identical duplicate filed seconds
 * earlier in the same rollup. A label-scoped `gh issue list … --state all`
 * is strongly consistent, so it closes that window. The list is narrowed by
 * the follow-up's own labels (supplied by the same `spec.buildFollowUp` that
 * writes the marker, so the two agree by construction) to keep the read
 * bounded, and the marker is matched as a substring of each returned body.
 *
 * Degrades to `false` (i.e. proceed to file) on any spawn/parse error — the
 * deliberate degrade-toward-filing posture: an undecidable probe risks a
 * duplicate rather than swallowing the finding.
 *
 * @param {object} opts
 * @param {string} opts.marker — the content-hash marker embedded in the body.
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string[]} [opts.labels] — the follow-up's labels; scopes the list.
 * @param {string} [opts.ghPath]
 * @param {Function} [opts.spawnImpl]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<boolean>}
 */
async function confirmMarkerFiled({
  marker,
  owner,
  repo,
  labels,
  ghPath,
  spawnImpl,
  cwd,
  timeoutMs,
}) {
  const args = [
    'issue',
    'list',
    '--repo',
    `${owner}/${repo}`,
    '--state',
    'all',
    '--json',
    'number,body',
  ];
  for (const label of Array.isArray(labels) ? labels : []) {
    args.push('--label', label);
  }
  const res = await runChild({ cmd: ghPath, args, spawnImpl, cwd, timeoutMs });
  if (res.spawnError || (typeof res.code === 'number' && res.code !== 0)) {
    return false;
  }
  try {
    const parsed = JSON.parse(res.stdout || '[]');
    if (!Array.isArray(parsed)) return false;
    return parsed.some(
      (issue) => typeof issue?.body === 'string' && issue.body.includes(marker),
    );
  } catch {
    return false;
  }
}

/**
 * File a new follow-up issue via `gh issue create` and resolve to
 * `{ url, error }`. On success `url` is the trimmed stdout and `error` is
 * null; on failure `url` is null and `error` carries a human-readable
 * message.
 */
export async function createFollowUpIssue({
  owner,
  repo,
  title,
  body,
  labels,
  ghPath,
  spawnImpl,
  cwd,
  timeoutMs,
}) {
  const args = [
    'issue',
    'create',
    '--repo',
    `${owner}/${repo}`,
    '--title',
    title,
    '--body',
    body,
  ];
  for (const label of labels) {
    args.push('--label', label);
  }
  const res = await runChild({ cmd: ghPath, args, spawnImpl, cwd, timeoutMs });
  if (res.spawnError || (typeof res.code === 'number' && res.code !== 0)) {
    return {
      url: null,
      error: res.spawnError
        ? `gh issue create spawn failed: ${res.spawnError.message}`
        : `gh issue create exited ${res.code}: ${(res.stderr || '').trim()}`,
    };
  }
  const url = (res.stdout || '').trim();
  return { url, error: null };
}

/**
 * Validate the `graduate` preconditions (toggle, epicId, provider shape,
 * currentRepo shape). Returns `null` when all preconditions pass, or a
 * `{ skipped?, errors? }` partial-envelope the caller short-circuits on.
 * Story #4075 — extracted from `graduate` so the orchestrating body holds
 * no guard-chain branching.
 */
function checkGraduatePreconditions({
  epicId,
  provider,
  currentRepo,
  config,
  spec,
}) {
  if (!spec.isAutoFileEnabled(config)) {
    return { skipped: [{ reason: 'toggle-disabled' }] };
  }
  if (!Number.isInteger(epicId) || epicId < 1) {
    return { errors: [`${spec.fnName}: missing or invalid epicId`] };
  }
  if (!provider || typeof provider.getTicketComments !== 'function') {
    return { errors: [`${spec.fnName}: provider lacks getTicketComments`] };
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

/**
 * Read the source structured comment off the Epic and parse its findings.
 * Returns `{ findings }` on success, or `{ skipped?, errors? }` for the
 * no-comment / parse-empty / fetch-error short-circuits. Story #4075 —
 * extracted from `graduate`.
 */
async function loadGraduateFindings({ epicId, provider, spec }) {
  let comments;
  try {
    comments = await provider.getTicketComments(epicId);
  } catch (err) {
    return {
      errors: [
        `getTicketComments failed for epic #${epicId}: ${err?.message ?? err}`,
      ],
    };
  }
  const matched = (Array.isArray(comments) ? comments : []).filter(
    (c) => typeof c?.body === 'string' && c.body.includes(spec.commentMarker),
  );
  if (matched.length === 0) {
    return { skipped: [{ reason: spec.noCommentReason }] };
  }
  const findings = spec.parseFindings(matched[matched.length - 1].body);
  if (findings.length === 0) {
    return { skipped: [{ reason: 'no-non-blocking-findings' }] };
  }
  return { findings };
}

/**
 * Probe whether a finding was already filed, checking both the current
 * content-hash marker AND the legacy `(epicId, parse-index)` marker so
 * findings filed before the fingerprint cutover are not re-filed. The
 * content-hash marker is passed in precomputed so a caller can consult an
 * in-process memo before spending a spawn. Returns the `alreadyFiled`
 * decision.
 */
async function resolveAlreadyFiled({
  finding,
  epicId,
  routedRepo,
  contentMarker,
  ghPath,
  spawnImpl,
  cwd,
  timeoutMs,
  spec,
}) {
  const probe = (marker) =>
    probeMarkerExists({
      marker,
      owner: routedRepo.owner,
      repo: routedRepo.repo,
      ghPath,
      spawnImpl,
      cwd,
      timeoutMs,
    });

  if (await probe(contentMarker)) {
    return { alreadyFiled: true };
  }
  // Legacy recognition — a pre-cutover follow-up carries the ordinal
  // marker, not the content hash. Skip re-filing when it is present.
  if (typeof spec.buildLegacyMarker === 'function') {
    const legacyMarker = spec.buildLegacyMarker(epicId, finding.index);
    if (legacyMarker && (await probe(legacyMarker))) {
      return { alreadyFiled: true };
    }
  }
  return { alreadyFiled: false };
}

/**
 * Route a single finding (path-exists probe → repo routing → idempotency
 * probe → cap → file) and fold the outcome into the running envelope. Story
 * #4075 extracted this from `graduate`'s per-finding loop; Story #4415
 * hardened it (path-less seam, probe-error distinction, legacy-marker
 * recognition, filing cap, and cross-repo-deferred collection).
 */
async function processGraduateFinding({
  finding,
  envelope,
  decorate,
  epicId,
  currentRepo,
  frameworkRepo,
  classifier,
  gitRef,
  ghPath,
  spawnImpl,
  cwd,
  timeoutMs,
  maxFilingsPerRun,
  crossRepoDeferred,
  filedMarkers,
  logger,
  spec,
}) {
  const skip = (reason) =>
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

  // Path-less findings (the retro auto-filer seam) are not file-scoped, so
  // the path-exists gate does not apply — probing an empty path would
  // misclassify them `file-removed`. Only file-scoped findings are probed.
  const hasPath =
    typeof finding.path === 'string' && finding.path.trim().length > 0;
  if (hasPath) {
    const { exists, probeError } = await probePathStatus({
      ref: gitRef,
      path: finding.path,
      spawnImpl,
      cwd,
      timeoutMs,
    });
    // A probe failure is not proof the file is gone — record it distinctly
    // so a transient git/spawn fault does not masquerade as a removal.
    if (probeError) return skip('probe-error');
    if (!exists) return skip('file-removed');
  }

  const source = classifier(finding.path, null);
  const routedRepo =
    source === 'framework' && frameworkRepo ? frameworkRepo : currentRepo;
  const isCrossRepo =
    routedRepo.owner !== currentRepo.owner ||
    routedRepo.repo !== currentRepo.repo;
  if (isCrossRepo) {
    const logLine = spec.buildCrossRepoLog({ finding, routedRepo, source });
    logger?.info?.(logLine);
    crossRepoDeferred.push({ finding, routedRepo, source, logLine });
    return skip('cross-repo-deferred');
  }

  const contentMarker = spec.buildContentMarker(epicId, finding);

  // In-process memo (Story #4657): a marker already filed earlier in THIS
  // invocation — e.g. the framework bucket of a retro rollup that also has
  // the same category in the consumer bucket — short-circuits a repeat in a
  // later bucket without spending a single spawn, and closes the same-rollup
  // race the eventually-consistent search index cannot.
  if (filedMarkers?.has(contentMarker)) return skip('already-filed');

  const { alreadyFiled } = await resolveAlreadyFiled({
    finding,
    epicId,
    routedRepo,
    contentMarker,
    ghPath,
    spawnImpl,
    cwd,
    timeoutMs,
    spec,
  });
  if (alreadyFiled) return skip('already-filed');

  // Per-run filing cap — count only actual filings (already-filed and
  // skipped findings do not consume the budget). The excess is surfaced so
  // a re-run picks it up next time.
  if (envelope.filed.length >= maxFilingsPerRun) return skip('cap-reached');

  // Resolve the follow-up (title/body/labels) BEFORE the dedup decision so
  // the strong read can scope its `gh issue list` by the very labels this
  // filing would carry (they agree with the marker by construction).
  const { title, body, labels } = spec.buildFollowUp({
    finding,
    source,
    epicId,
    idMarker: contentMarker,
  });

  // Strong read (would-file path only, Story #4657): the search probe reads
  // an eventually-consistent index that can miss a byte-identical duplicate
  // filed seconds earlier. Confirm against a strongly-consistent,
  // label-scoped `gh issue list` before creating. Skipped entirely on the
  // already-filed path above, so it never fires when the search probe
  // already matched.
  const confirmed = await confirmMarkerFiled({
    marker: contentMarker,
    owner: routedRepo.owner,
    repo: routedRepo.repo,
    labels,
    ghPath,
    spawnImpl,
    cwd,
    timeoutMs,
  });
  if (confirmed) {
    filedMarkers?.add(contentMarker);
    return skip('already-filed');
  }

  const created = await createFollowUpIssue({
    owner: routedRepo.owner,
    repo: routedRepo.repo,
    title,
    body,
    labels,
    ghPath,
    spawnImpl,
    cwd,
    timeoutMs,
  });
  if (created.error) {
    envelope.errors.push(
      `finding ${finding.index} (${finding.path}): ${created.error}`,
    );
    return;
  }
  filedMarkers?.add(contentMarker);
  envelope.filed.push(
    decorate(
      {
        index: finding.index,
        severity: finding.severity,
        path: finding.path,
        source,
        repo: `${routedRepo.owner}/${routedRepo.repo}`,
        url: created.url,
      },
      finding,
    ),
  );
}

/**
 * Render the durable cross-repo-deferred comment body from the collected
 * deferrals. Each row names the finding path/severity plus the would-be
 * `gh issue create` command so an operator (or a later cross-repo pass)
 * can act on it.
 */
function renderCrossRepoDeferredBody(deferred, spec) {
  const header =
    spec.crossRepoCommentHeader ??
    '### Cross-repo-deferred findings\n\nThese findings route to a different repository and were **not** filed here. They are recorded for a cross-repo follow-up pass.';
  const rows = deferred.map(({ finding, routedRepo, logLine }) => {
    const path =
      typeof finding.path === 'string' && finding.path.length > 0
        ? `\`${finding.path}\``
        : '_(no path)_';
    return [
      `- ${path} (severity: ${finding.severity ?? 'n/a'}) → ${routedRepo.owner}/${routedRepo.repo}`,
      `  - ${logLine}`,
    ].join('\n');
  });
  return [header, '', ...rows].join('\n');
}

/**
 * Durably persist the cross-repo-deferred findings as a structured comment
 * on the Epic (upserted — one comment per graduator, refreshed in place).
 * Best-effort: a provider that cannot post comments is a no-op, and an
 * upsert failure lands in `envelope.errors` rather than throwing.
 */
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
 * Parametrized graduator walk. Parses non-blocking findings (from the
 * Epic's structured comment, or a pre-parsed `findings` array), then for
 * each finding runs the shared route → path probe → idempotency probe →
 * cap → file sequence. Never throws — every failure path is captured in
 * `errors[]`.
 *
 * The per-graduator variation lives entirely in the injected callbacks:
 *
 *   - `parseFindings(body)` — turns the rendered comment into findings.
 *     Each finding MUST carry `{ severity, path, summary, index }` and
 *     MAY carry additional fields (e.g. `lens`) that the builder uses.
 *   - `buildContentMarker(epicId, finding)` — the content-hash HTML-comment
 *     marker embedded in (and searched for in) follow-up bodies.
 *   - `buildLegacyMarker(epicId, index)` — the pre-cutover ordinal marker,
 *     probed for idempotency so legacy filings are not duplicated.
 *   - `buildFollowUp({ finding, source, epicId, idMarker })` — returns
 *     `{ title, body, labels }` for the issue to file.
 *   - `buildCrossRepoLog({ finding, routedRepo, source })` — returns the
 *     human-readable would-be-command string for a cross-repo skip.
 *   - `decorateRecord(record, finding)` — copies finding-specific fields
 *     (e.g. `lens`) onto a `skipped`/`filed` record before it is pushed.
 *   - `crossRepoCommentAttrs` — discriminator attrs for the durable
 *     cross-repo-deferred comment (so the two graduators do not clobber
 *     each other's comment).
 *
 * @param {object} opts
 * @param {number} opts.epicId
 * @param {object} opts.provider — exposes `getTicketComments(ticketId)`
 * @param {object} [opts.config]
 * @param {{owner: string, repo: string}} opts.currentRepo
 * @param {{owner: string, repo: string}} [opts.frameworkRepo]
 * @param {string} [opts.gitRef='HEAD']
 * @param {Function} [opts.classifier=classifyPathSource]
 * @param {string} [opts.ghPath='gh']
 * @param {Function} [opts.spawnImpl]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs] — per-spawn watchdog bound
 * @param {number} [opts.maxFilingsPerRun] — per-run filing cap
 * @param {Array<object>} [opts.findings] — pre-parsed findings; when
 *   provided, the structured-comment read/parse is bypassed (the retro
 *   auto-filer seam).
 * @param {Set<string>} [opts.filedMarkers] — in-process memo of content
 *   markers filed so far. Pass a shared Set across multiple `graduate()`
 *   calls in one logical invocation (e.g. the retro graduator's two source
 *   buckets) so a marker filed in one call short-circuits a repeat in the
 *   next without a spawn. Defaults to a fresh per-call Set.
 * @param {{info?: Function, warn?: Function, debug?: Function}} [opts.logger]
 * @param {object} opts.spec — the per-graduator behaviour bundle
 * @returns {Promise<{ filed: object[], skipped: object[], errors: string[] }>}
 */
export async function graduate({
  epicId,
  provider,
  config,
  currentRepo,
  frameworkRepo,
  gitRef = 'HEAD',
  classifier = defaultClassifier,
  ghPath = 'gh',
  spawnImpl,
  cwd,
  timeoutMs = DEFAULT_RUN_CHILD_TIMEOUT_MS,
  maxFilingsPerRun = DEFAULT_MAX_FILINGS_PER_RUN,
  findings: preParsedFindings,
  filedMarkers = new Set(),
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
    provider,
    currentRepo,
    config,
    spec,
  });
  if (precondition) return { ...envelope, ...precondition };

  let findings;
  if (Array.isArray(preParsedFindings)) {
    // Pre-parsed seam (retro auto-filer): bypass the structured-comment
    // read + parse entirely and file the supplied findings directly.
    findings = preParsedFindings;
  } else {
    const loaded = await loadGraduateFindings({ epicId, provider, spec });
    if (!loaded.findings) return { ...envelope, ...loaded };
    findings = loaded.findings;
  }

  const crossRepoDeferred = [];
  for (const finding of findings) {
    await processGraduateFinding({
      finding,
      envelope,
      decorate,
      epicId,
      currentRepo,
      frameworkRepo,
      classifier,
      gitRef,
      ghPath,
      spawnImpl,
      cwd,
      timeoutMs,
      maxFilingsPerRun,
      crossRepoDeferred,
      filedMarkers,
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
