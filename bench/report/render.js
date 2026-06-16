// bench/report/render.js
//
// The operator-facing value-add report for the Mandrel self-benchmark harness
// (Epic #4211, Story #4218). Internal tooling only — never shipped in the
// distributed `.agents/` bundle, never run against the live repo.
//
// This module turns a corpus of per-run scorecards (one per scenario × arm ×
// run, conforming to bench/schemas/scorecard.schema.json) into a single
// Markdown report. It sits on top of the scoring slice
// (bench/score/differential.js) and the noise-band primitive
// (bench/metrics/variance.js); it adds NO new statistics of its own — every
// number it prints is sourced from those modules so the report is a faithful
// rendering of the measurement contract (bench/metrics/README.md), not a
// second, divergent interpretation of it.
//
// The report renders, in order:
//
//   1. A header stamped with the cohort (model, framework version, env) so a
//      reader only ever compares like-to-like.
//   2. Per-scenario, per-dimension DISTRIBUTIONS — each dimension reported as a
//      noise-band for BOTH arms (never a bare point estimate), plus the
//      Mandrel-vs-bare delta and its real/within-noise verdict against the
//      noise floor (README § "Real-delta rule").
//   3. The per-difficulty SCALING VIEW — Efficiency (totalTokens) and Overhead
//      ratio across the difficulty ladder for both arms, with any monotonicity
//      violation surfaced as an explicit calibration warning (never a silent
//      pass).
//   4. A clearly-delineated "Recommended improvements" section of actionable,
//      evidence-linked recommendations — including the overhead-floor estimate
//      and the ceremony-lite recommendation when a positive floor buys no
//      quality gain.
//
// Determinism: pure functions, no I/O, no clock, no randomness. The same corpus
// always renders byte-for-byte the same report, so a persisted report is
// reproducible and diffable across runs.

import { noiseBand } from '../metrics/variance.js';
import {
  EFFICIENCY_COMPONENTS,
  SCALAR_DIMENSIONS,
  scoreCorpus,
} from '../score/differential.js';

/** Difficulty ladder order (easy → hard). v1 ships two rungs. */
const DIFFICULTY_BY_SCENARIO = Object.freeze({
  'hello-world': 1,
  'crud-db': 2,
});

/**
 * Human-readable labels for the dimensions and efficiency components, used in
 * report headings. Keyed by the same `name` the scoring slice emits.
 */
const DIMENSION_LABELS = Object.freeze({
  quality: 'Quality',
  planningFidelity: 'Planning fidelity',
  autonomy: 'Autonomy',
  overheadRatio: 'Overhead ratio (tokens)',
  'efficiency.wallClockMs': 'Efficiency · wall-clock (ms)',
  'efficiency.totalTokens': 'Efficiency · total tokens',
  'efficiency.dispatches': 'Efficiency · dispatches',
  'efficiency.costUsd': 'Efficiency · cost (USD)',
});

/**
 * Round a finite number to a fixed precision for display, leaving non-finite /
 * null values as an em-dash. Never throws.
 *
 * @param {unknown} v
 * @param {number} [digits=3]
 * @returns {string}
 */
function fmt(v, digits = 3) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  // Avoid "-0" and trailing-zero noise while keeping integers clean.
  const rounded = Number(v.toFixed(digits));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/**
 * Render a noise-band as a compact `center [low, high]` cell, or an em-dash
 * when the band is null (the metric was null for that arm across all runs).
 *
 * @param {import('../metrics/variance.js').NoiseBand|null} band
 * @param {number} [digits=3]
 * @returns {string}
 */
function fmtBand(band, digits = 3) {
  if (!band) return '—';
  return `${fmt(band.center, digits)} [${fmt(band.low, digits)}, ${fmt(band.high, digits)}]`;
}

