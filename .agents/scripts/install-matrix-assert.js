#!/usr/bin/env node
// .agents/scripts/install-matrix-assert.js
/**
 * Golden-path install assertions for the install matrix (Story #3472).
 *
 * The `.github/workflows/install-matrix.yml` workflow exercises the published
 * package contract — install `mandrel`, run `mandrel sync`, run
 * `mandrel doctor` — across {npm, pnpm, yarn} x {ubuntu-latest,
 * windows-latest}. Rather than spread the per-leg invariants across
 * PowerShell-vs-bash shell snippets (which diverge on quoting, `$?`, and
 * separators per `.agents/rules/shell-conventions.md`), every leg shells out
 * to this single Node script so the checks run identically on every OS.
 *
 * It asserts three invariants against a consumer project directory:
 *
 *   1. `materialized` — `<consumer>/.agents/instructions.md` exists, i.e. the
 *      `.agents/` payload was materialized into the consumer working copy by
 *      `mandrel sync` (or the best-effort postinstall hook).
 *
 *   2. `manifest-clean` — the consumer's `package.json` was NOT mutated with
 *      the framework's internal runtime dependencies. Installing
 *      `mandrel` is expected to add exactly that one package to the
 *      consumer manifest (npm/pnpm/yarn all record the installed dep); what
 *      MUST NOT happen is the framework's own runtime deps (ajv, js-yaml,
 *      minimatch, …) leaking into the consumer's declared dependencies. Those
 *      packages are declared inside `.agents/runtime-deps.json` and the
 *      framework scripts free-ride on the consumer's node_modules — they are
 *      never written into the consumer's package.json.
 *
 *   3. `doctor-ready` — `mandrel doctor` exited 0 and printed the
 *      "✅  Ready" verdict line. This is asserted by the workflow step that
 *      runs doctor and pipes its output here via `--doctor-output <file>`.
 *
 * Each invariant can be run independently (`--check <name>`) or all at once
 * (default). The script exits 0 when every requested check passes and 1 (with
 * an actionable message on stderr) when any fails — so a CI step that invokes
 * it fails the leg loudly rather than silently.
 *
 * Usage:
 *   node .agents/scripts/install-matrix-assert.js \
 *     --consumer <dir> [--check materialized|manifest-clean|doctor-ready] \
 *     [--doctor-output <file>] [--package-name <name>]
 *
 * Security: pure local filesystem reads. No network, no shell, no secrets
 * logged. The doctor-output file is read as plain text and only scanned for
 * the verdict marker.
 *
 * Injectable seams (used by tests):
 *   - `fs`     — replaces the node:fs surface
 *   - `write`  — replaces process.stdout.write
 *   - `writeErr` — replaces process.stderr.write
 */

import nodeFs from 'node:fs';
import path from 'node:path';

/**
 * The framework's internal runtime dependencies. These are declared in
 * `.agents/runtime-deps.json` and provided by the consumer's install of
 * `mandrel` (npm hoists them into node_modules), but they MUST NOT
 * appear in the consumer's *declared* package.json dependencies. Kept in sync
 * with `.agents/runtime-deps.json` `dependencies` keys.
 */
const FRAMEWORK_RUNTIME_DEPS = [
  'ajv',
  'ajv-formats',
  'js-yaml',
  'minimatch',
  'picomatch',
  'string-argv',
  'typhonjs-escomplex',
];

/** The verdict marker `mandrel doctor` prints when every check passes. */
const DOCTOR_READY_MARKER = '✅  Ready';

const ALL_CHECKS = ['materialized', 'manifest-clean', 'doctor-ready'];

/**
 * Parse `--flag value` / `--flag=value` argv into an options object. Repeated
 * `--check` flags accumulate into an array.
 *
 * @param {string[]} argv
 * @returns {{ consumer?: string, checks: string[], doctorOutput?: string, packageName: string }}
 */
export function parseArgs(argv) {
  const opts = { checks: [], packageName: 'mandrel' };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
    const next = () => inlineValue ?? argv[++i];
    switch (flag) {
      case '--consumer':
        opts.consumer = next();
        break;
      case '--check':
        opts.checks.push(next());
        break;
      case '--doctor-output':
        opts.doctorOutput = next();
        break;
      case '--package-name':
        opts.packageName = next();
        break;
      default:
        // Ignore unknown flags so the script is forward-compatible with
        // additional workflow plumbing.
        break;
    }
  }
  if (opts.checks.length === 0) opts.checks = [...ALL_CHECKS];
  return opts;
}

/**
 * Assert the `.agents/` payload was materialized into the consumer project.
 *
 * @param {{ consumer: string, fs?: typeof nodeFs }} opts
 * @returns {{ ok: boolean, detail: string }}
 */
