/**
 * QA context hydrator — Story #3805, Epic #3798 (f1-shared-qa-core).
 *
 * Both QA front-ends (`/qa-explore` and `/qa-run`) need to load the
 * *grounded* surface context for an Epic before they reason about what to test:
 * the Epic body (which carries the folded Tech Spec sections and
 * Acceptance Table — Story #4324 retired the separate context tickets),
 * the project's `.feature` files, the implementation files the surface
 * map points at, and a slice of recent git history. Today a front-end that
 * trusts in-code comments ("this handler lives at …") can be wrong — the path
 * may have moved, or never existed on the base branch at all. This hydrator
 * removes that guesswork: it assembles every surface into one context object
 * and **verifies every surface-map path against the base ref (`main`)**,
 * marking any path absent on `main` as *unverified* rather than trusting it.
 *
 * ## No-network seam
 *
 * Every GitHub and git access flows through an **injected port** so the unit
 * test runs with no network and no real repository:
 *   - {@link GithubPort}  — `fetchIssue(number) → { number, body, labels }`.
 *   - {@link GitPort}     — `existsOnRef(path, ref) → boolean` and
 *                           `recentLog({ maxCount }) → LogEntry[]`.
 *   - `fsImpl`            — only used to enumerate `.feature` files; defaults
 *                           to `node:fs`.
 *
 * The hydrator never reaches the network itself; a caller in production wires
 * ports backed by `gh` / `git`, while a test wires in-memory fakes. This
 * mirrors the injected-seam style already used across `lib/qa/` (see
 * `qa-session.js`'s `fsImpl` and `redact-evidence.js`).
 */

import fs from 'node:fs';
import path from 'node:path';

/** The base ref every surface-map path is verified against. */
export const DEFAULT_BASE_REF = 'main';

/** How many recent commits the hydrator pulls into the context object. */
export const DEFAULT_LOG_MAX_COUNT = 20;

/**
 * @typedef {object} GithubPort
 * @property {(issueNumber: number) => Promise<{
 *   number: number,
 *   body: string,
 *   labels?: string[],
 * }>} fetchIssue Fetch one issue's body + labels.
 */

/**
 * @typedef {object} GitPort
 * @property {(filePath: string, ref: string) => boolean | Promise<boolean>}
 *   existsOnRef True when `filePath` is tracked on `ref` (e.g. `main`).
 * @property {(opts: { maxCount: number }) =>
 *   Array<{ sha: string, subject: string }>
 *   | Promise<Array<{ sha: string, subject: string }>>}
 *   recentLog Recent commit log, newest first.
 */

/**
 * @typedef {object} SurfaceMapEntry
 * @property {string} path Repo-relative implementation file path.
 * @property {string} [note] Free-form provenance note (e.g. a code comment).
 */

/**
 * Enumerate the `.feature` files under `featureRoot`, returning repo-relative
 * POSIX-style paths sorted for determinism. A missing root yields an empty
 * array (a project that has not authored features is not an error).
 *
 * @param {string | undefined} featureRoot
 * @param {{ fsImpl?: typeof fs }} [opts]
 * @returns {string[]}
 */
export function collectFeatureFiles(featureRoot, opts = {}) {
  const fsImpl = opts.fsImpl ?? fs;
  if (!featureRoot || !fsImpl.existsSync(featureRoot)) return [];

  const found = [];
  const walk = (dir) => {
    const entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.feature')) {
        found.push(full.split(path.sep).join('/'));
      }
    }
  };
  walk(featureRoot);
  return found.sort();
}

/**
 * Verify each surface-map entry against the base ref. An entry whose path is
 * tracked on `baseRef` is `verified: true`; an entry absent on the base ref is
 * `verified: false` — the surface map (or the code comment it came from) named
 * a path that does not exist on `main`, so the front-end must treat it as
 * unverified rather than trusting it.
 *
 * @param {SurfaceMapEntry[]} surfaceMap
 * @param {GitPort} gitPort
 * @param {string} baseRef
 * @returns {Promise<Array<{
 *   path: string,
 *   note: string | null,
 *   verified: boolean,
 * }>>}
 */
