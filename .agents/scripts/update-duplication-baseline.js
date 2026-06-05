// Fail-fast if the framework's runtime deps are not installed — must be the
// first import so the check runs before any third-party-importing sibling
// module is evaluated (Story #3432).
import './lib/runtime-deps/ensure-installed.js';
import { createRequire } from 'node:module';
import path from 'node:path';
import { buildWriterScopeArgs } from './lib/baselines/diff-scope-cli.js';
import { scanDuplication } from './lib/baselines/duplication-scanner.js';
import { write, writeFile } from './lib/baselines/writer.js';
import { getBaselineEpsilon } from './lib/config/quality.js';
import { getQuality, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';

/**
 * CLI: scan → score → save the code-duplication (DRY) baseline (Story #3664).
 *
 * Writes the canonical duplication baseline at the path resolved from
 * `delivery.quality.gates.duplication.baselinePath` (default
 * `baselines/duplication.json`), or the path supplied via `--baseline <path>`.
 * Output is a deterministic, kernel-stamped envelope produced by the shared
 * writer — every row path is canonicalised, the per-kind rollup math runs,
 * and the envelope is schema-validated before persisting.
 *
 * Mirrors `update-crap-baseline.js`: thin CLI shell + shared writer funnel.
 * The duplication scan delegates to jscpd's `detectClones` (a pure clone
 * detector with no test coupling), wrapped by `scanDuplication` so the
 * parse→envelope path is unit-testable with the scanner mocked.
 *
 * Exits non-zero only when the scanner itself crashes. An empty result (no
 * detected clones) still writes an envelope with `rows: []` so downstream
 * `check-baselines` can tell "intentional empty baseline" apart from "no
 * baseline yet".
 */

const require = createRequire(import.meta.url);

/**
 * Resolve jscpd's `detectClones` lazily. The jscpd ESM entrypoint has a
 * broken transitive `colors/safe` specifier under Node's strict ESM
 * resolver, so we load the CJS build via `createRequire`. Isolated here so
 * the rest of the module stays import-pure and testable.
 *
 * @returns {(opts: object) => Promise<Array<object>>}
 */
function resolveDetectClones() {
  const jscpd = require('jscpd');
  if (typeof jscpd.detectClones !== 'function') {
    throw new Error(
      "[Duplication] jscpd.detectClones is not available — run 'npm install'",
    );
  }
  return jscpd.detectClones;
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const out = { baselinePath: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--baseline' && argv[i + 1]) {
      out.baselinePath = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

/**
 * Resolve the duplication gate block from the merged quality config. The
 * flattened legacy bag does not expose a `duplication` accessor (the kind
 * post-dates the bag), so read it off the resolved `gates` map directly.
 *
 * @param {object} config resolved config
 * @returns {object} the duplication gate block (possibly empty)
 */
function resolveDuplicationGate(config) {
  const gates = getQuality(config).gates ?? {};
  return gates.duplication ?? {};
}

async function main() {
  const args = parseCliArgs();
  const config = resolveConfig();
  const gate = resolveDuplicationGate(config);
  const targetDirs = Array.isArray(gate.targetDirs) ? gate.targetDirs : [];
  const ignoreGlobs = Array.isArray(gate.ignoreGlobs) ? gate.ignoreGlobs : [];
  const baselinePath =
    args.baselinePath ?? gate.baselinePath ?? 'baselines/duplication.json';

  Logger.info('[Duplication] Updating baseline...');
  Logger.info(`[Duplication] Target dirs: ${targetDirs.join(', ')}`);

  const rows = await scanDuplication({
    targetDirs,
    cwd: process.cwd(),
    ignoreGlobs,
    detect: resolveDetectClones(),
  });

  const absBaselinePath = path.isAbsolute(baselinePath)
    ? baselinePath
    : path.resolve(process.cwd(), baselinePath);

  // Route through the shared writer: canonicalise paths, run the per-kind
  // rollup, stamp `$schema` / `kernelVersion` / `generatedAt`, and validate
  // against the duplication schema before persisting. Epsilon is applied by
  // default so unchanged code with stale env produces a zero-row diff.
  const scopeArgs = buildWriterScopeArgs({
    kind: 'duplication',
    absBaselinePath,
    epsilon: getBaselineEpsilon('duplication', config),
    logger: Logger,
    logTag: '[Duplication]',
  });
  const envelope = write({
    kind: 'duplication',
    rows,
    ...scopeArgs,
  });
  writeFile(absBaselinePath, envelope);

  Logger.info(
    `[Duplication] Scanned ${rows.length} file(s) with detected duplication; wrote ${envelope.rows.length} row(s).`,
  );
  Logger.info(
    `[Duplication] ✅ Baseline updated (kernelVersion=${envelope.kernelVersion}). Wrote to ${absBaselinePath}.`,
  );
}

// cli-opt-out: top-level main().catch predates runAsCli; never imported elsewhere so the auto-run risk is moot.
main().catch((err) => {
  Logger.error(
    `[Duplication] ❌ Fatal error: ${err?.stack ?? err?.message ?? err}`,
  );
  process.exit(1);
});
