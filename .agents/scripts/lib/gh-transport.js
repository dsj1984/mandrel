/** Transport / sandbox failure signatures: GitHub was never reached, so credentials were not assessed. */

export const TRANSPORT_FAILURE_PATTERN =
  /etimedout|enotfound|econnrefused|econnreset|eai_again|dial tcp|error connecting to|could not resolve host|network is unreachable|operation not permitted|open [^\n]*: permission denied/i;

export const TRANSPORT_REMEDY =
  'credentials were not assessed and re-authenticating will not help — re-run with network access (the escalated, non-sandboxed execution path)';

const TRANSPORT_ERROR_NAMES = new Set([
  'GhTransportError',
  'GhExecTimeoutError',
]);

const SANDBOX_SPAWN_CODES = new Set(['EPERM', 'EACCES']);

/** @returns {string|null} */
export function sandboxDenialCode(spawnError) {
  const code = /** @type {any} */ (spawnError)?.code;
  return SANDBOX_SPAWN_CODES.has(code) ? code : null;
}

export function isTransportFailure(err) {
  if (TRANSPORT_ERROR_NAMES.has(err?.name)) return true;
  return TRANSPORT_FAILURE_PATTERN.test(
    `${err?.stderr ?? ''}\n${err?.message ?? ''}`,
  );
}