/**
 * Build a noise-band over one arm's per-run values for a given accessor, or
 * null when no finite values are present (so a dimension that is null for an
 * arm — planningFidelity on control — renders as an em-dash rather than
 * throwing). Mirrors the private helper in the scoring slice so the report's
 * per-arm distributions use the identical band the delta was computed from.
 *
 * @param {Array<object>} scorecards
 * @param {(d: object) => number|null} accessor
 * @param {'iqr'|'ci'} method
 * @returns {import('../metrics/variance.js').NoiseBand|null}
 */
function armBand(scorecards, accessor, method) {
  try {
    return noiseBand(
      scorecards.map((sc) => accessor(sc?.dimensions)),
      { method },
    );
  } catch {
    return null;
  }
}

/**
 * Group a flat list of scorecards into difficulty-ordered scenario cells, each
 * carrying the Mandrel and control arms separately. Scenarios are ordered by
 * the difficulty ladder; an unknown scenario sorts last (and is still
 * rendered, so an out-of-ladder scenario is never silently dropped).
 *
 * @param {Array<object>} scorecards
 * @returns {Array<{
 *   scenario: string,
 *   difficulty: number,
 *   mandrelRuns: Array<object>,
 *   controlRuns: Array<object>
 * }>}
 */
export function groupCells(scorecards) {
  if (!Array.isArray(scorecards)) {
    throw new TypeError('groupCells: scorecards must be an array');
  }
  const byScenario = new Map();
  for (const sc of scorecards) {
    const scenario = sc?.scenario;
    if (typeof scenario !== 'string') continue;
    if (!byScenario.has(scenario)) {
      byScenario.set(scenario, { mandrelRuns: [], controlRuns: [] });
    }
    const cell = byScenario.get(scenario);
    if (sc.arm === 'mandrel') cell.mandrelRuns.push(sc);
    else if (sc.arm === 'control') cell.controlRuns.push(sc);
  }

  const cells = [];
  for (const [scenario, arms] of byScenario) {
    cells.push({
      scenario,
      difficulty: DIFFICULTY_BY_SCENARIO[scenario] ?? Number.POSITIVE_INFINITY,
      mandrelRuns: arms.mandrelRuns,
      controlRuns: arms.controlRuns,
    });
  }
  cells.sort((a, b) => {
    if (a.difficulty !== b.difficulty) return a.difficulty - b.difficulty;
    return a.scenario.localeCompare(b.scenario);
  });
  return cells;
}

/**
 * Derive the cohort stamp (model, framework version, env) from the corpus. The
 * harness only ever compares like-to-like, so every scorecard in a corpus is
 * expected to share one cohort; if more than one distinct value is present for
 * a field, that is itself a finding — we record every distinct value and flag
 * the mix so the report never silently averages across cohorts.
 *
 * @param {Array<object>} scorecards
 * @returns {{
 *   models: string[],
 *   frameworkVersions: string[],
 *   nodes: string[],
 *   oses: string[],
 *   mixed: boolean
 * }}
 */
export function deriveCohort(scorecards) {
  const models = new Set();
  const frameworkVersions = new Set();
  const nodes = new Set();
  const oses = new Set();
  for (const sc of scorecards) {
    if (sc?.model?.id) models.add(sc.model.id);
    if (sc?.frameworkVersion) frameworkVersions.add(sc.frameworkVersion);
    if (sc?.env?.node) nodes.add(sc.env.node);
    if (sc?.env?.os) oses.add(sc.env.os);
  }
  const mixed =
    models.size > 1 ||
    frameworkVersions.size > 1 ||
    nodes.size > 1 ||
    oses.size > 1;
  return {
    models: [...models],
    frameworkVersions: [...frameworkVersions],
    nodes: [...nodes],
    oses: [...oses],
    mixed,
  };
}

/**
 * Render the cohort-stamp header block.
 *
 * @param {ReturnType<typeof deriveCohort>} cohort
 * @param {'iqr'|'ci'} method
 * @returns {string}
 */
