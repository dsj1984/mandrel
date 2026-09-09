/**
 * `project.commands` accessor (Epic #1720 Story #1739 — top-level reshape).
 *
 * The command keys are `test`, `typecheck`, `lint`, `formatCheck`,
 * `formatWrite`.
 */

export const COMMANDS_DEFAULTS = Object.freeze({
  test: 'npm test',
  typecheck: null,
  lint: null,
  formatCheck: 'npx biome format .',
  formatWrite: 'npx biome format --write .',
});

/**
 * Read the grouped `project.commands` block, applying framework defaults
 * for any field the operator omitted. Accepts the full resolved config or
 * a bare `{ project }` bag.
 *
 * @param {object | null | undefined} config
 * @returns {{ test: string, typecheck: string|null, lint: string|null, formatCheck: string, formatWrite: string }}
 */
export function getCommands(config) {
  const commands = config?.project?.commands ?? {};
  // `??` is uniform across every key: the two nullable ones (`typecheck`,
  // `lint`) default to `null` themselves, so coalescing an explicit `null`
  // onto the default returns that same `null` — the per-key `=== undefined`
  // ladder this replaces drew a distinction that had no observable effect.
  return Object.fromEntries(
    Object.keys(COMMANDS_DEFAULTS).map((key) => [
      key,
      commands[key] ?? COMMANDS_DEFAULTS[key],
    ]),
  );
}
