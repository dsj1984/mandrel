// lib/migrations/steps/2.91.0-unset-null-lint-command.js
/**
 * Drop an explicit `project.commands.lint: null`. It used to mean "use the
 * `npm run lint` default" (the shipped reference carried it), and now means
 * "disable the lint gate"; removing the key keeps the old behaviour. A
 * consumer who wants lint off sets `null` again after the upgrade. Builtins
 * only.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

const AGENTRC_FILENAMES = Object.freeze([
  '.agentrc.json',
  '.agentrc.local.json',
]);

/** @param {unknown} ctx @param {string} filename */
function agentrcPath(ctx, filename) {
  return path.join(ctx?.projectRoot ?? process.cwd(), filename);
}

/** @param {unknown} ctx @param {string} filename @param {typeof nodeFs} fsImpl */
function readConfig(ctx, filename, fsImpl) {
  try {
    return JSON.parse(fsImpl.readFileSync(agentrcPath(ctx, filename), 'utf8'));
  } catch {
    return null;
  }
}

/** @param {object|null} config */
function hasNullLint(config) {
  const commands = config?.project?.commands;
  return (
    commands !== null &&
    typeof commands === 'object' &&
    Object.hasOwn(commands, 'lint') &&
    commands.lint === null
  );
}

export const unsetNullLintCommand = {
  version: '2.91.0',
  description:
    'drop an explicit project.commands.lint: null, which now disables the ' +
    'lint gate instead of meaning the npm run lint default (Story #5737)',
  /** @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx] */
  detect(ctx) {
    const fsImpl = ctx?.fs ?? nodeFs;
    return AGENTRC_FILENAMES.some((name) =>
      hasNullLint(readConfig(ctx, name, fsImpl)),
    );
  },
  /** @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx] */
  apply(ctx) {
    const fsImpl = ctx?.fs ?? nodeFs;
    for (const name of AGENTRC_FILENAMES) {
      const config = readConfig(ctx, name, fsImpl);
      if (!hasNullLint(config)) continue;
      delete config.project.commands.lint;
      fsImpl.writeFileSync(
        agentrcPath(ctx, name),
        `${JSON.stringify(config, null, 2)}\n`,
      );
    }
  },
};
