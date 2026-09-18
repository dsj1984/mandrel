/**
 * GitHub Provider — LabelGateway: idempotent label create with live-set
 * reconciliation, paginated listing, and delete.
 */

import { withTransientRetry } from './errors.js';
import { paginateRest } from './request-helpers.js';

/**
 * "Label already exists" across CLI stderr, the API 422 `already_exists`
 * body, and the legacy mock shape. Anchored to the label lexicon so an
 * unrelated "already exists" can't turn a real create failure into a skip.
 */
export function isLabelAlreadyExistsError(err) {
  if (!err) return false;
  const message = err?.message ?? '';
  const stderr = err?.stderr ?? '';
  if (/label\b[\s\S]*?already exists/i.test(stderr)) return true;
  if (/label\b[\s\S]*?already exists/i.test(message)) return true;
  if (/already_exists/i.test(stderr) || /already_exists/i.test(message)) {
    return true;
  }
  if (
    /\bcode\s+422\b/i.test(message) &&
    /already exists/i.test(message + stderr)
  ) {
    return true;
  }
  return false;
}

/**
 * Only a 404 counts: reading a 403 or 422 as "already gone" would let a
 * sweep report labels reaped that still exist.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isLabelNotFoundError(err) {
  if (!err) return false;
  if (err.status === 404 || err.statusCode === 404) return true;
  return /\bHTTP\s+404\b|\bnot found\b/i.test(
    `${err.message ?? ''} ${err.stderr ?? ''}`,
  );
}

/** GitHub's description cap; longer is a 422 that `gh` reports as exit 1. */
const LABEL_DESCRIPTION_MAX_LENGTH = 100;

/**
 * Fail before spawning `gh`, naming the label and its length. A throw, not a
 * truncation: every caller already handles a throw, and a truncated
 * description is text nobody chose.
 *
 * @param {{ name?: string, description?: string }} def
 * @throws {Error} when the description exceeds the cap.
 */
function assertLabelDescriptionWithinCap(def) {
  const description = def?.description ?? '';
  if (description.length <= LABEL_DESCRIPTION_MAX_LENGTH) return;
  throw new Error(
    `label "${def?.name}" description is ${description.length} characters; ` +
      `GitHub rejects anything over ${LABEL_DESCRIPTION_MAX_LENGTH}`,
  );
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
   * Create each label, counting "already exists" as `skipped`; other errors
   * propagate. Then reconcile against the live set: anything believed
   * created/skipped but absent moves to `missing[]`, so a misclassification
   * can't pass as success. A failed verification leaves `missing` empty.
   *
   * Returns `{ created: string[], skipped: string[], missing: string[] }`.
   */
  async ensureLabels(labelDefs) {
    const created = [];
    const skipped = [];
    for (const def of labelDefs) {
      assertLabelDescriptionWithinCap(def);
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
    const missingSet = new Set(missing);
    return {
      created: created.filter((n) => !missingSet.has(n)),
      skipped: skipped.filter((n) => !missingSet.has(n)),
      missing,
    };
  }

  /**
   * Names from `labelDefs` absent from the live set. Best-effort: an
   * unreadable or empty listing means "verification unavailable", not
   * "everything missing".
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

  /**
   * The full label vocabulary, paginated — never the capped `--limit 500`
   * list, since a caller choosing deletions from a truncated view would skip
   * labels past the cap. Rows without a usable `name` are dropped.
   *
   * @returns {Promise<Array<{ name: string, color: string|null, description: string|null }>>}
   * @field-manifest /repos/{owner}/{repo}/labels: name, color, description
   */
  async listLabels() {
    const endpoint = `/repos/${this.owner}/${this.repo}/labels`;
    const rows = await paginateRest(this._gh, endpoint, {
      label: `listLabels ${this.owner}/${this.repo}`,
    });
    return (Array.isArray(rows) ? rows : [])
      .filter((row) => typeof row?.name === 'string')
      .map((row) => ({
        name: row.name,
        color: row.color ?? null,
        description: row.description ?? null,
      }));
  }

  /**
   * Delete via REST so "already gone" is a structured 404. A missing label is
   * a normal no-op: sweeps run repeatedly and concurrently with the close reap.
   *
   * @param {string} name
   * @returns {Promise<{ deleted: boolean, reason: string|null }>}
   */
  async deleteLabel(name) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('deleteLabel: a non-empty label name is required');
    }
    const endpoint = `/repos/${this.owner}/${this.repo}/labels/${encodeURIComponent(name)}`;
    try {
      await withTransientRetry(() =>
        this._gh.api({ method: 'DELETE', endpoint }),
      );
      return { deleted: true, reason: null };
    } catch (err) {
      if (isLabelNotFoundError(err))
        return { deleted: false, reason: 'not-found' };
      throw err;
    }
  }

  /** Accepts the `gh-exec` array shape or a `{ stdout }` JSON wrapper. */
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
