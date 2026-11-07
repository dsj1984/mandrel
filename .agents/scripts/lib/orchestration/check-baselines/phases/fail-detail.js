/**
 * The lines a FAIL kind prints under its status: the diff-scoped remedy and
 * the surviving regression rows. Never a full-scope or reanchor command.
 *
 * @module lib/orchestration/check-baselines/phases/fail-detail
 */

const MAX_REGRESSION_LINES = 20;
const SCRIPTS = 'node .agents/scripts';
const CAPTURE = `${SCRIPTS}/coverage-capture.js`;

/** Diff-scoped updaters; coverage and crap re-score a fresh capture first. */
const UPDATERS = Object.freeze({
  coverage: { script: 'update-coverage-baseline.js', capture: true },
  crap: { script: 'update-crap-baseline.js', capture: true },
  duplication: { script: 'update-duplication-baseline.js' },
  maintainability: { script: 'update-maintainability-baseline.js' },
});

/** The command that re-scores a kind's rows, or `null` for an unknown kind. */
function remedyCommand(g) {
  if (g.kind === 'mutation') {
    return "re-running the project's own mutation run (Mandrel ships no updater)";
  }
  if (g.kind === 'bundle-size') {
    return `\`${SCRIPTS}/update-bundle-size-baseline.js\``;
  }
  const updater = UPDATERS[g.kind];
  if (!updater) return null;
  const scope = g.baseRef ? ` --diff-scope ${g.baseRef}` : '';
  const cmd = `\`${SCRIPTS}/${updater.script}${scope}\``;
  return updater.capture ? `\`${CAPTURE}\` then ${cmd}` : cmd;
}

function formatRemedyLine(g) {
  const cmd = remedyCommand(g);
  if (!cmd) return [];
  return [
    `    ↳ remedy: fix the named rows, re-score with ${cmd}, commit; a deliberate rise commits as \`baseline-refresh:\``,
  ];
}

const fmt = (n) => String(Number(n.toFixed(2)));

/** `<field> <base> → <head>` per numeric field that moved; `(new)` without a base. */
function formatRegressionLine({ key, head, base }) {
  const numeric = Object.entries(head ?? {}).filter(
    ([, v]) => typeof v === 'number',
  );
  if (!base) {
    const fields = numeric.map(([f, v]) => `${f} ${fmt(v)}`).join(', ');
    return `    · ${key}: (new) → ${fields}`;
  }
  const moved = numeric
    .filter(([f, v]) => typeof base[f] === 'number' && base[f] !== v)
    .map(([f, v]) => `${f} ${fmt(base[f])} → ${fmt(v)}`);
  return `    · ${key}: ${moved.join(', ')}`;
}

function formatRegressionLines(g) {
  if (!Array.isArray(g.regressions)) return [];
  const lines = g.regressions
    .slice(0, MAX_REGRESSION_LINES)
    .map(formatRegressionLine);
  const more = g.regressions.length - MAX_REGRESSION_LINES;
  if (more > 0) {
    lines.push(
      `    · … and ${more} more — ${SCRIPTS}/check-baselines.js --gate ${g.kind} --format json`,
    );
  }
  return lines;
}

/**
 * A FAIL kind's lines: remedy first (a capped quote keeps it), then the
 * floor violations, then the surviving regression rows.
 *
 * @param {object} g - one gate report.
 * @param {string[]} violations - its formatted floor-violation lines.
 * @returns {string[]}
 */
export function formatFailDetail(g, violations) {
  return [...formatRemedyLine(g), ...violations, ...formatRegressionLines(g)];
}
