/** `delivery.handoff`: consumer checks the handoff re-runs after its seat. */

const isStringArray = (v) =>
  Array.isArray(v) && v.every((a) => typeof a === 'string');

/** A `{ cmd, args? }` entry with a non-empty `cmd` and string `args`. */
const isCheck = (c) =>
  typeof c?.cmd === 'string' &&
  c.cmd.length > 0 &&
  (c.args === undefined || isStringArray(c.args));

/**
 * `delivery.handoff.postSeatChecks`, malformed entries dropped.
 *
 * @param {object|null|undefined} config
 * @returns {Array<{ cmd: string, args: string[] }>}
 */
export function getPostSeatChecks(config) {
  const checks = config?.delivery?.handoff?.postSeatChecks;
  if (!Array.isArray(checks)) return [];
  return checks
    .filter(isCheck)
    .map(({ cmd, args }) => ({ cmd, args: args ?? [] }));
}