export function checkMaterialized({ consumer, fs = nodeFs }) {
  const target = path.join(consumer, '.agents', 'instructions.md');
  if (fs.existsSync(target)) {
    return { ok: true, detail: `.agents/ materialized (${target})` };
  }
  return {
    ok: false,
    detail: `./.agents/instructions.md not found at ${target} — \`mandrel sync\` did not materialize the payload.`,
  };
}

/**
 * Assert the consumer's package.json was not mutated with framework runtime
 * deps. Installing `mandrel` itself is expected; the framework's
 * internal runtime packages are not.
 *
 * @param {{ consumer: string, packageName: string, fs?: typeof nodeFs }} opts
 * @returns {{ ok: boolean, detail: string }}
 */
export function checkManifestClean({ consumer, packageName, fs = nodeFs }) {
  const manifestPath = path.join(consumer, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      detail: `could not read consumer package.json at ${manifestPath}: ${err.message}`,
    };
  }

  const declared = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
  };

  const leaked = FRAMEWORK_RUNTIME_DEPS.filter((dep) => dep in declared);
  if (leaked.length > 0) {
    return {
      ok: false,
      detail: `consumer package.json was mutated with framework runtime deps: ${leaked.join(', ')}`,
    };
  }

  // The framework package itself MAY be present (that is the intended install)
  // but its absence is also fine — the workflow installs it separately and the
  // assertion only guards against *unexpected* framework-internal deps.
  const hasFrameworkPkg = packageName in declared;
  return {
    ok: true,
    detail: hasFrameworkPkg
      ? `manifest clean: only '${packageName}' added, no framework runtime deps leaked`
      : 'manifest clean: no framework runtime deps leaked',
  };
}

/**
 * Assert `mandrel doctor` printed the ready verdict. The workflow captures
 * doctor's stdout to a file and passes it via `--doctor-output`.
 *
 * @param {{ doctorOutput?: string, fs?: typeof nodeFs }} opts
 * @returns {{ ok: boolean, detail: string }}
 */
export function checkDoctorReady({ doctorOutput, fs = nodeFs }) {
  if (!doctorOutput) {
    return {
      ok: false,
      detail:
        '--doctor-output <file> is required for the doctor-ready check (capture `mandrel doctor` stdout to it first).',
    };
  }
  let text;
  try {
    text = fs.readFileSync(doctorOutput, 'utf8');
  } catch (err) {
    return {
      ok: false,
      detail: `could not read doctor output at ${doctorOutput}: ${err.message}`,
    };
  }
  if (text.includes(DOCTOR_READY_MARKER)) {
    return { ok: true, detail: 'mandrel doctor reported a ready verdict' };
  }
  return {
    ok: false,
    detail:
      'mandrel doctor did not report a ready verdict (no "✅  Ready" line in captured output).',
  };
}

/**
 * Run the requested checks and report a per-check result. Exits non-zero when
 * any requested check fails.
 *
 * @param {{
 *   argv?: string[],
 *   fs?: typeof nodeFs,
 *   write?: (s: string) => void,
 *   writeErr?: (s: string) => void,
 * }} [opts]
 * @returns {{ ok: boolean, results: Array<{ name: string, ok: boolean, detail: string }> }}
 */
export function runAssertions({
  argv = process.argv.slice(2),
  fs = nodeFs,
  write = (s) => process.stdout.write(s),
  writeErr = (s) => process.stderr.write(s),
} = {}) {
  const opts = parseArgs(argv);

  if (!opts.consumer) {
    writeErr('install-matrix-assert: --consumer <dir> is required.\n');
    return { ok: false, results: [] };
  }

  const results = [];
  for (const name of opts.checks) {
    let result;
    switch (name) {
      case 'materialized':
        result = checkMaterialized({ consumer: opts.consumer, fs });
        break;
      case 'manifest-clean':
        result = checkManifestClean({
          consumer: opts.consumer,
          packageName: opts.packageName,
          fs,
        });
        break;
      case 'doctor-ready':
        result = checkDoctorReady({ doctorOutput: opts.doctorOutput, fs });
        break;
      default:
        result = { ok: false, detail: `unknown check '${name}'` };
        break;
    }
    results.push({ name, ...result });
  }

  for (const r of results) {
    const icon = r.ok ? 'PASS' : 'FAIL';
    const sink = r.ok ? write : writeErr;
    sink(`[${icon}] ${r.name}: ${r.detail}\n`);
  }

  const ok = results.every((r) => r.ok);
  return { ok, results };
}

// cli-opt-out: synchronous CLI whose bespoke main-guard forwards an explicit
// 0/1 exit code from runAssertions(); runAsCli's async-main signature does not
// preserve that result code (same rationale as coverage-capture.js).
// Run when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1]?.endsWith('install-matrix-assert.js');
if (invokedDirectly) {
  const { ok } = runAssertions();
  process.exit(ok ? 0 : 1);
}
