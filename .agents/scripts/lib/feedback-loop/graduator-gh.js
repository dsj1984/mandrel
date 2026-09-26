/**
 * The graduator's gh/git primitives. Each takes one gh context value —
 * `{ ghPath, spawnImpl, cwd, timeoutMs }` — spread flat into its options.
 */

import { spawn as defaultSpawn } from 'node:child_process';

import { LABEL_COLORS } from '../label-constants.js';

export const DEFAULT_RUN_CHILD_TIMEOUT_MS = 30000;

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

function runWith(gh, cmd, args) {
  return runChild({
    cmd,
    args,
    spawnImpl: gh.spawnImpl,
    cwd: gh.cwd,
    timeoutMs: gh.timeoutMs,
  });
}

function runGh(gh, args) {
  return runWith(gh, gh.ghPath, args);
}

function childFailed(res) {
  return (
    Boolean(res.spawnError) || (typeof res.code === 'number' && res.code !== 0)
  );
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
export async function probePathStatus({ ref, path, ...gh }) {
  const res = await runWith(gh, 'git', ['cat-file', '-e', `${ref}:${path}`]);
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
export async function searchFollowUpByMarker({ marker, owner, repo, ...gh }) {
  const res = await runGh(gh, [
    'search',
    'issues',
    normalizeMarkerQuery(marker),
    '--repo',
    `${owner}/${repo}`,
    '--json',
    'number,state,url',
    '--limit',
    '1',
  ]);
  if (childFailed(res)) return null;
  try {
    const parsed = JSON.parse(res.stdout || '[]');
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return toFollowUpRef(parsed[0]);
  } catch {
    return null;
  }
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
 * @returns {Promise<{ number: number|null, state: string, url: string }|null>}
 */
export async function findExistingFollowUp({
  markers,
  owner,
  repo,
  labels,
  ...gh
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
  const res = await runGh(gh, args);
  if (childFailed(res)) return null;
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

function issueWriteError(verb, res) {
  return res.spawnError
    ? `gh issue ${verb} spawn failed: ${res.spawnError.message}`
    : `gh issue ${verb} exited ${res.code}: ${(res.stderr || '').trim()}`;
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
  ...gh
}) {
  const res = await runGh(gh, [
    'issue',
    'edit',
    String(number),
    '--repo',
    `${owner}/${repo}`,
    '--body',
    body,
  ]);
  if (childFailed(res))
    return { url: null, error: issueWriteError('edit', res) };
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
async function readLiveLabelNames({ owner, repo, labelCache, gh }) {
  const key = `${owner}/${repo}`;
  const cached = labelCache?.get(key);
  if (cached) return { known: cached, error: null };
  const res = await runGh(gh, [
    'label',
    'list',
    '--repo',
    key,
    '--limit',
    '500',
    '--json',
    'name',
  ]);
  if (childFailed(res)) {
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
 * @returns {Promise<{ created: string[], missing: string[], errors: string[] }>}
 */
export async function ensureIssueLabels({
  owner,
  repo,
  labels,
  labelCache,
  ...ghOpts
}) {
  const gh = { ...ghOpts, ghPath: ghOpts.ghPath ?? 'gh' };
  const wanted = (Array.isArray(labels) ? labels : []).filter(
    (name) => typeof name === 'string' && name.trim().length > 0,
  );
  if (wanted.length === 0) return { created: [], missing: [], errors: [] };

  const { known, error } = await readLiveLabelNames({
    owner,
    repo,
    labelCache,
    gh,
  });
  if (!known) return { created: [], missing: [], errors: error ? [error] : [] };

  const created = [];
  const missing = [];
  const errors = [];
  for (const name of wanted) {
    if (known.has(name)) continue;
    const { color, description } = describeMintedLabel(name);
    const res = await runGh(gh, [
      'label',
      'create',
      name,
      '--repo',
      `${owner}/${repo}`,
      '--color',
      color.replace(/^#/, ''),
      '--description',
      description,
    ]);
    // A concurrent mint between list and create is success.
    const raced = /label\b[\s\S]*?already exists/i.test(
      `${res.stderr ?? ''}${res.spawnError?.message ?? ''}`,
    );
    if (!childFailed(res) || raced) {
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
  ...gh
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
  const res = await runGh(gh, args);
  if (childFailed(res)) {
    return { url: null, error: issueWriteError('create', res) };
  }
  return { url: (res.stdout || '').trim(), error: null };
}
