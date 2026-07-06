// .agents/scripts/lib/orchestration/finalize/open-or-locate-pr.js
/**
 * open-or-locate-pr.js — finalize helper that opens the Epic→main pull
 * request, or locates the existing one when finalize is replaying after
 * a crash between `gh pr create` and the `pr.created` emit.
 *
 * Extracted from `/deliver` Phase 7.1 prose so the lifecycle
 * Finalizer listener has a single async helper that returns the
 * `{ prNumber, url, created }` envelope it needs to compose
 * downstream emits.
 *
 * Story #2894 / Task #2908 (Epic #2880).
 *
 * Implementation: two `gh` shells.
 *
 *   1. Probe — `gh pr list --head <head> --json number,url --jq '.[0]'`.
 *      Returns the first open PR on the head branch (idempotent locate).
 *      If one exists, the helper returns `{ created: false, … }` with
 *      the existing PR's number + URL.
 *   2. Create — `gh pr create --base <base> --head <head>
 *      --title <title> --body <body>`. The stdout of `gh pr create` is
 *      the raw html_url; we follow up with `gh pr view <url>
 *      --json number,url` to harvest the canonical numeric id + api url.
 *
 * The probe/create split is what makes the helper safe to call twice on
 * the same head branch: the second call short-circuits at the probe and
 * does not attempt to create a duplicate PR. This is the AC-10
 * idempotency contract the Finalizer relies on for cross-process
 * re-runs of `/deliver`.
 *
 * Early-PR draft mode — Story #4359 (Epic #4355).
 *
 *   When `delivery.ci.earlyPr` is on (the default), `/deliver` opens the
 *   Epic PR as a **draft** at wave 1 (`openOrLocatePr({ draft: true })`)
 *   so every subsequent per-wave push runs CI attributed to its own wave.
 *   The `draft` flag only appends `--draft` to the `gh pr create` shell —
 *   the probe/locate path is unchanged, so a re-run on the same head
 *   branch still short-circuits without opening a duplicate. Phase 7 then
 *   flips that existing draft to ready-for-review via `markPrReady` rather
 *   than creating the PR. When `earlyPr` is off, no draft is opened at
 *   wave 1 and Phase 7 opens the PR at close time exactly as before
 *   (`openOrLocatePr` with no `draft`). The title/body contract
 *   (`feat: Epic #<id>` / `Closes #<id>`) is identical in both modes.
 */

import { spawnSync } from 'node:child_process';

import { sanitizeSkipCiMarkers } from './sanitize-skip-ci.js';

/**
 * Default `gh` invocation — matches the `shell: false` contract the
 * other listener helpers (`ghPrListHead`, `ghPrViewAutoMerge`) use so a
 * future Windows audit doesn't have to grep across modules.
 *
 * @param {{ args: string[], cwd?: string, input?: string, spawnFn?: typeof spawnSync }} opts
 */
