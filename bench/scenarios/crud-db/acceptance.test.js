/**
 * FROZEN acceptance oracle — `crud-db` scenario (Story #4214).
 *
 * The objective Quality spine for the CRUD+DB benchmark scenario. Like the
 * hello-world oracle it is **frozen**: it exercises only the delivered
 * app's user-visible HTTP contract (the notes REST surface) and imports
 * nothing from the delivered source — it has no knowledge of the app's
 * storage engine, routing, or file layout. It drives a full create → read
 * → update → delete round-trip over HTTP and derives one verdict per
 * acceptance criterion, so the same oracle scores every run of every arm
 * identically (Epic #4211).
 *
 * Determinism notes:
 *   - Created notes carry a unique, run-stamped title so the GET-list
 *     assertion never collides with notes left by a prior run against a
 *     reused store.
 *   - The round-trip is sequential and self-contained; no criterion
 *     depends on wall-clock timing or external state beyond the resource
 *     it just created.
 *
 * Two faces, mirroring the hello-world oracle: a pure {@link evaluate}
 * the harness calls directly, and skip-unless-`BENCH_APP_BASE_URL`
 * `node --test` cases for standalone runs against a live app.
 *
 * @module bench/scenarios/crud-db/acceptance.test
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** Stable scenario identifier this oracle scores. */
export const SCENARIO_ID = 'crud-db';

/**
 * Frozen acceptance criteria, in scenario-seed order.
 *
 * @type {ReadonlyArray<string>}
 */
export const CRITERIA = Object.freeze([
  'POST /notes with a valid body creates a note and returns 201 with the created note (including a server-assigned id) as JSON',
  'GET /notes returns 200 with a JSON array containing previously created notes',
  'GET /notes/:id returns the matching note, and 404 for an unknown id',
  'PUT /notes/:id updates the persisted note and returns the updated representation',
  'DELETE /notes/:id removes the note (returns 204) and a subsequent GET for that id returns 404',
  'POST /notes with an invalid body (missing or empty title/body) returns 400',
]);

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
 * A small result accumulator that records one criterion verdict and keeps
 * the criteria in scenario order regardless of probe ordering.
 */
class CriteriaLedger {
  constructor() {
    /** @type {Map<number, { index: number, criterion: string, met: boolean, evidence: string }>} */
    this.byIndex = new Map();
  }

  /**
   * @param {number} index
   * @param {boolean} met
   * @param {string} evidence
   */
  record(index, met, evidence) {
    this.byIndex.set(index, {
      index,
      criterion: CRITERIA[index],
      met: Boolean(met),
      evidence,
    });
  }

  /**
   * Any criterion never explicitly recorded (e.g. a probe threw before it
   * could run) is reported as unmet with the supplied reason, so the
   * harness always receives a complete, ordered criteria list.
   *
   * @param {string} reason
   * @returns {Array<{ index: number, criterion: string, met: boolean, evidence: string }>}
   */
  finalize(reason) {
    const out = [];
    for (let i = 0; i < CRITERIA.length; i += 1) {
      out.push(
        this.byIndex.get(i) ?? {
          index: i,
          criterion: CRITERIA[i],
          met: false,
          evidence: reason,
        },
      );
    }
    return out;
  }
}

/**
 * Best-effort JSON parse that never throws.
 *
 * @param {Response} res
 * @returns {Promise<unknown>}
 */
async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * Run the frozen CRUD+DB oracle against a running app instance.
 *
 * Performs a sequential create → list → read → update → delete round-trip
 * plus an invalid-payload probe. Never throws on an assertion failure: a
 * failed or unreachable endpoint becomes a `met: false` criterion with
 * concrete evidence.
 *
 * @param {string} baseUrl — base URL of the delivered app.
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl] — injectable fetch (tests).
 * @param {() => string} [deps.uniqueSuffix] — injectable unique-title
 *   source (tests); defaults to a timestamp+random token.
 * @returns {Promise<{
 *   scenario: string,
 *   passed: boolean,
 *   criteria: Array<{ index: number, criterion: string, met: boolean, evidence: string }>,
 * }>}
 */