function renderHeader(cohort, method) {
  const lines = [
    '# Mandrel Self-Benchmark — Value-Add Report',
    '',
    '> Internal tooling (Epic #4211). Each dimension is reported as a',
    '> distribution across N runs, never a point estimate. A Mandrel-vs-bare',
    '> delta is only called **real** when it clears the larger of the two arms’',
    '> noise-band spreads (see `bench/metrics/README.md` § Real-delta rule).',
    '',
    '## Cohort',
    '',
    `- **Model:** ${cohort.models.length ? cohort.models.join(', ') : '—'}`,
    `- **Framework version:** ${cohort.frameworkVersions.length ? cohort.frameworkVersions.join(', ') : '—'}`,
    `- **Node:** ${cohort.nodes.length ? cohort.nodes.join(', ') : '—'}`,
    `- **OS:** ${cohort.oses.length ? cohort.oses.join(', ') : '—'}`,
    `- **Band method:** ${method}`,
  ];
  if (cohort.mixed) {
    lines.push(
      '',
      '> ⚠️ **Mixed cohort:** this corpus mixes more than one',
      '> (model, framework version, env) — comparisons below are NOT',
      '> strictly like-to-like. Re-run within a single cohort for a clean',
      '> verdict.',
    );
  }
  return lines.join('\n');
}

/**
 * Build the per-arm distribution rows + the differential verdict for every
 * dimension of one scenario cell. Returns a structured object the renderer
 * formats into a table; separated so it is unit-testable independent of the
 * Markdown shape.
 *
 * @param {object} cell  A `groupCells` entry.
 * @param {ReturnType<typeof computeDifferential>} diff  The scenario's
 *   differential from `scoreCorpus`.
 * @param {'iqr'|'ci'} method
 * @returns {Array<{
 *   metric: string,
 *   label: string,
 *   mandrelBand: object|null,
 *   controlBand: object|null,
 *   delta: number|null,
 *   noiseFloor: number|null,
 *   verdict: 'real'|'within-noise'|'incomparable'
 * }>}
 */
export function dimensionRows(cell, diff, method) {
  const rows = [];
  for (const { name, accessor } of SCALAR_DIMENSIONS) {
    const cmp = diff.dimensions[name];
    rows.push({
      metric: name,
      label: DIMENSION_LABELS[name] ?? name,
      mandrelBand: armBand(cell.mandrelRuns, accessor, method),
      controlBand: armBand(cell.controlRuns, accessor, method),
      delta: cmp?.delta ?? null,
      noiseFloor: cmp?.noiseFloor ?? null,
      verdict: cmp?.verdict ?? 'incomparable',
    });
  }
  for (const { name, accessor } of EFFICIENCY_COMPONENTS) {
    const key = `efficiency.${name}`;
    const cmp = diff.efficiency[name];
    rows.push({
      metric: key,
      label: DIMENSION_LABELS[key] ?? key,
      mandrelBand: armBand(cell.mandrelRuns, accessor, method),
      controlBand: armBand(cell.controlRuns, accessor, method),
      delta: cmp?.delta ?? null,
      noiseFloor: cmp?.noiseFloor ?? null,
      verdict: cmp?.verdict ?? 'incomparable',
    });
  }
  return rows;
}

const VERDICT_BADGE = Object.freeze({
  real: '✅ real',
  'within-noise': '≈ within noise',
  incomparable: '— n/a',
});

/**
 * Render one scenario's distribution table (every dimension, both arms, delta
 * + verdict).
 *
 * @param {object} cell
 * @param {ReturnType<typeof computeDifferential>} diff
 * @param {'iqr'|'ci'} method
 * @returns {string}
 */
function renderScenarioSection(cell, diff, method) {
  const rows = dimensionRows(cell, diff, method);
  const header = [
    `### Scenario: \`${cell.scenario}\` (difficulty ${Number.isFinite(cell.difficulty) ? cell.difficulty : '?'})`,
    '',
    `n = ${cell.mandrelRuns.length} mandrel / ${cell.controlRuns.length} control · band = ${method} (\`center [low, high]\`)`,
    '',
    '| Dimension | Mandrel | Control | Δ (M−C) | Noise floor | Verdict |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  const body = rows.map((r) => {
    const digits = r.metric === 'efficiency.wallClockMs' ? 0 : 3;
    return `| ${r.label} | ${fmtBand(r.mandrelBand, digits)} | ${fmtBand(r.controlBand, digits)} | ${fmt(r.delta, digits)} | ${fmt(r.noiseFloor, digits)} | ${VERDICT_BADGE[r.verdict]} |`;
  });
  return [...header, ...body].join('\n');
}

