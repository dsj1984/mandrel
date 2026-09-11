/**
 * graduator-core.js — shared mechanism for the feedback-loop graduators.
 *
 * Story #3845 / Epic #3823. The since-retired audit-results and code-review
 * graduators duplicated ~90% of their mechanism: a
 * `spawn`-based child runner, the `git cat-file` path probe, the
 * `gh search issues` idempotency probe, the `gh issue create` filer, the
 * `isAutoFileEnabled` toggle reader, and the route → probe → file
 * envelope walk. This module folds all of that into one place so a
 * graduator becomes a thin shell that injects the bits that genuinely
 * differ (the body/title/label builders).
 *
 * Story #5003 removed the structured-comment read limb. Both comment-reading
 * graduators were Epic-era — they walked an Epic's `verification-results`
 * comment, and v2 has no Epics — leaving `retro-proposals-graduator.js` and
 * its pre-parsed `findings[]` as the one live caller.
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
 *   - **Pre-parsed / path-less seam.** `graduate()` takes its findings as a
 *     pre-parsed array, and a path-less finding skips the path-exists gate
 *     instead of being misclassified `file-removed` — the seam the retro
 *     auto-filer consumes.
 *   - **Durable cross-repo deferral.** Cross-repo-deferred findings are
 *     upserted into a structured comment on the Epic instead of only a
 *     log line.
 *   - **Routed, never re-pointed.** Ownership routing is delegated to
 *     `github/framework-repo.js#routeOwnership`; an unroutable bucket is
 *     skipped `unroutable` and named in that same durable comment. The
 *     predecessor resolved an absent framework slug to the consumer's own
 *     repo, which silently mis-filed framework-owned work.
 */