export function defaultGhSpawn({ args, cwd, input, spawnFn = spawnSync }) {
  const result = spawnFn('gh', args, {
    cwd,
    encoding: 'utf-8',
    shell: false,
    input,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Parse `gh pr list --head <branch> --json number,url --jq '.[0]'` into
 * a `{ number, url }` envelope or `null`. Pure helper — exported for
 * tests so the parse regex is explicit and reviewable.
 *
 * Accepts:
 *   - empty / whitespace stdout (no PR on the head branch)
 *   - JSON object form `{"number":7,"url":"…"}`
 *   - JSON array form `[{"number":7,"url":"…"}]` (when `--jq` is absent)
 */
export function parsePrListResult(stdout) {
  const trimmed = String(stdout || '').trim();
  if (trimmed.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!candidate || typeof candidate !== 'object') return null;
  const num = Number(candidate.number);
  const url = typeof candidate.url === 'string' ? candidate.url : null;
  if (!Number.isInteger(num) || num <= 0 || !url) return null;
  return { number: num, url };
}

/**
 * Parse `gh pr view <url> --json number,url` into `{ number, url }`.
 * Used to canonicalise the `gh pr create` stdout (which is just the
 * html_url string) into the listener's `{ prNumber, url }` envelope.
 */
export function parsePrViewResult(stdout) {
  const trimmed = String(stdout || '').trim();
  if (trimmed.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const num = Number(parsed.number);
  const url = typeof parsed.url === 'string' ? parsed.url : null;
  if (!Number.isInteger(num) || num <= 0 || !url) return null;
  return { number: num, url };
}

/**
 * Open the Epic→base PR (or locate the existing one). Returns
 * `{ prNumber, url, created }`.
 *
 * @param {object} args
 * @param {number} args.epicId — Epic ticket id. Used to compose the
 *   default title and the `Closes #<epicId>` body trailer.
 * @param {string} args.headBranch — feature branch (typically
 *   `epic/<epicId>`).
 * @param {string} [args.baseBranch] — base branch. Default `main`.
 * @param {string} [args.title] — explicit PR title override; defaults
 *   to the Conventional Commit form `feat: Epic #<epicId>` so the
 *   squash-merge subject on `main` parses cleanly for release-please
 *   (a non-conventional subject is ignored, producing no version bump
 *   or changelog entry).
 * @param {string} [args.body] — explicit PR body override; defaults to
 *   `Closes #<epicId>`.
 * @param {boolean} [args.draft] — when `true`, open the new PR as a draft
 *   (`gh pr create --draft`). Story #4359: the early-PR path opens the
 *   Epic PR as a draft at wave 1 so per-wave pushes warm CI; Phase 7 later
 *   flips it ready via `markPrReady`. Only affects the create path — the
 *   locate short-circuit never inspects draft state, so a re-run stays
 *   idempotent. Default `false`.
 * @param {string} [args.cwd] — working directory for the gh shells.
 *   Default `process.cwd()`.
 * @param {Function} [args.ghSpawn] — override the gh invocation for
 *   tests. Same shape as `defaultGhSpawn`.
 * @returns {Promise<{ prNumber: number, url: string, created: boolean }>}
 */
export async function openOrLocatePr({
  epicId,
  headBranch,
  baseBranch = 'main',
  title,
  body,
  draft = false,
  cwd = process.cwd(),
  ghSpawn = defaultGhSpawn,
} = {}) {
  if (!Number.isInteger(epicId) || epicId < 1) {
    throw new TypeError('openOrLocatePr: epicId must be a positive integer');
  }
  if (typeof headBranch !== 'string' || headBranch.length === 0) {
    throw new TypeError(
      'openOrLocatePr: headBranch must be a non-empty string',
    );
  }
  if (typeof baseBranch !== 'string' || baseBranch.length === 0) {
    throw new TypeError(
      'openOrLocatePr: baseBranch must be a non-empty string',
    );
  }

  // 1. Probe — locate any existing open PR on the head branch.
  const probe = ghSpawn({
    args: [
      'pr',
      'list',
      '--head',
      headBranch,
      '--state',
      'open',
      '--json',
      'number,url',
      '--jq',
      '.[0]',
    ],
    cwd,
  });
  if (probe.status === 0) {
    const existing = parsePrListResult(probe.stdout);
    if (existing) {
      return { prNumber: existing.number, url: existing.url, created: false };
    }
  } else {
    throw new Error(
      `openOrLocatePr: gh pr list failed (status=${probe.status}): ${probe.stderr.trim()}`,
    );
  }

  // 2. Create — open the PR.
  // Default to the Conventional Commit form so the squash-merge subject
  // on `main` (PR title + `(#<pr>)`) parses for release-please. A bare
  // `Epic #<id>` subject carries no conventional type, so release-please
  // skips it — no version bump, no changelog entry.
  const finalTitle =
    typeof title === 'string' && title.length > 0
      ? title
      : `feat: Epic #${epicId}`;
  // Story #3165: strip any `[skip ci]` / `[ci skip]` / `[no ci]` /
  // `[skip actions]` / `[actions skip]` markers from the body before
  // handing it to `gh pr create`. Default body (`Closes #<epicId>`)
  // never contains them, but a caller-supplied body could carry the
  // markers in from upstream tooling — and any text that survives
  // into the squash commit body suppresses CI + release-please on
  // `main`.
  const rawBody =
    typeof body === 'string' && body.length > 0 ? body : `Closes #${epicId}`;
  const finalBody = sanitizeSkipCiMarkers(rawBody);
  const create = ghSpawn({
    args: [
      'pr',
      'create',
      '--base',
      baseBranch,
      '--head',
      headBranch,
      '--title',
      finalTitle,
      '--body',
      finalBody,
      // Story #4359: open as a draft when the early-PR path requests it.
      // The flag is elided entirely when `draft` is false so the
      // close-time (earlyPr=false) create path is byte-identical to the
      // pre-Story behaviour.
      ...(draft ? ['--draft'] : []),
    ],
    cwd,
  });
  if (create.status !== 0) {
    throw new Error(
      `openOrLocatePr: gh pr create failed (status=${create.status}): ${create.stderr.trim()}`,
    );
  }
  const htmlUrl = create.stdout.trim();
  if (htmlUrl.length === 0) {
    throw new Error(
      'openOrLocatePr: gh pr create returned empty stdout — cannot resolve PR number',
    );
  }

  // 3. View — canonicalise into `{ number, url }`.
  const view = ghSpawn({
    args: ['pr', 'view', htmlUrl, '--json', 'number,url'],
    cwd,
  });
  if (view.status !== 0) {
    throw new Error(
      `openOrLocatePr: gh pr view failed (status=${view.status}): ${view.stderr.trim()}`,
    );
  }
  const parsed = parsePrViewResult(view.stdout);
  if (!parsed) {
    throw new Error(
      `openOrLocatePr: gh pr view returned unparseable JSON: ${view.stdout.trim()}`,
    );
  }
  return { prNumber: parsed.number, url: parsed.url, created: true };
}

/**
 * Mark an existing draft PR as ready-for-review — Story #4359 (Epic
 * #4355). This is the Phase-7 counterpart to the wave-1 draft open: when
 * `delivery.ci.earlyPr` is on, the Epic PR already exists as a draft, so
 * finalize flips it ready rather than creating a PR.
 *
 * Idempotent: `gh pr ready` on an already-ready PR is a no-op that exits
 * 0, so re-running finalize (or replaying after a crash) is safe. When the
 * PR reference does not resolve, `gh` exits non-zero and this helper
 * throws with the stderr detail.
 *
 * @param {object} args
 * @param {string} args.pr — a PR reference `gh pr ready` accepts: the
 *   numeric id, the branch name, or the html URL. `openOrLocatePr`
 *   returns both `prNumber` and `url`; either is a valid input.
 * @param {string} [args.cwd] — working directory for the gh shell.
 *   Default `process.cwd()`.
 * @param {Function} [args.ghSpawn] — override the gh invocation for
 *   tests. Same shape as `defaultGhSpawn`.
 * @returns {Promise<{ pr: string, ready: true }>}
 */
export async function markPrReady({
  pr,
  cwd = process.cwd(),
  ghSpawn = defaultGhSpawn,
} = {}) {
  const ref = pr == null ? '' : String(pr).trim();
  if (ref.length === 0) {
    throw new TypeError('markPrReady: pr must be a non-empty reference');
  }
  const ready = ghSpawn({ args: ['pr', 'ready', ref], cwd });
  if (ready.status !== 0) {
    throw new Error(
      `markPrReady: gh pr ready failed (status=${ready.status}): ${ready.stderr.trim()}`,
    );
  }
  return { pr: ref, ready: true };
}
