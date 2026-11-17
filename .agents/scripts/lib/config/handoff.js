/** `delivery.handoff`: consumer checks the handoff runs beside close's gates. */

const isStringArray = (v) =>
  Array.isArray(v) && v.every((a) => typeof a === 'string');

/** A `{ cmd, args? }` entry with a non-empty `cmd` and string `args`. */
const isCheck = (c) =>
  typeof c?.cmd === 'string' &&
  c.cmd.length > 0 &&
  (c.args === undefined || isStringArray(c.args));

/** `delivery.handoff[key]`, malformed entries dropped. */
function checksAt(config, key) {
  const checks = config?.delivery?.handoff?.[key];
  if (!Array.isArray(checks)) return [];
  return checks
    .filter(isCheck)
    .map(({ cmd, args }) => ({ cmd, args: args ?? [] }));
}

/**
 * `delivery.handoff.postSeatChecks`, malformed entries dropped.
 *
 * @param {object|null|undefined} config
 * @returns {Array<{ cmd: string, args: string[] }>}
 */
export function getPostSeatChecks(config) {
  return checksAt(config, 'postSeatChecks');
}

/**
 * `delivery.handoff.firstChecks`, malformed entries dropped.
 *
 * @param {object|null|undefined} config
 * @returns {Array<{ cmd: string, args: string[] }>}
 */
export function getFirstChecks(config) {
  return checksAt(config, 'firstChecks');
}