/**
 * Render the per-difficulty scaling view: Efficiency (totalTokens) and Overhead
 * ratio (tokenRatio) across the difficulty ladder for BOTH arms, with the
 * monotonicity verdict and any calibration warnings surfaced explicitly.
 *
 * @param {Array<object>} cells  Difficulty-ordered scenario cells.
 * @param {ReturnType<typeof scoreCorpus>} corpus  The scored corpus.
 * @param {'iqr'|'ci'} method
 * @returns {string}
 */
export function renderScalingView(cells, corpus, method) {
  const tokenAcc = (d) => d?.efficiency?.totalTokens ?? null;
  const ratioAcc = (d) => d?.overheadRatio?.tokenRatio ?? null;

  const lines = [
    '## Per-difficulty scaling view',
    '',
    'As difficulty rises, Efficiency (absolute tokens) must **rise** and the',
    'Overhead ratio must **fall** as ceremony amortizes over more output. A',
    'violation is a calibration warning, not a silent pass.',
    '',
    '| Scenario | Difficulty | Tokens (mandrel) | Tokens (control) | Overhead ratio (mandrel) | Overhead ratio (control) |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const cell of cells) {
    const mTokens = armBand(cell.mandrelRuns, tokenAcc, method);
    const cTokens = armBand(cell.controlRuns, tokenAcc, method);
    const mRatio = armBand(cell.mandrelRuns, ratioAcc, method);
    const cRatio = armBand(cell.controlRuns, ratioAcc, method);
    lines.push(
      `| \`${cell.scenario}\` | ${Number.isFinite(cell.difficulty) ? cell.difficulty : '?'} | ${fmtBand(mTokens, 0)} | ${fmtBand(cTokens, 0)} | ${fmtBand(mRatio)} | ${fmtBand(cRatio)} |`,
    );
  }

  const mono = corpus.difficultyMonotonicity;
  lines.push('', '### Monotonicity (Mandrel arm, calibration guardrail)', '');
  if (mono.ordered.length < 2) {
    lines.push(
      '- Not enough ladder rungs to evaluate monotonicity (needs ≥ 2 scenarios).',
    );
  } else if (mono.monotonicityHolds) {
    lines.push(
      '- ✅ Monotonicity holds across every adjacent rung (efficiency rises, overhead ratio falls).',
    );
  } else {
    lines.push(
      '- ⚠️ **Calibration warning — monotonicity violated.** The instrument may be',
      '  insensitive or a scenario mis-graded for difficulty:',
    );
    for (const w of mono.warnings) {
      lines.push(`  - ${w}`);
    }
  }
  return lines.join('\n');
}

/**
 * Build the structured "Recommended improvements" findings list from the scored
 * corpus. Each finding is actionable and evidence-linked (it cites the metric
 * and the number that triggered it). Returned as data so the renderer formats
 * it and tests can assert on the findings without parsing Markdown.
 *
 * Findings, in priority order:
 *   1. Overhead floor with no quality gain → ceremony-lite path (the canonical
 *      README § "Overhead floor" recommendation). Always reports the floor
 *      estimate even when it does NOT trigger a recommendation, so the section
 *      surfaces the overhead-floor estimate unconditionally.
 *   2. Monotonicity violations → recalibrate the difficulty ladder / instrument.
 *   3. Per-scenario dimensions where the bare control arm beats Mandrel by a
 *      REAL margin on a value dimension (a regression the scaffolding should
 *      not be causing).
 *
 * @param {ReturnType<typeof scoreCorpus>} corpus
 * @returns {Array<{
 *   id: string,
 *   severity: 'high'|'medium'|'info',
 *   title: string,
 *   evidence: string,
 *   action: string
 * }>}
 */
