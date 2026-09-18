/**
 * Shared graduator walk: route → path probe → idempotency probe → cap → file.
 * A graduator injects only its title/body/label/marker builders (`spec`).
 * The walk is bounded (spawn timeouts, per-run filing cap) and replay-safe
 * (content-hash markers survive sibling reordering).
 */

import { spawn as defaultSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { inNodeTestContext } from '../config/temp-paths.js';
import { routeOwnership } from '../github/framework-repo.js';
import { LABEL_COLORS } from '../label-constants.js';
import { classifyPathSource as defaultClassifier } from '../observability/source-classifier.js';
import { upsertStructuredComment } from '../orchestration/ticketing.js';

const DEFAULT_RUN_CHILD_TIMEOUT_MS = 30000;

export const DEFAULT_MAX_FILINGS_PER_RUN = 20;

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
 * The feedback loop's single spawn helper. Never throws: spawn errors land in
 * `spawnError`; an overrun is SIGKILL'd and resolves `timedOut: true`.
 * `timeoutMs` of `0`/`Infinity` disables the watchdog.
 *
 * @param {object} opts
 * @param {string} opts.cmd
 * @param {string[]} opts.args
 * @param {Function} [opts.spawnImpl]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs]
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
          // already dead / stub child
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
      // Deliberately NOT unref'd: a child whose handles close early (or a
      // stub) leaves the loop idle, and an unref'd watchdog would never fire.
      // `finish()` always clears it.
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
 * `git cat-file -e <ref>:<path>`; a spawn failure/timeout is `probeError`,
 * distinct from a confirmed-missing file.
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
 * GitHub search indexes the text inside an HTML-comment marker, but a query
 * carrying the `<!--`/`-->` delimiters never matches it; strip them.
 *
 * @param {string} marker
 * @returns {string}
 */
function normalizeMarkerQuery(marker) {
  if (typeof marker !== 'string') return '';
  return marker.replaceAll('<!--', '').replaceAll('-->', '').trim();
}

/**
 * `state` defaults to `''`, never `'open'`: an unknown state must not
 * authorize editing an issue.
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
 * `null` on no match OR an undecidable probe — degrade toward filing: a
 * duplicate beats a swallowed finding.
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

/** @returns {Promise<boolean>} */
export async function probeMarkerExists(opts) {
  return (await searchFollowUpByMarker(opts)) !== null;
}

/**
 * Strongly-consistent last gate before creating: the search index can lag
 * long enough to miss a duplicate filed seconds earlier, while a
 * label-scoped `gh issue list --state all` cannot. Any of `markers` matching
 * counts, so a marker-format change does not re-file the backlog. `null` on
 * no match or error (degrade toward filing).
 *
 * @param {object} opts
 * @param {string[]} opts.markers
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string[]} [opts.labels]
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
  // Prefer an open match: a closed one is a decided follow-up.
  const open = matches.find(
    (issue) => String(issue?.state ?? '').toLowerCase() === 'open',
  );
  return toFollowUpRef(open ?? matches[0]);
}

/**
 * Recurrence path: refresh the body only, leaving human-curated labels,
 * title, assignees and state untouched.
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

const FRICTION_LABEL_PREFIX = 'friction::';

/**
 * Only `meta::*` and `friction::<category>` labels reach this path.
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
 * Memoized per repo. `known: null` means unverifiable, not "no labels".
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
 * Mint absent labels: `gh issue create` fails the whole call on any unknown
 * `--label`, and `friction::<category>` names come from live telemetry so no
 * bootstrap can pre-create them. An unreadable live set reports nothing
 * `missing`, so the caller still attempts the filing.
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string[]} opts.labels
 * @param {Map<string, Set<string>>} [opts.labelCache]
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
    // A concurrent mint between list and create is success.
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

/** Resolves `{ url, error }`; exactly one is non-null. */
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

/**
 * Checks the content-hash marker, then the legacy ordinal marker so
 * pre-fingerprint filings are not re-filed. `existing` identifies the match
 * so a recurrence can update it.
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
 * An open, numbered match is refreshed and recorded on `filed` as
 * `action: 'updated'` (a live write, counted like a creation). Anything else
 * is `already-filed` and untouched: a closed follow-up is a human's decision.
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

  // A path-less finding would misclassify as `file-removed`; skip the probe.
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
    if (probeError) return skip('probe-error');
    if (!exists) return skip('file-removed');
  }

  const source = classifier(finding.path, null);
  // Unroutable findings are deferred and named, never re-pointed at the
  // consumer's repo.
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

  // In-process memo closes the same-invocation race the search index cannot.
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

  // Built before dedup: the strong read scopes by these labels and a
  // recurrence writes this body.
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

  if (envelope.filed.length >= maxFilingsPerRun) return skip('cap-reached');

  // Before the strong read too: `gh issue list --label <absent>` exits 0
  // with `[]`, silently defeating the dedup confirm.
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
    return skip('label-ensure-failed');
  }

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
