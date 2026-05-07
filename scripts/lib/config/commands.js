/**
 * `agentSettings.commands` accessor (Epic #730 Story 5; relocated under
 * lib/config/ in Epic #773 Story 6).
 */

/**
 * Defaults applied when a setting omits `agentSettings.commands` or any field
 * within it. Mirrors the long-standing built-in fallbacks the framework used
 * before Epic #730 Story 5 grouped these keys; consumers that previously read
 * `settings.<flatCommand> ?? '<default>'` now go through {@link getCommands}.
 *
 * `typecheck` and `build` default to `null` (Story 3 disabled-means-null
 * convention) — consumers short-circuit on falsy values.
 */
export const COMMANDS_DEFAULTS = Object.freeze({
  validate: 'npm run lint',
  lintBaseline: 'npx eslint . --format json',
  test: 'npm test',
  typecheck: null,
  build: null,
  formatCheck: 'npx biome format .',
  formatWrite: 'npx biome format --write .',
});

/**
 * Read the grouped `agentSettings.commands` block, applying framework defaults
 * for any field the operator omitted.
 *
 * @param {{ agentSettings?: { commands?: object } } | object | null | undefined} config
 *   Either the full resolved config (`{ agentSettings, orchestration, ... }`)
 *   or the bare `agentSettings` bag — both shapes are accepted so call sites
 *   can pass whichever they already have in scope.
 * @returns {{ validate: string, lintBaseline: string, test: string, typecheck: string|null, build: string|null }}
 */
export function getCommands(config) {
  const commands = config?.agentSettings?.commands || config?.commands || {};
  return {
    validate: commands.validate ?? COMMANDS_DEFAULTS.validate,
    lintBaseline: commands.lintBaseline ?? COMMANDS_DEFAULTS.lintBaseline,
    test: commands.test ?? COMMANDS_DEFAULTS.test,
    typecheck:
      commands.typecheck === undefined
        ? COMMANDS_DEFAULTS.typecheck
        : commands.typecheck,
    build:
      commands.build === undefined ? COMMANDS_DEFAULTS.build : commands.build,
    formatCheck: commands.formatCheck ?? COMMANDS_DEFAULTS.formatCheck,
    formatWrite: commands.formatWrite ?? COMMANDS_DEFAULTS.formatWrite,
  };
}
