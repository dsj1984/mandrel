export const COMMANDS_DEFAULTS = Object.freeze({
  test: 'npm test',
  typecheck: null,
  lint: null,
  formatCheck: 'npx biome format .',
  formatWrite: 'npx biome format --write .',
});

/**
 * @param {object | null | undefined} config
 * @returns {{ test: string, typecheck: string|null, lint: string|null, formatCheck: string, formatWrite: string }}
 */
export function getCommands(config) {
  const commands = config?.project?.commands ?? {};
  // `??` is safe for the nullable keys: their default is `null` too.
  return Object.fromEntries(
    Object.keys(COMMANDS_DEFAULTS).map((key) => [
      key,
      commands[key] ?? COMMANDS_DEFAULTS[key],
    ]),
  );
}
