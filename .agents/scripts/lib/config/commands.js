/**
 * `project.commands.*` tri-state: absent → default; own-present `null` →
 * disabled (optional gates only); string → that command. Anything else throws.
 */

/** `test` must stay byte-identical: every recorded `test` credit hashes it. */
export const COMMANDS_DEFAULTS = Object.freeze({
  test: 'npm test',
  typecheck: 'npm run typecheck',
  lint: 'npm run lint',
  formatCheck: 'npx biome format .',
  formatWrite: 'npx biome format --write .',
});

/** The gates an explicit `null` disables. */
const OPTIONAL_COMMAND_KEYS = Object.freeze([
  'typecheck',
  'lint',
  'formatCheck',
]);

/** @param {string} raw */
function splitArgv(raw) {
  return raw.split(/\s+/).filter(Boolean);
}

/** @param {string} detail */
function configError(detail) {
  return new Error(`[config] project.commands${detail}.`);
}

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {object|null|undefined} config */
function commandsBlock(config) {
  const commands = config?.project?.commands;
  if (commands === undefined) return {};
  if (!isPlainObject(commands)) {
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
  if (!Object.hasOwn(COMMANDS_DEFAULTS, key)) {
    throw configError(`.${key} is not a known command`);
  }
}

/**
 * @param {object|null|undefined} config
 * @param {keyof typeof COMMANDS_DEFAULTS} key
 * @returns {{ argv: string[], raw: string|null, disabled: boolean, source: 'default'|'disabled'|'config' }}
 */
export function resolveProjectCommand(config, key) {
  assertKnownKey(key);
  const commands = commandsBlock(config);
  if (!Object.hasOwn(commands, key) || commands[key] === undefined) {
    return enabled(COMMANDS_DEFAULTS[key], 'default');
  }
  return commands[key] === null
    ? disabledCommand(key)
    : configuredCommand(key, commands[key]);
}

/** Projection over {@link resolveProjectCommand}; a disabled gate keeps `null`. */
export function getCommands(config) {
  return Object.fromEntries(
    Object.keys(COMMANDS_DEFAULTS).map((key) => [
      key,
      resolveProjectCommand(config, key).raw,
    ]),
  );
}
