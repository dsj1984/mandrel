/**
 * acceptance-eval-adapter.js — bridge a scenario's FROZEN acceptance oracle
 * to Mandrel's existing acceptance-eval cross-check (Story #4214).
 *
 * The benchmark's Quality dimension is scored two ways (Epic #4211):
 *
 *   1. The **frozen acceptance suite** is the objective spine — a fixed,
 *      deterministic oracle that probes the delivered app's user-visible
 *      HTTP behavior and returns one verdict per acceptance criterion
 *      (`bench/scenarios/<id>/acceptance.test.js#evaluate`).
 *   2. The **acceptance-eval cross-check** is the LLM-judge second opinion
 *      — the in-repo gate at `.agents/scripts/acceptance-eval.js`, whose
 *      verdict shape is fixed by
 *      `.agents/schemas/acceptance-eval-verdict.schema.json`.
 *
 * This adapter runs the frozen suite, lifts its per-criterion pass/fail
 * into a schema-valid acceptance-eval verdict, feeds that verdict through
 * the **existing** cross-check, and returns the cross-check decision
 * **alongside** the frozen-suite result in one combined object. It owns no
 * scoring policy of its own — the frozen suite owns the assertions and
 * `acceptance-eval.js` owns the proceed/redraft/block decision; the adapter
 * is pure plumbing between them.
 *
 * Two cross-check transports are supported, selected by the caller:
 *
 *   - **in-process** (default): import and call the gate's `runAcceptanceEval`
 *     export directly. Fast, no child process, signal-emit suppressed by
 *     default so a benchmark probe never writes to a live signals ledger.
 *   - **CLI**: spawn `node .agents/scripts/acceptance-eval.js --verdict …`
 *     exactly as a Story-delivery run would, parsing its JSON envelope.
 *     Used when the cross-check must run against another checkout's gate
 *     (e.g. the sandbox clone) rather than this process's import graph.
 *
 * @module bench/scenarios/acceptance-eval-adapter
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The cross-check decision lives on the gate module; `runAcceptanceEval`
// is the programmatic (no-process) entry point the CLI also wraps.
import { runAcceptanceEval as runGate } from '../../.agents/scripts/acceptance-eval.js';
import { resolveConfig } from '../../.agents/scripts/lib/config-resolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the in-repo acceptance-eval CLI. */
export const ACCEPTANCE_EVAL_CLI = path.resolve(
  __dirname,
  '..',
  '..',
  '.agents',
  'scripts',
  'acceptance-eval.js',
);

/**
 * Lift a frozen-suite result into an acceptance-eval verdict object that
 * conforms to `acceptance-eval-verdict.schema.json`. A frozen criterion
 * that the oracle marked `met` becomes verdict `met`; a failed one becomes
 * `unmet`, with the oracle's evidence string carried through verbatim so
 * the cross-check (and any signal it emits) can see *why*.
 *
 * @param {object} args
 * @param {{ criteria: Array<{ index: number, criterion: string, met: boolean, evidence: string }> }} args.frozenResult
 * @param {number} args.storyId
 * @param {number | null} [args.epicId]
 * @param {number} [args.round] — defaults to 1 (a single frozen probe).
 * @param {string | null} [args.commitSha]
 * @returns {object} A verdict object (schema-valid when the frozen result
 *   carries at least one criterion).
 */
export function buildVerdictFromFrozenResult({
  frozenResult,
  storyId,
  epicId = null,
  round = 1,
  commitSha = null,
}) {
  if (!frozenResult || !Array.isArray(frozenResult.criteria)) {
    throw new TypeError(
      'buildVerdictFromFrozenResult: frozenResult.criteria must be an array',
    );
  }
  if (!Number.isInteger(storyId) || storyId < 1) {
    throw new TypeError(
      'buildVerdictFromFrozenResult: storyId must be a positive integer',
    );
  }

  const verdict = {
    storyId,
    epicId: epicId ?? null,
    schemaVersion: 1,
    round: Number.isInteger(round) && round >= 1 ? round : 1,
    criteria: frozenResult.criteria.map((c) => ({
      index: c.index,
      criterion: c.criterion,
      verdict: c.met ? 'met' : 'unmet',
      evidence:
        c.evidence || (c.met ? 'frozen oracle: met' : 'frozen oracle: unmet'),
      verifyEvidence: [
        {
          command: 'frozen acceptance oracle (HTTP probe of delivered app)',
          outcome: c.met ? 'pass' : 'fail',
          detail: c.evidence ?? null,
        },
      ],
    })),
  };
  if (commitSha) verdict.commitSha = commitSha;
  return verdict;
}

/**
 * Run the acceptance-eval cross-check **in-process** against a verdict.
 *
 * @param {object} args
 * @param {object} args.verdict — a schema-valid verdict object.
 * @param {number} args.storyId
 * @param {number | null} [args.epicId]
 * @param {object} [args.config] — resolved `.agentrc.json`; defaults to
 *   `resolveConfig()` (built-in defaults are fine — the gate only needs
 *   `delivery.acceptanceEval.maxRounds`).
 * @param {boolean} [args.emitSignal] — default `false`; a benchmark probe
 *   must not pollute a live signals ledger.
 * @param {number} [args.round] — explicit round override forwarded to the
 *   gate (defaults to the verdict's `round`).
 * @param {object} [deps]
 * @param {typeof runGate} [deps.runGateFn] — injectable gate (tests).
 * @returns {Promise<{ decision: string, envelope: object, exitCode: number }>}
 */
