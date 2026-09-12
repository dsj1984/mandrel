/**
 * lib/test-isolate/render-report.js — the human-readable `test-isolate` report.
 *
 * Story #5316: extracted verbatim from `.agents/scripts/test-isolate.js`,
 * where no test could reach it (CRAP 72 at cyclomatic 8, 0% coverage). Pure
 * string building — no I/O, no clock — so the whole surface is assertable.
 *
 * The three sections it renders are split into helpers so each is
 * independently readable and none of them alone approaches the cyclomatic
 * ceiling; `renderReport` is left as the composition.
 */

/**
 * The flipper section: files that passed alone and failed in the suite, plus
 * the bisection suspects for each.
 *
 * @param {string[]} lines Accumulator, appended in place.
 * @param {import('./runner.js').IsolateReport} report
 */
function pushFlipperSection(lines, report) {
  if (report.flippers.length === 0) {
    lines.push('✓ No flippers detected — every file that passed alone');
    lines.push('  also passed in the full suite run.');
    return;
  }
  lines.push(`✗ ${report.flippers.length} flipper(s) detected:`);
  for (const f of report.flippers) lines.push(`  - ${f}`);
  lines.push('');
  if (report.bisections.length === 0) return;
  lines.push('Likely polluters (bisection suspects):');
  for (const b of report.bisections) {
    const tag = b.inconclusive ? ' [inconclusive]' : '';
    lines.push(`  ${b.file}${tag}`);
    for (const s of b.suspects) lines.push(`    ← ${s}`);
  }
}

/**
 * One env-mutating file's added/removed/changed summary. Empty parts are
 * omitted, so a file that only added a var reads as `added=[...]` alone.
 *
 * @param {{added: string[], removed: string[], changed: string[]}} envDiff
 * @returns {string}
 */
function formatEnvDiff(envDiff) {
  const parts = [];
  if (envDiff.added.length > 0)
    parts.push(`added=[${envDiff.added.join(', ')}]`);
  if (envDiff.removed.length > 0) {
    parts.push(`removed=[${envDiff.removed.join(', ')}]`);
  }
  if (envDiff.changed.length > 0) {
    parts.push(`changed=[${envDiff.changed.join(', ')}]`);
  }
  return parts.join(' ');
}

/**
 * The env-leak section: files whose process exited with `process.env` still
 * mutated, called out even when no failure cascade has manifested yet.
 *
 * @param {string[]} lines Accumulator, appended in place.
 * @param {import('./runner.js').IsolateReport} report
 */
function pushEnvSection(lines, report) {
  if (report.envMutators.length === 0) {
    lines.push('✓ No env-var leaks detected across isolated runs.');
    return;
  }
  lines.push(
    `⚠ ${report.envMutators.length} file(s) left process.env mutated:`,
  );
  for (const m of report.envMutators) {
    lines.push(`  ${m.file}`);
    lines.push(`    ${formatEnvDiff(m.envDiff)}`);
  }
}

/**
 * Render the diagnostic report as text.
 *
 * @param {import('./runner.js').IsolateReport} report
 * @returns {string}
 */
export function renderReport(report) {
  const lines = [];
  lines.push('');
  lines.push('=== test-isolate diagnostic report ===');
  lines.push(`Files scanned:  ${report.files.length}`);
  lines.push(`Wall duration:  ${(report.durationMs / 1000).toFixed(1)}s`);
  lines.push('');
  pushFlipperSection(lines, report);
  lines.push('');
  pushEnvSection(lines, report);
  lines.push('');
  return lines.join('\n');
}