import { spawn as defaultSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { inNodeTestContext } from '../config/temp-paths.js';
import { routeOwnership } from '../github/framework-repo.js';
import { LABEL_COLORS } from '../label-constants.js';
import { classifyPathSource as defaultClassifier } from '../observability/source-classifier.js';
import { upsertStructuredComment } from '../orchestration/ticketing.js';

/**
 * Default child-process timeout. A hung `gh`/`git` spawn previously blocked
 * finalize indefinitely; the walk now caps every spawn at this bound unless
 * a caller overrides it.
 */
const DEFAULT_RUN_CHILD_TIMEOUT_MS = 30000;

/**
 * Default per-run filing cap. `graduate()` files at most this many follow-up
 * issues per invocation; the remainder is recorded as skipped `cap-reached`.
 */
export const DEFAULT_MAX_FILINGS_PER_RUN = 20;

/**
 * Structured-comment type used to durably persist cross-repo-deferred
 * findings on the Epic. Registered in `STRUCTURED_COMMENT_TYPES`.
 */
const CROSS_REPO_DEFERRED_COMMENT_TYPE = 'cross-repo-deferred';

/**
 * Explicit, greppable opt-back-in to live issue filing from a context the
 * guard below refuses (Story #4837). Deliberately shaped like
 * `MANDREL_TEST_ALLOW_REAL_TEMP` (`config/temp-paths.js`) rather than a new
 * bespoke flag: same env-var idiom, same "an escape hatch must be visible in
 * a grep" posture.
 */
const ALLOW_LIVE_FILING_ENV = 'MANDREL_ALLOW_LIVE_ISSUE_FILING';

/**
 * Skip reason recorded for every finding a refused filing context drops.
 * Module-local: it reaches callers as data on the returned envelope, so
 * exporting the constant would only add a symbol nothing imports.
 */
const LIVE_FILING_BLOCKED_REASON = 'live-api-guard';

/** `NODE_ENV` values that declare this process is not a production run. */
const NON_PRODUCTION_NODE_ENVS = new Set(['test', 'development']);

/**
 * Decide whether this process may let the graduator walk reach the live
 * GitHub API (Story #4837).
 *
 * **Why this exists.** Issues #4833 and #4834 were created against the live
 * `dsj1984/mandrel` tracker — from fixture findings anchored to `epic-101`
 * and `epic-777` — by a development run of the filing path. Nothing in the
 * walk distinguished "a real close is filing a real follow-up" from "someone
 * is exercising this module", so the only thing standing between a test and
 * the production tracker was the author remembering to stub `spawnImpl`.
 *
 * **The seam.** There are exactly two ways to be safe, and this returns
 * `allowed` only for them:
 *
 *   1. `spawnImpl` was injected — the walk then spawns the caller's stub and
 *      no child process reaches `gh` at all. This is the seam
 *      `.agents/rules/test-seams.md` already mandates, so a well-behaved test
 *      is unaffected.
 *   2. The process provably is **not** a test or development context — not a
 *      node:test run (per the single shared detector in
 *      `config/temp-paths.js#inNodeTestContext`) and not a run that declared
 *      itself non-production via `NODE_ENV`.
 *
 * **Fail closed.** Anything else refuses: a test context with the real
 * `spawn` (the #4833/#4834 shape), and — critically — a context that cannot
 * be *decided*, because an unreadable env is not evidence of production. The
 * refusal is a skip, not a throw: observability must never fail a close.
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

  // An injected seam cannot reach the live API by construction.
  if (typeof spawnImpl === 'function') return allow;

  // Undecidable context → refuse. Both inputs must be readable for the
  // detector's answer to mean anything.
  if (env === null || typeof env !== 'object' || !Array.isArray(execArgv)) {
    return refuse;
  }
  try {
    if (env[ALLOW_LIVE_FILING_ENV] === '1') return allow;
    if (inNodeTestContext(env, execArgv)) return refuse;
    // A declared non-production environment is the other half of "a test or
    // development context". `lib/test-env.js` stamps `NODE_ENV=test` on the
    // whole suite environment, and `development` is the universal marker for
    // a hand-run session; nothing on the close path sets either.
    return NON_PRODUCTION_NODE_ENVS.has(String(env.NODE_ENV ?? ''))
      ? refuse
      : allow;
  } catch {
    // An env we cannot even read is not evidence of production.
    return refuse;
  }
}

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
 * text — `retro-proposal-followup: <fp>` — which the index matches.
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
 * Normalize one `gh` issue row (from `search issues` or `issue list`) into
 * the identity the update path needs. `state` is lowercased and defaults to
 * the empty string — deliberately NOT to `'open'`: an unknown state must
 * never authorize editing somebody's issue (see
 * {@link resolveFollowUpRecurrence}).
 *
 * @param {object} row
 * @returns {{ number: number|null, state: string, url: string }}
 */
function toFollowUpRef(row) {
  const number = Number(row?.number);
  return {
    number: Number.isInteger(number) && number > 0 ? number : null,
    state: String(row?.state ?? '').toLowerCase(),
    url: typeof row?.url === 'string' ? row.url : '',
  };
}

/**
 * Search the routed repo for a follow-up carrying `marker`, resolving the
 * matched issue's identity rather than a bare yes/no. Uses `gh search issues`
 * so we hit the body field directly, querying the delimiter-stripped marker
 * text (see {@link normalizeMarkerQuery}) — the raw `<!-- … -->` form never
 * matches the index.
 *
 * Returns `null` when nothing matched OR when the probe could not decide
 * (spawn/parse error): the deliberate degrade-toward-filing posture, better
 * to risk a duplicate than swallow the finding entirely.
 *
 * @returns {Promise<{ number: number|null, state: string, url: string }|null>}
 */
async function searchFollowUpByMarker({
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
    'number,state,url',
    '--limit',
    '1',
  ];
  const res = await runChild({ cmd: ghPath, args, spawnImpl, cwd, timeoutMs });
  if (res.spawnError || (typeof res.code === 'number' && res.code !== 0)) {
    return null;
  }
  try {
    const parsed = JSON.parse(res.stdout || '[]');
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return toFollowUpRef(parsed[0]);
  } catch {
    return null;
  }
}

/**
 * Probe whether a follow-up issue carrying the given idempotency marker
 * already exists in the routed repo. Thin boolean façade over
 * {@link searchFollowUpByMarker} — kept as the module's exported probe seam
 * so callers that only need the yes/no do not have to know about the issue
 * identity the recurrence path resolves.
 *
 * @returns {Promise<boolean>}
 */
export async function probeMarkerExists(opts) {
  return (await searchFollowUpByMarker(opts)) !== null;
}

/**
 * Strongly-consistent lookup of an already-filed follow-up, run ONLY on the
 * would-file path as the last gate before creating. `gh search issues` reads
 * an eventually-consistent index whose catch-up latency (measured under 20s
 * against this repo, Story #4657) is exactly wide enough to miss a
 * byte-identical duplicate filed seconds earlier in the same rollup. A
 * label-scoped `gh issue list … --state all` is strongly consistent, so it
 * closes that window. The list is narrowed by the follow-up's own labels
 * (supplied by the same `spec.buildFollowUp` that writes the marker, so the
 * two agree by construction) to keep the read bounded.
 *
 * `markers` is a LIST of body substrings, any one of which identifies a prior
 * filing (Story #4837). One finding can have been filed under more than one
 * marker shape — the retro graduator's pre-cutover marker embedded the run
 * anchor, so the same finding sits behind `epic-<anchor>-<fp>` on already-
 * filed issues and behind the anchor-free `<fp>` on new ones. Matching any of
 * them is what stops a marker-format change from re-filing the whole backlog.
 *
 * Returns `null` when nothing matched, or on any spawn/parse error — the
 * deliberate degrade-toward-filing posture: an undecidable probe risks a
 * duplicate rather than swallowing the finding.
 *
 * @param {object} opts
 * @param {string[]} opts.markers — body substrings identifying a prior filing.
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string[]} [opts.labels] — the follow-up's labels; scopes the list.
 * @param {string} [opts.ghPath]
 * @param {Function} [opts.spawnImpl]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ number: number|null, state: string, url: string }|null>}
 */
async function findExistingFollowUp({
  markers,
  owner,
  repo,
  labels,
  ghPath,
  spawnImpl,
  cwd,
  timeoutMs,
}) {
  const tokens = (Array.isArray(markers) ? markers : []).filter(
    (m) => typeof m === 'string' && m.length > 0,
  );
  if (tokens.length === 0) return null;
  const args = [
    'issue',
    'list',
    '--repo',
    `${owner}/${repo}`,
    '--state',
    'all',
    '--json',
    'number,body,state,url',
  ];
  for (const label of Array.isArray(labels) ? labels : []) {
    args.push('--label', label);
  }
  const res = await runChild({ cmd: ghPath, args, spawnImpl, cwd, timeoutMs });
  if (res.spawnError || (typeof res.code === 'number' && res.code !== 0)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const matches = parsed.filter(
    (issue) =>
      typeof issue?.body === 'string' &&
      tokens.some((token) => issue.body.includes(token)),
  );
  if (matches.length === 0) return null;
  // Prefer an OPEN match: a recurrence updates the live issue, while a closed
  // one is a decided follow-up. When several match, the open one is the one a
  // human is still looking at.
  const open = matches.find(
    (issue) => String(issue?.state ?? '').toLowerCase() === 'open',
  );
  return toFollowUpRef(open ?? matches[0]);
}

/**
 * Refresh an existing follow-up's body in place — the recurrence path
 * (Story #4837). A finding that recurs is the SAME finding: the loop's job is
 * to keep one issue current, not to mint issue #N+1 whose only new
 * information is that the count went up.
 *
 * Body-only: labels, title, assignees and state are left exactly as a human
 * may have curated them.
 *
 * @returns {Promise<{ url: string|null, error: string|null }>}
 */
export async function updateFollowUpIssue({
  owner,
  repo,
  number,
  body,
  ghPath,
  spawnImpl,
  cwd,
  timeoutMs,
}) {
  const res = await runChild({
    cmd: ghPath,
    args: [
      'issue',
      'edit',
      String(number),
      '--repo',
      `${owner}/${repo}`,
      '--body',
      body,
    ],
    spawnImpl,
    cwd,
    timeoutMs,
  });
  if (res.spawnError || (typeof res.code === 'number' && res.code !== 0)) {
    return {
      url: null,
      error: res.spawnError
        ? `gh issue edit spawn failed: ${res.spawnError.message}`
        : `gh issue edit exited ${res.code}: ${(res.stderr || '').trim()}`,
    };
  }
  return { url: (res.stdout || '').trim(), error: null };
}

/** Prefix of the per-category friction axis the feedback loop mints. */
const FRICTION_LABEL_PREFIX = 'friction::';

/**
 * Resolve the color + description for a label the feedback loop is about to
 * mint. Only two axes reach this path — `meta::*` (routing) and
 * `friction::<category>` (the telemetry bucket) — so the mapping is a
 * two-branch lookup rather than a registry.
 *
 * @param {string} name
 * @returns {{ color: string, description: string }}
 */
function describeMintedLabel(name) {
  if (name.startsWith(FRICTION_LABEL_PREFIX)) {
    return {
      color: LABEL_COLORS.FRICTION,
      description: `Recurring friction category "${name.slice(FRICTION_LABEL_PREFIX.length)}" (minted by the feedback loop)`,
    };
  }
  return {
    color: LABEL_COLORS.META,
    description: 'Feedback-loop routing axis (minted by the feedback loop)',
  };
}

/**
 * Read the routed repo's live label names once per repo, memoized in
 * `labelCache`. Returns `null` when the set could not be established —
 * "verification unavailable", which is deliberately NOT the same as "the repo
 * has no labels": an unreadable set must not be read as proof that every
 * label is missing.
 *
 * @returns {Promise<{ known: Set<string>|null, error: string|null }>}
 */
async function readLiveLabelNames({
  owner,
  repo,
  labelCache,
  ghPath,
  spawnImpl,
  cwd,
  timeoutMs,
}) {
  const key = `${owner}/${repo}`;
  const cached = labelCache?.get(key);
  if (cached) return { known: cached, error: null };
  const res = await runChild({
    cmd: ghPath,
    args: ['label', 'list', '--repo', key, '--limit', '500', '--json', 'name'],
    spawnImpl,
    cwd,
    timeoutMs,
  });
  if (res.spawnError || (typeof res.code === 'number' && res.code !== 0)) {
    return {
      known: null,
      error: `gh label list ${key} failed: ${res.spawnError?.message ?? (res.stderr || '').trim()}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout || '[]');
  } catch {
    return {
      known: null,
      error: `gh label list ${key} returned unparseable JSON`,
    };
  }
  if (!Array.isArray(parsed)) {
    return { known: null, error: `gh label list ${key} returned a non-array` };
  }
  const known = new Set();
  for (const row of parsed) {
    if (row && typeof row.name === 'string') known.add(row.name);
  }
  labelCache?.set(key, known);
  return { known, error: null };
}

/**
 * Mint any of `labels` the routed repo does not already carry, so
 * `gh issue create --label …` can attach them (Story #4828).
 *
 * **Why this exists.** `gh issue create` resolves every `--label` name against
 * the repo before it creates anything, and fails the whole call when one is
 * absent. The feedback loop mints two axes that no bootstrap can enumerate
 * ahead of time — `meta::consumer-improvement` is absent from `LABEL_TAXONOMY`
 * outright, and `friction::<category>` names come from live telemetry — so on
 * a repo that never had them, *every* filing failed. The failure landed in the
 * graduator's `errors[]`, which the run epilogue did not surface, so a
 * hard-failing feedback loop rendered as `filed: 0`: indistinguishable from
 * "nothing was actionable".
 *
 * Degrades rather than blocks: when the live set cannot be read, this returns
 * no `missing` entries so the caller still attempts the filing (the old
 * behaviour) instead of refusing on an unproven premise.
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string[]} opts.labels
 * @param {Map<string, Set<string>>} [opts.labelCache] — per-repo live-set memo.
 * @param {string} [opts.ghPath]
 * @param {Function} [opts.spawnImpl]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ created: string[], missing: string[], errors: string[] }>}
 */
export async function ensureIssueLabels({
  owner,
  repo,
  labels,
  labelCache,
  ghPath = 'gh',
  spawnImpl,
  cwd,
  timeoutMs,
}) {
  const wanted = (Array.isArray(labels) ? labels : []).filter(
    (name) => typeof name === 'string' && name.trim().length > 0,
  );
  if (wanted.length === 0) return { created: [], missing: [], errors: [] };

  const { known, error } = await readLiveLabelNames({
    owner,
    repo,
    labelCache,
    ghPath,
    spawnImpl,
    cwd,
    timeoutMs,
  });
  // Verification unavailable — attempt the filing anyway rather than refuse.
  if (!known) return { created: [], missing: [], errors: error ? [error] : [] };

  const created = [];
  const missing = [];
  const errors = [];
  for (const name of wanted) {
    if (known.has(name)) continue;
    const { color, description } = describeMintedLabel(name);
    const res = await runChild({
      cmd: ghPath,
      args: [
        'label',
        'create',
        name,
        '--repo',
        `${owner}/${repo}`,
        '--color',
        color.replace(/^#/, ''),
        '--description',
        description,
      ],
      spawnImpl,
      cwd,
      timeoutMs,
    });
    const failed =
      Boolean(res.spawnError) ||
      (typeof res.code === 'number' && res.code !== 0);
    // A concurrent roll-up may have minted it between the list and the create;
    // that is the idempotent outcome, not a failure.
    const raced = /label\b[\s\S]*?already exists/i.test(
      `${res.stderr ?? ''}${res.spawnError?.message ?? ''}`,
    );
    if (!failed || raced) {
      known.add(name);
      if (!raced) created.push(name);
      continue;
    }
    missing.push(name);
    errors.push(
      `gh label create "${name}" in ${owner}/${repo} failed: ${res.spawnError?.message ?? (res.stderr || '').trim()}`,
    );
  }
  return { created, missing, errors };
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
 * Validate the `graduate` preconditions (toggle, epicId, currentRepo shape).
 * Returns `null` when all preconditions pass, or a `{ skipped?, errors? }`
 * partial-envelope the caller short-circuits on. Story #4075 — extracted from
 * `graduate` so the orchestrating body holds no guard-chain branching.
 *
 * Story #5003 dropped the `provider.getTicketComments` gate with the
 * structured-comment read limb. The provider is now consulted only by the
 * best-effort cross-repo-deferred upsert, which reports its own faults into
 * `errors[]` — gating the whole walk on a shape only that path needs would
 * refuse work the walk can complete.
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

/**
 * Probe whether a finding was already filed, checking both the current
 * content-hash marker AND the legacy `(epicId, parse-index)` marker so
 * findings filed before the fingerprint cutover are not re-filed. The
 * content-hash marker is passed in precomputed so a caller can consult an
 * in-process memo before spending a spawn.
 *
 * Resolves `{ alreadyFiled, existing }` — `existing` carries the matched
 * issue's `{ number, state, url }` when the search index surfaced it, so a
 * recurrence can update that issue rather than only knowing that one exists.
 * `existing` is `null` on the not-found path.
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
    searchFollowUpByMarker({
      marker,
      owner: routedRepo.owner,
      repo: routedRepo.repo,
      ghPath,
      spawnImpl,
      cwd,
      timeoutMs,
    });

  const hit = await probe(contentMarker);
  if (hit) return { alreadyFiled: true, existing: hit };
  // Legacy recognition — a pre-cutover follow-up carries the ordinal
  // marker, not the content hash. Skip re-filing when it is present.
  if (typeof spec.buildLegacyMarker === 'function') {
    const legacyMarker = spec.buildLegacyMarker(epicId, finding.index);
    if (legacyMarker) {
      const legacyHit = await probe(legacyMarker);
      if (legacyHit) return { alreadyFiled: true, existing: legacyHit };
    }
  }
  return { alreadyFiled: false, existing: null };
}

/**
 * Resolve what a recurrence of an already-identified follow-up should do
 * (Story #4837), and fold the outcome into the running envelope.
 *
 * An **open** issue with a resolvable number is refreshed in place and
 * recorded on `envelope.filed` with `action: 'updated'` — same array as a
 * creation, because both are live writes this run performed and the roll-up
 * that reports "filed" must count them alike.
 *
 * Anything else records `already-filed` and touches nothing: a closed
 * follow-up is a decided one (reopening it would relitigate a human's call),
 * and an unresolvable number or state is not licence to edit an issue we
 * cannot identify.
 *
 * @returns {Promise<boolean>} `true` when the recurrence was handled here.
 */
async function resolveFollowUpRecurrence({
  existing,
  body,
  finding,
  source,
  routedRepo,
  envelope,
  decorate,
  skip,
  ghPath,
  spawnImpl,
  cwd,
  timeoutMs,
}) {
  if (existing.state !== 'open' || existing.number === null) {
    skip('already-filed');
    return true;
  }
  const updated = await updateFollowUpIssue({
    owner: routedRepo.owner,
    repo: routedRepo.repo,
    number: existing.number,
    body,
    ghPath,
    spawnImpl,
    cwd,
    timeoutMs,
  });
  if (updated.error) {
    envelope.errors.push(
      `finding ${finding.index} (${finding.path}): ${updated.error}`,
    );
    return true;
  }
  envelope.filed.push(
    decorate(
      {
        index: finding.index,
        action: 'updated',
        issueNumber: existing.number,
        severity: finding.severity,
        path: finding.path,
        source,
        repo: `${routedRepo.owner}/${routedRepo.repo}`,
        url: updated.url || existing.url || null,
      },
      finding,
    ),
  );
  return true;
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
  repos,
  classifier,
  gitRef,
  ghPath,
  spawnImpl,
  cwd,
  timeoutMs,
  maxFilingsPerRun,
  crossRepoDeferred,
  filedMarkers,
  labelCache,
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
  // Ownership routing is the shared SSOT's call, and an unroutable bucket is
  // an outcome rather than a fallback: the predecessor resolved an absent
  // framework slug to the CONSUMER's repo, silently filing framework-owned
  // work in the wrong place (see `github/framework-repo.js`). Unroutable
  // findings are deferred and named, never re-pointed.
  const routing = routeOwnership({ bucket: source, repos, currentRepo });
  if (!routing.routable) {
    const logLine = `[${spec.fnName}] unroutable ${source} finding (${routing.missingKey} is unset) — not filed: ${finding.title ?? finding.path ?? `finding ${finding.index}`}`;
    logger?.warn?.(logLine);
    crossRepoDeferred.push({
      finding,
      routedRepo: null,
      source,
      logLine,
      missingKey: routing.missingKey,
    });
    return skip('unroutable');
  }
  const routedRepo = routing.routedRepo;
  if (routing.crossRepo) {
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

  const { alreadyFiled, existing } = await resolveAlreadyFiled({
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

  // Resolve the follow-up (title/body/labels) BEFORE the dedup decision so
  // the strong read can scope its `gh issue list` by the very labels this
  // filing would carry (they agree with the marker by construction), and so
  // the recurrence path has the refreshed body to write.
  const { title, body, labels } = spec.buildFollowUp({
    finding,
    source,
    epicId,
    idMarker: contentMarker,
  });

  if (alreadyFiled) {
    filedMarkers?.add(contentMarker);
    await resolveFollowUpRecurrence({
      existing,
      body,
      finding,
      source,
      routedRepo,
      envelope,
      decorate,
      skip,
      ghPath,
      spawnImpl,
      cwd,
      timeoutMs,
    });
    return;
  }

  // Per-run filing cap — bounds the live writes this run performs. Checked
  // only on the would-file path: an `already-filed` finding resolved above
  // never reaches here. The excess is surfaced so a re-run picks it up.
  if (envelope.filed.length >= maxFilingsPerRun) return skip('cap-reached');

  // Mint any routing label the repo does not carry yet (Story #4828). This
  // runs BEFORE the strong read as well as before the create: `gh issue list
  // --label <absent>` exits 0 with `[]`, so an absent label silently degrades
  // the dedup confirm too, not just the filing.
  const ensured = await ensureIssueLabels({
    owner: routedRepo.owner,
    repo: routedRepo.repo,
    labels,
    labelCache,
    ghPath,
    spawnImpl,
    cwd,
    timeoutMs,
  });
  envelope.errors.push(...ensured.errors);
  if (ensured.missing.length > 0) {
    // `gh issue create` would reject the whole call on the absent name; say
    // which label blocked it rather than replaying an opaque CLI failure.
    return skip('label-ensure-failed');
  }

  // Strong read (would-file path only, Story #4657): the search probe reads
  // an eventually-consistent index that can miss a byte-identical duplicate
  // filed seconds earlier. Confirm against a strongly-consistent,
  // label-scoped `gh issue list` before creating. Skipped entirely on the
  // already-filed path above, so it never fires when the search probe
  // already matched.
  const confirmed = await findExistingFollowUp({
    markers:
      typeof spec.buildMatchTokens === 'function'
        ? spec.buildMatchTokens({ epicId, finding, contentMarker })
        : [contentMarker],
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
    await resolveFollowUpRecurrence({
      existing: confirmed,
      body,
      finding,
      source,
      routedRepo,
      envelope,
      decorate,
      skip,
      ghPath,
      spawnImpl,
      cwd,
      timeoutMs,
    });
    return;
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
        action: 'created',
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
  const rows = deferred.map(({ finding, routedRepo, logLine, missingKey }) => {
    const path =
      typeof finding.path === 'string' && finding.path.length > 0
        ? `\`${finding.path}\``
        : '_(no path)_';
    // An unroutable finding has no destination to name — say which config
    // key would give it one instead of inventing a repo for the row.
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
 * Parametrized graduator walk. Takes a pre-parsed `findings` array and, for
 * each finding, runs the shared route → path probe → idempotency probe →
 * cap → file sequence. Never throws — every failure path is captured in
 * `errors[]`.
 *
 * Each finding MUST carry `{ severity, path, summary, index }` and MAY carry
 * additional fields (e.g. `category`) that the builders use.
 *
 * The per-graduator variation lives entirely in the injected callbacks:
 *
 *   - `buildContentMarker(epicId, finding)` — the content-hash HTML-comment
 *     marker embedded in (and searched for in) follow-up bodies.
 *   - `buildLegacyMarker(epicId, index)` — the pre-cutover ordinal marker,
 *     probed for idempotency so legacy filings are not duplicated.
 *   - `buildMatchTokens({ epicId, finding, contentMarker })` — optional; the
 *     body substrings the strong read accepts as proof of a prior filing.
 *     Defaults to `[contentMarker]`. A graduator whose marker format changed
 *     returns the old shape here too, so the cutover recognizes the backlog
 *     it already filed instead of duplicating it.
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
 * @param {object} opts.provider — exposes `postComment(ticketId, body)` for
 *   the durable cross-repo-deferred persistence
 * @param {object} [opts.config]
 * @param {{owner: string, repo: string}} opts.currentRepo
 * @param {{owner: string, repo: string}} [opts.frameworkRepo] — the
 *   `framework` ownership bucket. Absent means **unroutable**, never the
 *   consumer's repo: a framework-classified finding is then deferred and
 *   named rather than filed in the wrong tracker.
 * @param {{owner: string, repo: string}} [opts.platformRepo] — the shared
 *   platform/infra bucket, for a caller whose classifier can reach it.
 * @param {string} [opts.gitRef='HEAD']
 * @param {Function} [opts.classifier=classifyPathSource]
 * @param {string} [opts.ghPath='gh']
 * @param {Function} [opts.spawnImpl]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs] — per-spawn watchdog bound
 * @param {number} [opts.maxFilingsPerRun] — per-run filing cap
 * @param {Array<object>} opts.findings — the pre-parsed findings to file.
 *   Required: a non-array is an `errors[]` short-circuit, never a silent
 *   no-op.
 * @param {Set<string>} [opts.filedMarkers] — in-process memo of content
 *   markers filed so far. Pass a shared Set across multiple `graduate()`
 *   calls in one logical invocation (e.g. the retro graduator's two source
 *   buckets) so a marker filed in one call short-circuits a repeat in the
 *   next without a spawn. Defaults to a fresh per-call Set.
 * @param {Map<string, Set<string>>} [opts.labelCache] — per-repo memo of the
 *   live label set, so the just-in-time label mint (Story #4828) costs one
 *   `gh label list` per routed repo rather than one per finding. Share it
 *   across the calls of one logical invocation, like `filedMarkers`.
 * @param {NodeJS.ProcessEnv} [opts.env] — injectable for the blast-radius
 *   guard's context decision; defaults to `process.env`.
 * @param {string[]} [opts.execArgv] — ditto; defaults to `process.execArgv`.
 * @param {{info?: Function, warn?: Function, debug?: Function}} [opts.logger]
 * @param {object} opts.spec — the per-graduator behaviour bundle
 * @returns {Promise<{ filed: object[], skipped: object[], errors: string[] }>}
 *   Each `filed` record carries `action: 'created'|'updated'` — both are live
 *   writes this run performed, so a roll-up counting "filed" counts both.
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

  // Pre-parsed findings are the only source (Story #5003). The
  // structured-comment read/parse limb went with the audit-results
  // graduator: it walked an Epic's `verification-results` comment, and v2
  // has no Epics, so it could only ever resolve zero findings.
  if (!Array.isArray(preParsedFindings)) {
    return {
      ...envelope,
      errors: [`${spec.fnName}: findings[] is required and must be an array`],
    };
  }
  const findings = preParsedFindings;

  // Blast-radius guard (Story #4837): decided ONCE per walk, before the
  // first spawn, so a refused context costs no child process at all.
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

  // The ownership map the routing SSOT resolves against. `platform` is
  // absent for both graduators today (their classifier is binary) and is
  // threaded so a caller that does know a shared-infra repo routes there
  // rather than into the nearest plausible tracker.
  const repos = {
    consumer: currentRepo,
    framework: frameworkRepo ?? null,
    platform: platformRepo ?? null,
  };
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
      ghPath,
      spawnImpl,
      cwd,
      timeoutMs,
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
