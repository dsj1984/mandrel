import path from 'node:path';
import { buildWriterScopeArgs } from './lib/baselines/diff-scope-cli.js';
import { write, writeFile } from './lib/baselines/writer.js';
import { getBaselineEpsilon } from './lib/config/quality.js';
import {
  getBaselines,
  getQuality,
  resolveConfig,
} from './lib/config-resolver.js';
import { loadCoverage } from './lib/coverage-utils.js';
import {
  resolveEscomplexVersion,
  resolveTsTranspilerVersion,
  scanAndScore,
} from './lib/crap-utils.js';

import { Logger } from './lib/Logger.js';

/**
 * CLI: scan → score → save the CRAP baseline.
 *
 * Writes the canonical CRAP baseline at the path resolved from
 * `agentSettings.quality.baselines.crap.path` (default `baselines/crap.json`),
 * or the path supplied via `--baseline <path>`. Output is a deterministic,
 * kernel-stamped envelope. Files without coverage entries are skipped (not
 * scored as 0%) when `requireCoverage: true` — their count and names are
 * logged so the operator can tell the difference between "unscorable" and
 * "safe zero".
 *
 * Exits non-zero only when the scanner itself crashes. An empty result (no
 * coverage at all, no scored methods) still writes an envelope with `rows: []`
 * so downstream `check-crap` can tell "intentional empty baseline" apart from
 * "no baseline yet".
 */

function parseCliArgs(argv = process.argv.slice(2)) {
  const out = { baselinePath: undefined, coveragePath: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--baseline' && argv[i + 1]) {
      out.baselinePath = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--coverage' && argv[i + 1]) {
      out.coveragePath = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

async function main() {
  const args = parseCliArgs();
  const config = resolveConfig();
  const crap = getQuality(config).crap;
  const targetDirs = Array.isArray(crap.targetDirs) ? crap.targetDirs : [];
  const requireCoverage = crap.requireCoverage !== false;
  const coveragePath =
    args.coveragePath ?? crap.coveragePath ?? 'coverage/coverage-final.json';
  const baselinePath =
    args.baselinePath ?? getBaselines(config).crap.path;

  Logger.info('[CRAP] Updating baseline...');
  Logger.info(`[CRAP] Target dirs: ${targetDirs.join(', ')}`);
  Logger.info(
    `[CRAP] Coverage source: ${coveragePath}${requireCoverage ? ' (required)' : ' (optional)'}`,
  );

  const coverage = loadCoverage(path.resolve(process.cwd(), coveragePath));
  if (!coverage && requireCoverage) {
    Logger.warn(
      `[CRAP] ⚠ No coverage artifact at ${coveragePath}. All files will be skipped under requireCoverage=true.`,
    );
    Logger.warn(
      "[CRAP] ⚠ Run 'npm run test:coverage' before 'npm run crap:update'.",
    );
  }

  const {
    rows,
    scannedFiles,
    skippedFilesNoCoverage,
    skippedMethodsNoCoverage,
  } = await scanAndScore({
    targetDirs,
    coverage,
    requireCoverage,
    cwd: process.cwd(),
  });

  const escomplexVersion = resolveEscomplexVersion();
  const tsTranspilerVersion = resolveTsTranspilerVersion();
  // Story #1891: route through the shared writer. The writer canonicalises
  // every row path, applies the per-kind row + rollup math, stamps
  // `$schema` / `kernelVersion` / `generatedAt`, and validates against the
  // per-kind schema before persisting. Kept the legacy escomplex /
  // ts-transpiler version logging so existing operator-visible output
  // doesn't churn.
  // Story #1974: epsilon is now applied by default for manual refreshes
  // so unchanged code with stale env produces a zero-row diff. The optional
  // `--diff-scope <ref>` narrows writes to files changed since <ref>; when
  // absent, behaviour is unchanged from pre-#1974 (full rewrite).
  const absBaselinePath = path.isAbsolute(baselinePath)
    ? baselinePath
    : path.resolve(process.cwd(), baselinePath);
  const scopeArgs = buildWriterScopeArgs({
    kind: 'crap',
    absBaselinePath,
    epsilon: getBaselineEpsilon('crap', config),
    logger: Logger,
    logTag: '[CRAP]',
  });
  const envelope = write({
    kind: 'crap',
    rows: rows.filter(
      (r) => typeof r?.crap === 'number' && Number.isFinite(r.crap),
    ),
    ...scopeArgs,
  });
  writeFile(absBaselinePath, envelope);

  Logger.info(
    `[CRAP] Scanned ${scannedFiles} file(s); wrote ${envelope.rows.length} row(s).`,
  );
  if (skippedFilesNoCoverage > 0) {
    Logger.info(
      `[CRAP] Skipped ${skippedFilesNoCoverage} file(s) without coverage entries.`,
    );
  }
  if (skippedMethodsNoCoverage > 0) {
    Logger.info(
      `[CRAP] Skipped ${skippedMethodsNoCoverage} method(s) whose per-method coverage was unresolved.`,
    );
  }
  Logger.info(
    `[CRAP] ✅ Baseline updated (kernelVersion=${envelope.kernelVersion}, escomplexVersion=${escomplexVersion}, tsTranspilerVersion=${tsTranspilerVersion}). Wrote to ${absBaselinePath}.`,
  );
}

// cli-opt-out: top-level main().catch predates runAsCli; never imported elsewhere so the auto-run risk is moot.
main().catch((err) => {
  Logger.error(`[CRAP] ❌ Fatal error: ${err?.stack ?? err?.message ?? err}`);
  process.exit(1);
});