export async function verifySurfaceMap(surfaceMap, gitPort, baseRef) {
  const entries = Array.isArray(surfaceMap) ? surfaceMap : [];
  const verified = [];
  for (const entry of entries) {
    const filePath = typeof entry === 'string' ? entry : entry?.path;
    if (!filePath) continue;
    const exists = await gitPort.existsOnRef(filePath, baseRef);
    verified.push({
      path: filePath,
      note: typeof entry === 'object' && entry?.note ? entry.note : null,
      verified: Boolean(exists),
    });
  }
  return verified;
}

/**
 * Hydrate the QA context object for an Epic.
 *
 * Assembles, in one object:
 *   - `epic`            — the Epic's `{ number, body, labels }`. The body is
 *                         the single planning document (ideation sections +
 *                         folded Tech Spec sections + Acceptance Table).
 *   - `featureFiles`    — repo-relative paths of the project's `.feature` files.
 *   - `implementation`  — the verified surface map (each entry carries
 *                         `verified` against the base ref).
 *   - `gitLog`          — recent commits, newest first.
 *   - `baseRef`         — the ref every path was verified against.
 *   - `unverifiedPaths` — the subset of surface-map paths absent on `baseRef`.
 *
 * Every GitHub and git access flows through the injected ports, so this runs
 * with no network when the ports are fakes.
 *
 * @param {{
 *   epicNumber: number,
 *   githubPort: GithubPort,
 *   gitPort: GitPort,
 *   surfaceMap?: SurfaceMapEntry[],
 *   featureRoot?: string,
 *   baseRef?: string,
 *   logMaxCount?: number,
 *   fsImpl?: typeof fs,
 * }} opts
 * @returns {Promise<{
 *   epic: { number: number, body: string, labels: string[] },
 *   featureFiles: string[],
 *   implementation: Array<{ path: string, note: string | null, verified: boolean }>,
 *   gitLog: Array<{ sha: string, subject: string }>,
 *   baseRef: string,
 *   unverifiedPaths: string[],
 * }>}
 */
export async function hydrateQaContext(opts) {
  const {
    epicNumber,
    githubPort,
    gitPort,
    surfaceMap = [],
    featureRoot,
    baseRef = DEFAULT_BASE_REF,
    logMaxCount = DEFAULT_LOG_MAX_COUNT,
    fsImpl,
  } = opts ?? {};

  if (!Number.isInteger(epicNumber)) {
    throw new Error(
      'hydrateQaContext: `epicNumber` is required and must be an integer',
    );
  }
  if (!githubPort || typeof githubPort.fetchIssue !== 'function') {
    throw new Error(
      'hydrateQaContext: `githubPort.fetchIssue` is required (inject a port)',
    );
  }
  if (
    !gitPort ||
    typeof gitPort.existsOnRef !== 'function' ||
    typeof gitPort.recentLog !== 'function'
  ) {
    throw new Error(
      'hydrateQaContext: `gitPort` must expose `existsOnRef` and `recentLog`',
    );
  }

  const epicIssue = await githubPort.fetchIssue(epicNumber);
  const epic = {
    number: epicIssue.number,
    body: epicIssue.body ?? '',
    labels: Array.isArray(epicIssue.labels) ? [...epicIssue.labels] : [],
  };

  const featureFiles = collectFeatureFiles(featureRoot, { fsImpl });
  const implementation = await verifySurfaceMap(surfaceMap, gitPort, baseRef);
  const gitLog = await gitPort.recentLog({ maxCount: logMaxCount });
  const unverifiedPaths = implementation
    .filter((entry) => !entry.verified)
    .map((entry) => entry.path);

  return {
    epic,
    featureFiles,
    implementation,
    gitLog: Array.isArray(gitLog) ? gitLog : [],
    baseRef,
    unverifiedPaths,
  };
}