export async function evaluate(
  baseUrl,
  {
    fetchImpl = fetch,
    uniqueSuffix = () =>
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  } = {},
) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new TypeError(
      'evaluate(baseUrl): baseUrl must be a non-empty string',
    );
  }

  const ledger = new CriteriaLedger();
  const title = `bench-note-${uniqueSuffix()}`;
  const notesUrl = joinUrl(baseUrl, '/notes');

  const json = (body) => ({
    method: undefined,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });

  try {
    // --- Criterion 0 — POST /notes (valid) → 201 + created note ---------
    let createdId;
    {
      const res = await fetchImpl(notesUrl, {
        ...json({ title, body: 'first body' }),
        method: 'POST',
      });
      const payload = await safeJson(res);
      const hasId =
        payload != null &&
        typeof payload === 'object' &&
        'id' in payload &&
        payload.id !== undefined &&
        payload.id !== null;
      const met = res.status === 201 && hasId;
      if (hasId) createdId = payload.id;
      ledger.record(
        0,
        met,
        `POST /notes → HTTP ${res.status}; created note id=${
          hasId ? JSON.stringify(payload.id) : '(missing)'
        }`,
      );
    }

    // --- Criterion 1 — GET /notes → 200 array containing the note -------
    {
      const res = await fetchImpl(notesUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      const payload = await safeJson(res);
      const isArray = Array.isArray(payload);
      const contains =
        isArray &&
        payload.some(
          (n) => n != null && typeof n === 'object' && n.title === title,
        );
      ledger.record(
        1,
        res.status === 200 && contains,
        `GET /notes → HTTP ${res.status}; array=${isArray}; contains created title=${contains}`,
      );
    }

    // --- Criterion 2 — GET /notes/:id (hit) + unknown id → 404 ----------
    {
      let hitOk = false;
      let hitEvidence = 'no note id was created, so the read probe was skipped';
      if (createdId !== undefined) {
        const res = await fetchImpl(
          joinUrl(baseUrl, `/notes/${encodeURIComponent(String(createdId))}`),
          { method: 'GET', headers: { accept: 'application/json' } },
        );
        const payload = await safeJson(res);
        hitOk =
          res.status === 200 &&
          payload != null &&
          typeof payload === 'object' &&
          payload.title === title;
        hitEvidence = `GET /notes/${createdId} → HTTP ${res.status}`;
      }
      const missRes = await fetchImpl(
        joinUrl(baseUrl, '/notes/00000000-0000-0000-0000-000000000000'),
        { method: 'GET', headers: { accept: 'application/json' } },
      );
      const missOk = missRes.status === 404;
      ledger.record(
        2,
        hitOk && missOk,
        `${hitEvidence}; GET unknown id → HTTP ${missRes.status} (expected 404)`,
      );
    }
    if (createdId === undefined) {
      ledger.record(
        3,
        false,
        'no note id was created, so the update probe was skipped',
      );
    } else {
      const res = await fetchImpl(
        joinUrl(baseUrl, `/notes/${encodeURIComponent(String(createdId))}`),
        { ...json({ title, body: 'updated body' }), method: 'PUT' },
      );
      const payload = await safeJson(res);
      const updated =
        res.status === 200 &&
        payload != null &&
        typeof payload === 'object' &&
        payload.body === 'updated body';
      ledger.record(
        3,
        updated,
        `PUT /notes/${createdId} → HTTP ${res.status}; body reflected updated value=${updated}`,
      );
    }
    if (createdId === undefined) {
      ledger.record(
        4,
        false,
        'no note id was created, so the delete probe was skipped',
      );
    } else {
      const delRes = await fetchImpl(
        joinUrl(baseUrl, `/notes/${encodeURIComponent(String(createdId))}`),
        { method: 'DELETE' },
      );
      const afterRes = await fetchImpl(
        joinUrl(baseUrl, `/notes/${encodeURIComponent(String(createdId))}`),
        { method: 'GET', headers: { accept: 'application/json' } },
      );
      ledger.record(
        4,
        delRes.status === 204 && afterRes.status === 404,
        `DELETE /notes/${createdId} → HTTP ${delRes.status} (expected 204); subsequent GET → HTTP ${afterRes.status} (expected 404)`,
      );
    }

    // --- Criterion 5 — POST /notes (invalid) → 400 ----------------------
    {
      const res = await fetchImpl(notesUrl, {
        ...json({ title: '', body: '' }),
        method: 'POST',
      });
      ledger.record(
        5,
        res.status === 400,
        `POST /notes with empty title/body → HTTP ${res.status} (expected 400)`,
      );
    }
  } catch (err) {
    const reason = `frozen oracle aborted: ${
      err instanceof Error ? err.message : String(err)
    }`;
    const criteria = ledger.finalize(reason);
    return { scenario: SCENARIO_ID, passed: false, criteria };
  }

  const criteria = ledger.finalize('criterion probe did not run');
  return {
    scenario: SCENARIO_ID,
    passed: criteria.every((c) => c.met),
    criteria,
  };
}

// --- Standalone `node --test` face -------------------------------------

const BASE_URL = process.env.BENCH_APP_BASE_URL;

describe('crud-db frozen acceptance oracle', { skip: !BASE_URL }, () => {
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
