/**
 * Transport / sandbox failure signatures for `gh` and GitHub calls: a fault
 * where GitHub (or `gh`'s own config) was never reached, so credentials were
 * not assessed. Shared by `gh-exec`'s classifier, the token resolver and the
 * identity preflight so the three can never disagree on what "transport" is.
 */

/** DNS, refused or timed-out connections, a denied spawn, an unreadable config dir. */
export const TRANSPORT_FAILURE_PATTERN =
  /etimedout|enotfound|econnrefused|econnreset|eai_again|dial tcp|error connecting to|could not resolve host|network is unreachable|operation not permitted|open [^\n]*: permission denied/i;

/** Remedy for every transport verdict — never `gh auth login`. */
export const TRANSPORT_REMEDY =
  'credentials were not assessed and re-authenticating will not help — re-run with network access (the escalated, non-sandboxed execution path)';

const TRANSPORT_ERROR_NAMES = new Set([
  'GhTransportError',
  'GhExecTimeoutError',
]);

/** Spawn error codes a sandbox raises when it denies the process. */
const SANDBOX_SPAWN_CODES = new Set(['EPERM', 'EACCES']);

/**
 * @param {unknown} spawnError
 * @returns {string|null} the sandbox denial code, or null
 */
export function sandboxDenialCode(spawnError) {
  const code = /** @type {any} */ (spawnError)?.code;
  return SANDBOX_SPAWN_CODES.has(code) ? code : null;
}

/**
 * True for a classified transport/timeout error or a transport signature in
 * its stderr/message.
 *
 * @param {any} err
 * @returns {boolean}
 */
export function isTransportFailure(err) {
  if (TRANSPORT_ERROR_NAMES.has(err?.name)) return true;
  return TRANSPORT_FAILURE_PATTERN.test(
    `${err?.stderr ?? ''}\n${err?.message ?? ''}`,
  );
}
