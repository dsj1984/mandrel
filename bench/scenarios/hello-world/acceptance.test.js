/**
 * FROZEN acceptance oracle — `hello-world` scenario (Story #4214).
 *
 * This suite is the objective Quality spine for the hello-world benchmark
 * scenario. It is **frozen**: it asserts only the delivered app's
 * user-visible HTTP behavior and depends on **nothing** from the app's
 * internals — no imports of the delivered source, no knowledge of its file
 * layout, framework, or storage. It probes a running instance over HTTP
 * exactly the way a user (or the harness) would. Because the contract is
 * fixed, the same oracle scores every run of every arm identically, which
 * is what makes the Mandrel-vs-control delta meaningful (Epic #4211).
 *
 * The suite has two faces:
 *
 *   1. {@link evaluate} — a pure async function the benchmark harness calls
 *      directly. Given the delivered app's base URL it runs every frozen
 *      assertion and returns a structured, deterministic result (one
 *      entry per acceptance criterion, in scenario-body order). The
 *      adapter (`bench/scenarios/acceptance-eval-adapter.js`) turns this
 *      into an acceptance-eval verdict and reports it alongside the
 *      cross-check.
 *   2. `node --test` `describe`/`it` cases — so the oracle can be run
 *      standalone against a live app (`BENCH_APP_BASE_URL=… node --test
 *      bench/scenarios/hello-world/acceptance.test.js`). When the base URL
 *      is not set the cases skip rather than fail, because there is no app
 *      to probe outside a benchmark run.
 *
 * @module bench/scenarios/hello-world/acceptance.test
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** Stable scenario identifier this oracle scores. */
export const SCENARIO_ID = 'hello-world';

/**
 * The frozen acceptance criteria, in the exact order they appear on the
 * scenario seed's `acceptance[]`. The text is kept in lock-step with
 * `scenario.json` so the verdict the adapter builds lines up criterion for
 * criterion.
 *
 * @type {ReadonlyArray<string>}
 */
export const CRITERIA = Object.freeze([
  'GET / returns HTTP 200',
  'The response Content-Type is text/html',
  'The response body contains the text "Hello, World!"',
]);

/**
 * The exact user-visible text the delivered page must contain. Frozen.
 *
 * @type {string}
 */
export const EXPECTED_BODY_TEXT = 'Hello, World!';

/**
 * Join a base URL and a path without producing a double slash.
 *
 * @param {string} baseUrl
 * @param {string} path
 * @returns {string}
 */
function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * Run the frozen hello-world oracle against a running app instance.
 *
 * Pure with respect to the app: it performs exactly one HTTP GET to `/`
 * and derives every criterion verdict from the user-visible response. It
 * never throws on an assertion failure — a failed probe becomes a
 * `met: false` criterion with concrete evidence, so the harness gets a
 * structured result for every run (including runs where the app never came
 * up).
 *
 * @param {string} baseUrl — base URL of the delivered app (e.g.
 *   `http://127.0.0.1:3000`).
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl] — injectable fetch (tests).
 * @returns {Promise<{
 *   scenario: string,
 *   passed: boolean,
 *   criteria: Array<{ index: number, criterion: string, met: boolean, evidence: string }>,
 * }>}
 */
export async function evaluate(baseUrl, { fetchImpl = fetch } = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new TypeError(
      'evaluate(baseUrl): baseUrl must be a non-empty string',
    );
  }

  const criteria = [];
  let status = null;
  let contentType = null;
  let bodyText = null;
  let transportError = null;

  try {
    const res = await fetchImpl(joinUrl(baseUrl, '/'), {
      method: 'GET',
      headers: { accept: 'text/html' },
    });
    status = res.status;
    contentType = res.headers.get('content-type');
    bodyText = await res.text();
  } catch (err) {
    transportError = err instanceof Error ? err.message : String(err);
  }

  // Criterion 0 — HTTP 200.
  criteria.push({
    index: 0,
    criterion: CRITERIA[0],
    met: status === 200,
    evidence: transportError
      ? `GET / failed at the transport layer: ${transportError}`
      : `GET / responded with HTTP ${status}`,
  });

  // Criterion 1 — Content-Type is text/html.
  const isHtml =
    typeof contentType === 'string' &&
    contentType.toLowerCase().includes('text/html');
  criteria.push({
    index: 1,
    criterion: CRITERIA[1],
    met: isHtml,
    evidence: transportError
      ? `no response received: ${transportError}`
      : `Content-Type header was ${JSON.stringify(contentType)}`,
  });

  // Criterion 2 — body contains the expected text.
  const containsText =
    typeof bodyText === 'string' && bodyText.includes(EXPECTED_BODY_TEXT);
  criteria.push({
    index: 2,
    criterion: CRITERIA[2],
    met: containsText,
    evidence: transportError
      ? `no body received: ${transportError}`
      : containsText
        ? `response body contained ${JSON.stringify(EXPECTED_BODY_TEXT)}`
        : `response body did not contain ${JSON.stringify(
            EXPECTED_BODY_TEXT,
          )} (received ${JSON.stringify((bodyText ?? '').slice(0, 120))})`,
  });

  return {
    scenario: SCENARIO_ID,
    passed: criteria.every((c) => c.met),
    criteria,
  };
}

// --- Standalone `node --test` face -------------------------------------
//
// Only runs against a live app the harness (or an operator) has already
// started and pointed at via BENCH_APP_BASE_URL. Outside a benchmark run
// there is no app to probe, so the cases skip rather than fail.

const BASE_URL = process.env.BENCH_APP_BASE_URL;

describe('hello-world frozen acceptance oracle', { skip: !BASE_URL }, () => {
  it('every frozen criterion is met by the delivered app', async () => {
    const result = await evaluate(/** @type {string} */ (BASE_URL));
    const failed = result.criteria.filter((c) => !c.met);
    assert.equal(
      failed.length,
      0,
      `unmet criteria: ${failed.map((c) => `${c.criterion} — ${c.evidence}`).join('; ')}`,
    );
    assert.equal(result.passed, true);
  });
});
