import {
  getBaselines,
  getQuality,
  resolveConfig,
} from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  calculateAll,
  saveBaseline,
  scanDirectory,
} from './lib/maintainability-utils.js';

/**
 * Script to update the maintainability baseline file.
 * Run this when you have intentionally improved code quality or
 * when adding new files that should be tracked.
 */

async function main() {
  const { settings } = resolveConfig();
  const targetDirs = getQuality({ agentSettings: settings }).maintainability
    .targetDirs;
  const baselinePath = getBaselines({ agentSettings: settings }).maintainability
    .path;
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

  saveBaseline(scores, baselinePath);

  Logger.info(
    `[Maintainability] ✅ Baseline updated successfully at ${baselinePath}`,
  );
}

// cli-opt-out: top-level main().catch predates runAsCli; never imported elsewhere so the auto-run risk is moot.
main().catch((err) => {
  Logger.error(`[Maintainability] ❌ Fatal error: ${err.message}`);
  process.exit(1);
});
