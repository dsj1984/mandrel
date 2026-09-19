// .agents/scripts/lib/orchestration/ci-red-handling.js
/**
 * ci-red-handling.js — the first-red half of the no-rerun guard in
 * `rules/ci-remediation.md` § Verifier, shared by every path that observes a
 * red required check: the watcher (`pr-watch-with-update.js`) and the
 * close-and-land merge wait's `checks-failed` fail-fast. The digest itself
 * lives in `ci-rerun-guard.js`.
 */

import { Logger } from '../Logger.js';
import {
  resolveDigestScope,
  resolvePrHeadSha,
  writeCiDigest,
} from './ci-rerun-guard.js';

/**
 * The first-red handling every required-check red goes through — the
 * watcher's red path and the close's `checks-failed` fail-fast alike: disarm
 * auto-merge FIRST (the race-free moment), then write the digest keyed to the
 * red head SHA. One implementation, so the guard cannot drift per path.
 * Never throws: a digest-write failure is returned as `digestError`.
 *
 * @param {object} opts
 * @param {number|string|null} [opts.storyId]
 * @param {number} opts.prNumber
 * @param {string} opts.prRef
 * @param {Array<{name:string, outcome:string}>} opts.failures
 * @param {string} opts.tempRoot
 * @param {string} opts.cwd
 * @param {(args: { prRef: string }) => Promise<{ disarmed: boolean, alreadyUnarmed?: boolean, detail: string }>} opts.disarmFn
 * @param {string|null} [opts.headSha] Already-observed head SHA; probed when absent.
 * @param {Function} [opts.headShaFn]
 * @param {Function} [opts.writeDigestFn]
 * @param {object} [opts.logger]
 * @returns {Promise<{ headSha: string|null, disarm: object, digestPaths: { jsonPath: string, mdPath: string }|null, digestError: string|null }>}
 */
export async function recordRequiredRed({
  storyId = null,
  prNumber,
  prRef,
  failures,
  tempRoot,
  cwd,
  disarmFn,
  headSha = null,
  headShaFn = resolvePrHeadSha,
  writeDigestFn = writeCiDigest,
  logger = Logger,
}) {
  const disarm = await disarmFn({ prRef });
  const scope = resolveDigestScope({ storyId });
  const redHeadSha = scope ? (headSha ?? headShaFn({ prRef, cwd })) : null;
  let digestPaths = null;
  let digestError = null;
  try {
    digestPaths = writeDigestFn({
      storyId,
      prNumber,
      headSha: redHeadSha,
      failures,
      tempRoot,
      cwd,
      prRef,
    });
  } catch (err) {
    digestError = String(err?.message ?? err);
    logger?.warn?.(
      `[ci-rerun-guard] failed to write CI digest (non-fatal): ${digestError}`,
    );
  }
  return { headSha: redHeadSha, disarm, digestPaths, digestError };
}