export function recommendImprovements(corpus) {
  const findings = [];

  // 1. Overhead floor — always surfaced; recommendation fires conditionally.
  const floor = corpus.overheadFloor;
  if (floor) {
    const tok = floor.overheadFloorTokens;
    const usd = floor.overheadFloorUsd;
    const floorEvidence =
      `hello-world overhead floor ≈ ${fmt(tok, 0)} tokens` +
      (typeof usd === 'number' ? ` / $${fmt(usd, 4)}` : '') +
      ` above control (quality gain ${fmt(floor.qualityGain)})`;
    if (floor.recommendCeremonyLite) {
      findings.push({
        id: 'overhead-floor-ceremony-lite',
        severity: 'high',
        title: 'Add a ceremony-lite path for trivial scopes',
        evidence: `${floorEvidence} — a positive floor with no matching quality gain.`,
        action:
          'Gate the full /plan→/deliver ceremony behind a complexity threshold so ' +
          'trivial scopes skip the planning/decomposition tax that buys no quality here.',
      });
    } else {
      findings.push({
        id: 'overhead-floor-estimate',
        severity: 'info',
        title: 'Overhead-floor estimate (fixed ceremony tax on near-zero work)',
        evidence: floorEvidence,
        action:
          floor.noQualityGain === false && typeof floor.qualityGain === 'number'
            ? 'The floor is currently justified by a quality gain on hello-world; keep monitoring as the ladder grows.'
            : 'No actionable floor finding for this cohort; recorded for tracking.',
      });
    }
  }

  // 2. Monotonicity violations.
  const mono = corpus.difficultyMonotonicity;
  if (mono && !mono.monotonicityHolds && mono.ordered.length >= 2) {
    findings.push({
      id: 'monotonicity-violation',
      severity: 'high',
      title: 'Recalibrate the difficulty ladder or the instrument',
      evidence: mono.warnings.join('; '),
      action:
        'Efficiency did not rise and/or overhead ratio did not fall across the ' +
        'ladder. Re-grade the scenario difficulties or widen the gap between rungs ' +
        'so the instrument is sensitive to scaling.',
    });
  }

  // 3. Real regressions on a value dimension (control beats mandrel).
  //    Higher-is-better for quality/planningFidelity/autonomy ⇒ a positive
  //    (control − mandrel) gap that clears the noise floor is a regression.
  const valueDimensions = new Set(['quality', 'planningFidelity', 'autonomy']);
  for (const scenarioDiff of corpus.perScenario) {
    for (const name of valueDimensions) {
      const cmp = scenarioDiff.dimensions[name];
      if (!cmp?.comparable || !cmp.deltaIsReal) continue;
      // delta is (mandrel − control); a value dimension regresses when it is
      // negative AND real.
      if (cmp.delta < 0) {
        findings.push({
          id: `regression-${scenarioDiff.scenario}-${name}`,
          severity: 'medium',
          title: `Investigate the ${DIMENSION_LABELS[name] ?? name} regression on \`${scenarioDiff.scenario}\``,
          evidence: `Mandrel ${fmt(cmp.mandrelCenter)} vs control ${fmt(cmp.controlCenter)} (Δ ${fmt(cmp.delta)}, noise floor ${fmt(cmp.noiseFloor)}) — a real gap in the bare arm’s favour.`,
          action:
            'The scaffolding is costing a value dimension it should protect. ' +
            'Trace the lifecycle for this scenario to find where the regression enters.',
        });
      }
    }
  }

  return findings;
}

const SEVERITY_BADGE = Object.freeze({
  high: '🔴 High',
  medium: '🟠 Medium',
  info: '🔵 Info',
});

/**
 * Render the "Recommended improvements" section from the structured findings.
 *
 * @param {ReturnType<typeof recommendImprovements>} findings
 * @returns {string}
 */
