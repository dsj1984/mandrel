/**
 * Wave-checkpoint reducers — pure functions that read the
 * `epic-run-state` checkpoint payload and the per-wave outcome maps.
 *
 * These two helpers historically lived inside the iterate-waves phase
 * (`lib/orchestration/epic-runner/phases/iterate-waves.js`) but are
 * consumed by both the phase and the stateless wave-runner `tick.js`.
 * Hosting them here severs the planner→phase import coupling: `tick.js`
 * no longer reaches up into the epic-runner phase tree just to derive a
 * force-fresh set, and the phase imports them back from this neutral
 * module.
 *
 * Both functions are pure: they read their argument and return a value
 * without I/O, so they can be unit-tested in isolation.
 *
 * @module lib/wave-runner/wave-checkpoint
 */

/**
 * Pull the set of Story IDs that the prior checkpoint marked as part of
 * a halted wave. Story #1795 — used by the resume-check cache pre-warm:
 * Stories appearing in this set are force-fresh-fetched on resume (the
 * operator may have hand-edited their labels during the blocker
 * window); every other Story serves its resume-check from the
 * provider's in-process cache.
 *
 * Tolerant of partial/legacy checkpoint shapes: a missing or
 * unparseable checkpoint returns an empty set so the resume-check
 * gracefully degrades to "use cache for all" — the existing
 * cold-start fallback inside `getTicket` still issues the real fetch.
 *
 * @param {object | null | undefined} checkpoint
 * @returns {Set<number>}
 */
export function collectHaltedStoryIds(checkpoint) {
  const halted = new Set();
  const waves = checkpoint?.waves;
  if (!Array.isArray(waves)) return halted;
  for (const wave of waves) {
    if (wave?.status !== 'halted') continue;
    const stories = Array.isArray(wave.stories) ? wave.stories : [];
    for (const story of stories) {
      const id =
        story?.storyId ??
        story?.id ??
        (typeof story === 'number' ? story : null);
      if (Number.isInteger(id) && id > 0) halted.add(id);
    }
  }
  return halted;
}

/**
 * Cross-event invariant guard for `wave.end` (Acceptance Spec AC-8 /
 * Repeatability AC #5 — wave completeness).
 *
 * The schema layer can declare key/value types for `outcomes` but
 * cannot enforce that the key set equals the `wave.start.storyIds` set
 * from earlier in the run. We enforce it here, before emit, so a
 * violation throws synchronously and the ledger never carries a
 * non-conformant record.
 *
 * Throws a typed `Error` with `code: 'WAVE_COMPLETENESS_VIOLATION'` and
 * attached diagnostic fields so tests and operators can reason about
 * the mismatch without grepping the message.
 *
 * @param {{ waveIndex: number, storyIds: number[], outcomes: Record<string, string> }} args
 */
export function assertWaveCompleteness({ waveIndex, storyIds, outcomes }) {
  const expected = new Set(storyIds);
  const actual = new Set(
    Object.keys(outcomes ?? {})
      .map((k) => Number(k))
      .filter((n) => Number.isInteger(n)),
  );
  const missing = [...expected].filter((id) => !actual.has(id));
  const extra = [...actual].filter((id) => !expected.has(id));
  if (missing.length === 0 && extra.length === 0) return;
  const err = new Error(
    `wave-completeness violation for wave #${waveIndex}: ${
      missing.length ? `missing outcomes for [${missing.join(', ')}]` : ''
    }${missing.length && extra.length ? '; ' : ''}${
      extra.length ? `extra outcomes for [${extra.join(', ')}]` : ''
    }`,
  );
  err.code = 'WAVE_COMPLETENESS_VIOLATION';
  err.waveIndex = waveIndex;
  err.missing = missing;
  err.extra = extra;
  throw err;
}
