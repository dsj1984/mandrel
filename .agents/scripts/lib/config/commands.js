/**
 * `project.commands.*` tri-state: absent → default; own-present `null` →
 * disabled (optional gates only); string → that command. Anything else throws.
 * A no-default key (`testChanged`) resolves absent the same as `null`.
 */

import { isObject } from '../json-utils.js';

/** `test` must stay byte-identical: every recorded `test` credit hashes it. */
export const COMMANDS_DEFAULTS = Object.freeze({
  test: 'npm test',
  typecheck: 'npm run typecheck',
  lint: 'npm run lint',
  formatCheck: 'npx biome format .',
  formatWrite: 'npx biome format --write .',
});

/** Every known key's absent value — a default, or `null` (disabled, no argv). */
const ABSENT_COMMANDS = Object.freeze({
  ...COMMANDS_DEFAULTS,
  testChanged: null,
});

/** The gates an explicit `null` disables. */
const OPTIONAL_COMMAND_KEYS = Object.freeze([
  'typecheck',
  'lint',
  'formatCheck',
  'testChanged',
]);

/** @param {string} raw */
function splitArgv(raw) {
  return raw.split(/\s+/).filter(Boolean);
}

/** @param {string} detail */
function configError(detail) {
  return new Error(`[config] project.commands${detail}.`);
}

/** @param {object|null|undefined} config */
function commandsBlock(config) {
  const commands = config?.project?.commands;
  if (commands === undefined) return {};
  if (!isObject(commands)) {
    throw configError(' must be an object of command strings');
  }
  return commands;
}

/** @param {string} raw @param {'default'|'config'} source */
function enabled(raw, source) {
  return { argv: splitArgv(raw), raw, disabled: false, source };
}

/** @param {string} key */
function disabledCommand(key) {
  if (!OPTIONAL_COMMAND_KEYS.includes(key)) {
    throw configError(`.${key} cannot be null — that gate is mandatory`);
  }
  return { argv: [], raw: null, disabled: true, source: 'disabled' };
}

/** @param {object} commands @param {string} key */
function isUnset(commands, key) {
  return !Object.hasOwn(commands, key) || commands[key] === undefined;
}

/** @param {string} key */
function absentCommand(key) {
  const fallback = ABSENT_COMMANDS[key];
  return fallback ? enabled(fallback, 'default') : disabledCommand(key);
}

/** @param {string} key @param {unknown} value */
function configuredCommand(key, value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0) {
    throw configError(`.${key} must be a non-empty command string`);
  }
  return enabled(raw, 'config');
}

/** @param {string} key */
function assertKnownKey(key) {
  if (!Object.hasOwn(ABSENT_COMMANDS, key)) {
    throw configError(`.${key} is not a known command`);
  }
}

/**
 * @param {object|null|undefined} config
 * @param {keyof typeof COMMANDS_DEFAULTS | 'testChanged'} key
 * @returns {{ argv: string[], raw: string|null, disabled: boolean, source: 'default'|'disabled'|'config' }}
 */
export function resolveProjectCommand(config, key) {
  assertKnownKey(key);
  const commands = commandsBlock(config);
  if (isUnset(commands, key)) return absentCommand(key);
  return commands[key] === null
    ? disabledCommand(key)
    : configuredCommand(key, commands[key]);
}

/** Projection over {@link resolveProjectCommand}; a disabled gate keeps `null`. */
export function getCommands(config) {
  return Object.fromEntries(
    Object.keys(ABSENT_COMMANDS).map((key) => [
      key,
      resolveProjectCommand(config, key).raw,
    ]),
  );
}
