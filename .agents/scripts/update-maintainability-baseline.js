import path from 'node:path';
import { buildWriterScopeArgs } from './lib/baselines/diff-scope-cli.js';
import { write, writeFile } from './lib/baselines/writer.js';
import { getBaselineEpsilon } from './lib/config/quality.js';
import {
  getBaselines,
  getQuality,
  resolveConfig,
} from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { calculateAll, scanDirectory } from './lib/maintainability-utils.js';

/**
 * Script to update the maintainability baseline file.
 * Run this when you have intentionally improved code quality or
 * when adding new files that should be tracked.
 */

async function main() {
  const { agentSettings } = resolveConfig();
  const targetDirs = getQuality({ agentSettings }).maintainability.targetDirs;
  const baselinePath = getBaselines({ agentSettings }).maintainability.path;
  Logger.info('[Maintainability] Updating baseline...');

  const files = [];
  targetDirs.forEach((dir) => {
    Logger.info(`[Maintainability] Scanning ${dir}...`);
    scanDirectory(dir, files);
  });

  Logger.info(
    `[Maintainability] Calculating scores for ${files.length} files...`,
  );
  const scores = await calculateAll(files);

  // Story #1891: route through the shared writer. The legacy `saveBaseline`
  // emitted a flat `{ relPath: mi }` map; the writer assembles an envelope
  // (`$schema`, `kernelVersion`, `generatedAt`, `rollup`, `rows`) and
  // canonicalises every row path (defensive worktree-prefix policy).
  // Story #1974: epsilon is now applied by default for manual refreshes
  // so unchanged code with stale env produces a zero-row diff. The optional
  // `--diff-scope <ref>` narrows writes to files changed since <ref>.
  const rows = Object.entries(scores).map(([p, mi]) => ({ path: p, mi }));
  const absBaselinePath = path.isAbsolute(baselinePath)
    ? baselinePath
    : path.resolve(process.cwd(), baselinePath);
  const scopeArgs = buildWriterScopeArgs({
    kind: 'maintainability',
    absBaselinePath,
    epsilon: getBaselineEpsilon('maintainability', { agentSettings }),
    logger: Logger,
    logTag: '[Maintainability]',
  });
  const envelope = write({ kind: 'maintainability', rows, ...scopeArgs });
  writeFile(absBaselinePath, envelope);

  Logger.info(
    `[Maintainability] ✅ Baseline updated successfully at ${absBaselinePath} (kernelVersion=${envelope.kernelVersion}).`,
  );
}

// cli-opt-out: top-level main().catch predates runAsCli; never imported elsewhere so the auto-run risk is moot.
main().catch((err) => {
  Logger.error(`[Maintainability] ❌ Fatal error: ${err.message}`);
  process.exit(1);
});