function renderRecommendations(findings) {
  const lines = ['## Recommended improvements', ''];
  if (findings.length === 0) {
    lines.push(
      'No actionable findings for this cohort: no overhead-floor recommendation,',
      'no monotonicity violation, and no real value-dimension regression. The',
      'scaffolding is earning its tax at this frontier.',
    );
    return lines.join('\n');
  }
  for (const f of findings) {
    lines.push(
      `### ${SEVERITY_BADGE[f.severity] ?? f.severity} — ${f.title}`,
      '',
      `- **Evidence:** ${f.evidence}`,
      `- **Action:** ${f.action}`,
      '',
    );
  }
  // Drop the trailing blank line for a stable tail.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * Render the full value-add report from a corpus of per-run scorecards.
 *
 * @param {object} args
 * @param {Array<object>} args.scorecards  Flat list of scorecards (all
 *   scenarios × arms × runs) for ONE cohort.
 * @param {'iqr'|'ci'} [args.method='iqr']  Band method.
 * @returns {string}  The Markdown report.
 */
export function renderReport({ scorecards, method = 'iqr' } = {}) {
  if (!Array.isArray(scorecards)) {
    throw new TypeError('renderReport: scorecards must be an array');
  }

  const cohort = deriveCohort(scorecards);
  const cells = groupCells(scorecards);
  const corpus = scoreCorpus({
    cells: cells.map((c) => ({
      scenario: c.scenario,
      difficulty: c.difficulty,
      mandrelRuns: c.mandrelRuns,
      controlRuns: c.controlRuns,
    })),
    method,
  });

  const sections = [renderHeader(cohort, method), ''];

  sections.push('## Dimension distributions (Mandrel vs bare control)', '');
  if (cells.length === 0) {
    sections.push('No scorecards supplied — nothing to render.', '');
  } else {
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i];
      const diff = corpus.perScenario[i];
      sections.push(renderScenarioSection(cell, diff, method), '');
    }
  }

  sections.push(renderScalingView(cells, corpus, method), '');

  const findings = recommendImprovements(corpus);
  sections.push(renderRecommendations(findings));

  return `${sections
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

/**
 * Convenience structured form of the report (the same data the Markdown is
 * rendered from) for callers that want to consume the findings programmatically
 * rather than parse the Markdown. Pure; shares the corpus computation.
 *
 * @param {object} args
 * @param {Array<object>} args.scorecards
 * @param {'iqr'|'ci'} [args.method='iqr']
 * @returns {{
 *   cohort: ReturnType<typeof deriveCohort>,
 *   method: 'iqr'|'ci',
 *   scenarios: Array<{ scenario: string, difficulty: number, rows: ReturnType<typeof dimensionRows> }>,
 *   monotonicity: ReturnType<typeof scoreCorpus>['difficultyMonotonicity'],
 *   overheadFloor: ReturnType<typeof scoreCorpus>['overheadFloor'],
 *   recommendations: ReturnType<typeof recommendImprovements>
 * }}
 */
export function buildReportModel({ scorecards, method = 'iqr' } = {}) {
  if (!Array.isArray(scorecards)) {
    throw new TypeError('buildReportModel: scorecards must be an array');
  }
  const cohort = deriveCohort(scorecards);
  const cells = groupCells(scorecards);
  const corpus = scoreCorpus({
    cells: cells.map((c) => ({
      scenario: c.scenario,
      difficulty: c.difficulty,
      mandrelRuns: c.mandrelRuns,
      controlRuns: c.controlRuns,
    })),
    method,
  });
  return {
    cohort,
    method,
    scenarios: cells.map((cell, i) => ({
      scenario: cell.scenario,
      difficulty: cell.difficulty,
      rows: dimensionRows(cell, corpus.perScenario[i], method),
    })),
    monotonicity: corpus.difficultyMonotonicity,
    overheadFloor: corpus.overheadFloor,
    recommendations: recommendImprovements(corpus),
  };
}
