/**
 * GitHub Provider — LabelGateway.
 *
 * Owns `ensureLabels` (idempotent label create) plus the live-set
 * reconciliation helper (`_reconcileLabelsPresence` /
 * `_normalizeLabelListResult`). `gh label create` is the canonical CLI
 * surface for label creation; this gateway swallows the "already exists"
 * signal across all three surfaces (CLI stderr, API 422 body, legacy test
 * mock) so re-runs are idempotent.
 *
 * Extracted from `../github.js` in Story #2462 / Task #2478. Public
 * surface on `GitHubProvider` is unchanged — `ensureLabels`,
 * `_reconcileLabelsPresence`, and `_normalizeLabelListResult` all
 * delegate here.
 *
 * @see Story #2462 — Split GitHubProvider god class into seven composed gateways.
 */

import { withTransientRetry } from './transient-retry.js';

/**
 * Detect the "label already exists" signal across the surfaces `gh label
 * create` can emit it on. The CLI prints
 *
 *   `! Label "<name>" already exists`
 *
 * to stderr and exits non-zero; the underlying API surfaces a 422 with
 * `errors[].code === 'already_exists'`. The test mock throws
 * `Error('... code 422')`. Match all three — but require the patterns to
 * be **anchored to the label-create lexicon** so unrelated stderr lines
 * that happen to mention "already exists" don't get misclassified as
 * idempotent skips and let real creation failures look successful.
 *
 * Story #2018 (Bug 2) tightened the regexes after a fresh-repo bootstrap
 * counted 23 labels as "skipped" when none were actually created.
 */
export function isLabelAlreadyExistsError(err) {
  if (!err) return false;
  const message = err?.message ?? '';
  const stderr = err?.stderr ?? '';
  // CLI shapes (vary by gh version):
  //   `! Label "<name>" already exists`
  //   `label with name "<name>" already exists; use ` + '`--force`' + ` ...`
  // Require both the "label" lexicon and the "already exists" signal (with
  // anything in between) so unrelated errors are not misclassified as skips.
  if (/label\b[\s\S]*?already exists/i.test(stderr)) return true;
  if (/label\b[\s\S]*?already exists/i.test(message)) return true;
  // REST API shape: 422 + `already_exists` code in the error body.
  if (/already_exists/i.test(stderr) || /already_exists/i.test(message)) {
    return true;
  }
  // Test-mock legacy shape: `Error('... code 422 ...')` combined with the
  // word "already exists" anywhere in the message.
  if (
    /\bcode\s+422\b/i.test(message) &&
    /already exists/i.test(message + stderr)
  ) {
    return true;
  }
  return false;
}

export class LabelGateway {
  /**
   * @param {{ gh: object, owner: string, repo: string }} deps
   */
  constructor({ gh, owner, repo } = {}) {
    this._gh = gh;
    this.owner = owner;
    this.repo = repo;
  }

  /**
   * Idempotent label creation. For each labelDef, attempt `gh label create
   * <name> --color <hex> --description <text>`. The CLI prints
   * "label already exists" (or the API surfaces a 422 "already_exists"
   * error) when the name is taken; we swallow that and count it as
   * `skipped`. Any other error propagates so transport faults stay loud.
   *
   * After the per-def loop, **reconcile against the live label set** by
   * listing the labels actually present on the remote. Anything counted
   * in `created` or `skipped` that isn't actually present is moved to a
   * `missing[]` envelope — the bootstrap caller surfaces this loudly so a
   * silent classification miss (Story #2018, Bug 2) can't pretend success.
   * Verification failures (rate-limit, scope) are best-effort: they leave
   * `missing` empty rather than aborting the bootstrap.
   *
   * Returns `{ created: string[], skipped: string[], missing: string[] }`.
   */
  async ensureLabels(labelDefs) {
    const created = [];
    const skipped = [];
    for (const def of labelDefs) {
      const color = (def.color ?? '').replace(/^#/, '');
      try {
        await withTransientRetry(() =>
          this._gh.label.create(def.name, [
            '--color',
            color,
            '--description',
            def.description ?? '',
          ]),
        );
        created.push(def.name);
      } catch (err) {
        if (isLabelAlreadyExistsError(err)) {
          skipped.push(def.name);
          continue;
        }
        throw err;
      }
    }

    const missing = await this._reconcileLabelsPresence(labelDefs);
    if (missing.length === 0) {
      return { created, skipped, missing };
    }
    // Anything we believed we created/skipped that isn't actually on the
    // remote is by definition a silent failure — drop it from those lists
    // so the consumer's `created.length + skipped.length` math stays
    // honest. The full label name survives in `missing[]`.
    const missingSet = new Set(missing);
    return {
      created: created.filter((n) => !missingSet.has(n)),
      skipped: skipped.filter((n) => !missingSet.has(n)),
      missing,
    };
  }

  /**
   * Best-effort post-loop reconcile for `ensureLabels`. Lists the live
   * label set and returns the names from `labelDefs` that are absent.
   * Internal helper — production callers go through `ensureLabels`.
   *
   * Accepts either the real `gh-exec` --json shape (returns an `Array`
   * directly) or the legacy/test shape (`{stdout: '<json>', ...}`) so
   * the verification path stays harness-agnostic.
   */
  async _reconcileLabelsPresence(labelDefs) {
    let result;
    try {
      result = await this._gh.label.list(['--limit', '500'], ['name']);
    } catch {
      return [];
    }
    const liveLabels = this._normalizeLabelListResult(result);
    if (!Array.isArray(liveLabels) || liveLabels.length === 0) {
      // Listing returned nothing parseable. Treat as "verification
      // unavailable" rather than "every label is missing" — false
      // positives on this path would derail an otherwise-clean bootstrap.
      return [];
    }
    const liveNames = new Set();
    for (const row of liveLabels) {
      if (row && typeof row.name === 'string') liveNames.add(row.name);
    }
    if (liveNames.size === 0) return [];
    const missing = [];
    for (const def of labelDefs) {
      if (def?.name && !liveNames.has(def.name)) missing.push(def.name);
    }
    return missing;
  }

  _normalizeLabelListResult(result) {
    if (Array.isArray(result)) return result;
    if (result && typeof result.stdout === 'string') {
      const trimmed = result.stdout.trim();
      if (!trimmed) return [];
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }
}
