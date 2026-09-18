/**
 * Formats the check-baselines report for stdout.
 *
 * @module lib/orchestration/check-baselines/phases/report
 */

function formatHeader(report) {
  return (
    `[check-baselines] ${report.gates.length} gate(s) — ` +
    `breaches=${report.totalBreaches}, regressions=${report.totalRegressions ?? 0}, ` +
    `kernelDrift=${report.kernelDriftCount}, schemaErrors=${report.schemaErrors.length}`
  );
}

function formatGateStatus(g) {
  if (g.breachCount === 0 && (g.regressionCount ?? 0) === 0) return 'PASS';
  return `FAIL (breaches=${g.breachCount}, regressions=${g.regressionCount ?? 0})`;
}

function formatGateLine(g) {
  const status = formatGateStatus(g);
  const drift = g.kernelMatch
    ? ''
    : ` [kernel drift ${g.kernelBaseline} → ${g.kernelCurrent}]`;
  const baseRef = g.baseRef ? ` [baseRef=${g.baseRef}]` : '';
  // A compare that never ran would otherwise read as a clean run.
  const baseRead =
    g.baseRef && g.baseRead === false
      ? ' [baseRead=false — compare skipped]'
      : '';
  // `acknowledgedKeys` is always set alongside `acknowledged`.
  const ack = g.acknowledged
    ? ` [ACKNOWLEDGED ${g.acknowledgedKeys.length} row(s) — this run only]`
    : '';
  return `  - ${g.kind}: ${status}${drift}${baseRef}${baseRead}${ack}`;
}

function formatViolationLine(component, v) {
  const op = v.direction === 'gte' ? '<' : '>';
  return `    · ${component}.${v.axis}: ${v.value} ${op} floor ${v.floor}`;
}

function appendGateText(lines, g) {
  lines.push(formatGateLine(g));
  for (const c of g.components) {
    if (c.violations.length === 0) continue;
    for (const v of c.violations) {
      lines.push(formatViolationLine(c.component, v));
    }
  }
}

export function formatReport(report, format) {
  if (format === 'json') return JSON.stringify(report, null, 2);
  const lines = [formatHeader(report)];
  for (const g of report.gates) appendGateText(lines, g);
  for (const s of report.schemaErrors) {
    lines.push(`  ! schema error (${s.kind}): ${s.message}`);
  }
  return lines.join('\n');
}