export async function runCrossCheckInProcess({
  verdict,
  storyId,
  epicId = null,
  config,
  emitSignal = false,
  round,
  ...deps
}) {
  const runGateFn = deps.runGateFn ?? runGate;
  const resolved = config ?? resolveConfig();
  const { envelope, exitCode } = await runGateFn({
    storyId,
    epicId: epicId ?? null,
    verdict,
    config: resolved,
    emitSignal,
    round: round ?? verdict.round,
  });
  return { decision: envelope.decision, envelope, exitCode };
}

/**
 * Run the acceptance-eval cross-check via the **CLI**, writing the verdict
 * to a temp file and spawning `node acceptance-eval.js --verdict …`. The
 * `--no-signal` flag is always passed so a benchmark probe is side-effect
 * free. Parses the gate's JSON envelope from stdout.
 *
 * @param {object} args
 * @param {object} args.verdict — a schema-valid verdict object.
 * @param {number} args.storyId
 * @param {number | null} [args.epicId]
 * @param {string} [args.cli] — path to the acceptance-eval CLI (defaults
 *   to the in-repo one; pass a sandbox clone's path to cross-check there).
 * @param {object} [deps]
 * @param {typeof spawnSync} [deps.spawnFn] — injectable spawn (tests).
 * @returns {{ decision: string, envelope: object, exitCode: number }}
 */
export function runCrossCheckViaCli({
  verdict,
  storyId,
  epicId = null,
  cli = ACCEPTANCE_EVAL_CLI,
  ...deps
}) {
  const spawnFn = deps.spawnFn ?? spawnSync;
  const dir = mkdtempSync(path.join(tmpdir(), 'bench-accept-eval-'));
  const verdictPath = path.join(dir, 'verdict.json');
  try {
    writeFileSync(verdictPath, JSON.stringify(verdict), 'utf8');
    const args = [
      cli,
      '--story',
      String(storyId),
      '--verdict',
      verdictPath,
      '--no-signal',
    ];
    if (Number.isInteger(epicId) && epicId !== null) {
      args.push('--epic', String(epicId));
    }
    const result = spawnFn(process.execPath, args, { encoding: 'utf8' });
    const envelope = parseGateEnvelope(result.stdout ?? '');
    return {
      decision: envelope?.decision ?? null,
      envelope,
      exitCode: typeof result.status === 'number' ? result.status : 1,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Extract the gate's JSON envelope from a stdout blob. The CLI prints the
 * envelope via `Logger.info(JSON.stringify(envelope, null, 2))`, possibly
 * preceded by log lines, so scan for the last balanced JSON object.
 *
 * @param {string} stdout
 * @returns {object | null}
 */
export function parseGateEnvelope(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  // The pretty-printed envelope is the final top-level JSON object. Find
  // the last line that starts an object and parse from there.
  const start = stdout.lastIndexOf('\n{');
  const candidate = start >= 0 ? stdout.slice(start + 1) : stdout;
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to a forgiving scan: the first `{` to the matching final
    // `}` in the whole blob.
    const open = stdout.indexOf('{');
    const close = stdout.lastIndexOf('}');
    if (open >= 0 && close > open) {
      try {
        return JSON.parse(stdout.slice(open, close + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Score a scenario's Quality: run the FROZEN acceptance oracle against the
 * delivered app, then run the existing acceptance-eval cross-check over the
 * verdict the oracle produced, and return both.
 *
 * This is the function the benchmark harness calls per `(scenario × arm ×
 * run)` to obtain the Quality signal.
 *
 * @param {object} args
 * @param {(baseUrl: string, deps?: object) => Promise<{ scenario: string, passed: boolean, criteria: Array<object> }>} args.evaluate
 *   — the scenario's frozen oracle `evaluate` export.
 * @param {string} args.baseUrl — base URL of the delivered app.
 * @param {number} args.storyId
 * @param {number | null} [args.epicId]
 * @param {'in-process' | 'cli'} [args.transport] — cross-check transport
 *   (default `'in-process'`).
 * @param {string | null} [args.commitSha]
 * @param {object} [args.config] — resolved config for the in-process path.
 * @param {object} [args.evaluateDeps] — forwarded to the frozen oracle
 *   (e.g. `{ fetchImpl }`).
 * @param {object} [deps] — cross-check injection (`runGateFn`, `spawnFn`,
 *   `cli`).
 * @returns {Promise<{
 *   scenario: string,
 *   frozen: { passed: boolean, criteria: Array<object> },
 *   crossCheck: { decision: string, envelope: object, exitCode: number },
 *   agree: boolean,
 * }>}
 */
export async function scoreScenarioQuality({
  evaluate,
  baseUrl,
  storyId,
  epicId = null,
  transport = 'in-process',
  commitSha = null,
  config,
  evaluateDeps = {},
  ...deps
}) {
  if (typeof evaluate !== 'function') {
    throw new TypeError('scoreScenarioQuality: evaluate must be a function');
  }
  const frozenResult = await evaluate(baseUrl, evaluateDeps);
  const verdict = buildVerdictFromFrozenResult({
    frozenResult,
    storyId,
    epicId,
    commitSha,
  });

  const crossCheck =
    transport === 'cli'
      ? runCrossCheckViaCli({
          verdict,
          storyId,
          epicId,
          cli: deps.cli,
          spawnFn: deps.spawnFn,
        })
      : await runCrossCheckInProcess({
          verdict,
          storyId,
          epicId,
          config,
          runGateFn: deps.runGateFn,
        });

  // The two oracles "agree" when the frozen pass/fail and the cross-check
  // decision point the same way: a fully-passing frozen suite should yield
  // a `proceed` cross-check; any frozen failure should not.
  const agree = frozenResult.passed === (crossCheck.decision === 'proceed');

  return {
    scenario: frozenResult.scenario,
    frozen: { passed: frozenResult.passed, criteria: frozenResult.criteria },
    crossCheck,
    agree,
  };
}
