/**
 * manifest-story-views.js
 *
 * Story-execution manifest renderer (`formatStoryManifestMarkdown`) plus
 * the CLI dispatch-table printer (`printStoryDispatchTable`). Split out
 * of `manifest-formatter.js` (Story #1849 Task #1871) so the parent
 * collapses to the dispatch-manifest wiring facade.
 *
 * Re-exported from `manifest-formatter.js` so existing call-sites and
 * tests that import from there keep working without a path change.
 */

import { Logger } from '../Logger.js';

/**
 * Format the per-story execution manifest. Pure: caller must supply
 * `opts.config` (the canonical resolved config bag) so we can cite the
 * canonical `story-init.js` / `story-close.js` paths without touching
 * `resolveConfig` (fs).
 *
 * Reads `config.project.paths.scriptsRoot` and `config.project.commands.*`
 * from the post-reshape canonical blocks (Epic #1720). The fallback
 * strings keep the formatter usable in tiny test fixtures that omit the
 * paths / commands block.
 *
 * @param {object} manifest
 * @param {{ config?: { project?: { paths?: { scriptsRoot?: string }, commands?: { validate?: string, test?: string } } } }} [opts]
 * @returns {string}
 */
export function formatStoryManifestMarkdown(manifest, opts = {}) {
  const project = opts.config?.project ?? {};
  const scriptsRoot = project.paths?.scriptsRoot ?? '.agents/scripts';
  const commands = project.commands ?? {};
  const validateCmd = commands.validate ?? 'npm run lint';
  const testCmd = commands.test ?? 'npm test';

  const lines = [];
  lines.push(`# 📚 Story Execution Manifest`);
  lines.push('');
  lines.push(`> **Generated:** ${manifest.generatedAt}`);
  lines.push('');

  for (const story of manifest.stories) {
    lines.push(`## Story #${story.storyId}: ${story.storyTitle}`);
    lines.push(`- **Epic Branch:** \`${story.epicBranch}\``);
    lines.push(`- **Story Branch:** \`${story.branchName}\``);
    lines.push('');
    // Under the 3-tier hierarchy (Epic #3163) Stories are leaves with no
    // child Task tickets, so the per-Story Task projection has no live
    // producer. The renderer surfaces a single marker rather than the
    // legacy per-Task checkbox list.
    lines.push('_(no tasks)_');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## Execution Steps');
  lines.push('');

  const initPath = `${scriptsRoot}/story-init.js`;
  const closePath = `${scriptsRoot}/story-close.js`;

  lines.push(
    `1. \`node ${initPath} --story <storyId>\` (bootstraps branch, transitions Story)`,
  );
  lines.push(
    '2. Implement the Story body acceptance criteria and commit on the Story branch.',
  );
  lines.push(`3. Run \`${validateCmd}\` and \`${testCmd}\` to validate.`);
  lines.push(
    `4. \`node <main-repo>/${closePath} --story <storyId> --cwd <main-repo>\` (merges, cleans up, closes tickets)`,
  );
  lines.push('');

  return lines.join('\n');
}

/**
 * Print the CLI Story Dispatch Table. Writes to the supplied `logger.log`
 * channel (defaults to `Logger.info`). Keeping the sink injectable makes
 * the function testable without capturing stdout.
 *
 * @param {object[]} storyManifest
 * @param {{ logger?: { log: (line: string) => void } }} [opts]
 */
/* node:coverage ignore next */
export function printStoryDispatchTable(storyManifest, opts = {}) {
  const log = opts.logger?.log ?? ((line) => Logger.info(line));
  if (!storyManifest || storyManifest.length === 0) return;

  // Split into wave-eligible Stories and Feature containers
  const stories = storyManifest.filter((s) => s.type !== 'feature');
  const features = storyManifest.filter((s) => s.type === 'feature');

  log(
    '\n┌─────────┬──────────────────────────────────────┬──────┬────────────┬──────────────┐',
  );
  log(
    '│                           📋 STORY DISPATCH TABLE                            │',
  );
  log(
    '├─────────┼──────────────────────────────────────┼──────┼──────────────┤',
  );
  log(
    '│ Story   │ Title                                │ Wave │ Tasks        │',
  );
  log(
    '├─────────┼──────────────────────────────────────┼──────┼──────────────┤',
  );

  for (const story of stories) {
    const id =
      story.storyId === '__ungrouped__' ? '(none)' : `#${story.storyId}`;
    const title = (story.storySlug ?? '').substring(0, 36).padEnd(36);
    const wave = (
      story.earliestWave === -1 ? '-' : String(story.earliestWave)
    ).padEnd(4);
    const taskCount = `${story.tasks.length} task(s)`.padEnd(12);
    log(`│ ${id.padEnd(7)} │ ${title} │ ${wave} │ ${taskCount} │`);
  }

  log(
    '└─────────┴──────────────────────────────────────┴──────┴──────────────┘',
  );
  log('');
  log('  💡 Stories in the same [Wave] can be executed in parallel.');
  log('  💡 Use /epic-deliver #[Story ID] to execute a Story.');

  if (features.length > 0) {
    log('');
    log('  📦 Feature Containers (not directly executable):');
    for (const f of features) {
      log(
        `     #${f.storyId} — ${f.storySlug} (${f.tasks.length} orphaned tasks)`,
      );
    }
  }
  log('');
}
