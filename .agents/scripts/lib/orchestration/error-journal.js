/**
 * ErrorJournal — append-only JSONL log of swallowed errors from the
 * orchestration engine's "silent catch" sites.
 *
 * Design notes (see tech spec #382):
 *   - JSONL format: a crashed orchestrator still leaves a valid file up to the
 *     last full line.
 *   - Lazy open: the fd opens on first `record()` call, so runs without any
 *     swallowed errors produce no file.
 *   - Additive: does not replace `logger.warn`. Callers emit both so live
 *     tails stay useful.
 *   - Secret masking: before writing, any string value whose parent key name
 *     or content looks secret-like gets a `::add-mask::<value>` directive
 *     emitted to stdout so any host with mask support redacts accidental
 *     echoes.
 *   - Finalize is idempotent: repeat calls are safe.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const SECRET_KEY_RE = /token|secret|password|bearer|apikey|api[-_]?key|auth/i;
const SECRET_VALUE_RE =
  /\b(gh[pous]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{20,}|xox[bpars]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16})\b/;
// Hoisted so the maintainability analyzer (escomplex) doesn't choke on an
// inline RegExp literal inside .split() — it mis-parses the sequence.
const NEWLINE_RE = /\r?\n/;

export class ErrorJournal {
  /**
   * @param {{ epicId: number, logDir?: string }} opts
   */
  constructor({ epicId, logDir = 'temp' } = {}) {
    if (!Number.isInteger(epicId)) {
      throw new TypeError('ErrorJournal requires a numeric epicId');
    }
    this.epicId = epicId;
    this.logDir = logDir;
    this._path = path.join(logDir, `epic-${epicId}-errors.log`);
    this._fh = null;
    this._opening = null;
    this._finalized = false;
  }

  /** @returns {string} Absolute or relative path to the journal file. */
  get path() {
    return this._path;
  }

  /**
   * Append one entry to the journal. Emits `::add-mask::` directives for any
   * secret-looking values before writing.
   *
   * @param {{
   *   module: string,
   *   op: string,
   *   error: unknown,
   *   recovery?: string,
   * }} entry
   */
  async record({ module, op, error, recovery } = {}) {
    if (this._finalized) return;
    const payload = {
      ts: new Date().toISOString(),
      epicId: this.epicId,
      module: module ?? null,
      op: op ?? null,
      error: serializeError(error),
      recovery: recovery ?? null,
    };
    emitMasksFor(payload);
    const fh = await this._ensureOpen();
    await fh.write(`${JSON.stringify(payload)}\n`);
  }

  /**
   * Close the underlying file handle. Idempotent: repeat calls are no-ops.
   * Calls to `record` after finalize silently drop.
   */
  async finalize() {
    if (this._finalized) return;
    this._finalized = true;
    const fh = this._fh;
    this._fh = null;
    this._opening = null;
    if (fh) {
      try {
        await fh.close();
      } catch {
        // idempotent — closing a closed handle is fine
      }
    }
  }

  async _ensureOpen() {
    if (this._fh) return this._fh;
    if (!this._opening) {
      this._opening = (async () => {
        await fs.mkdir(this.logDir, { recursive: true });
        this._fh = await fs.open(this._path, 'a');
        return this._fh;
      })();
    }
    return this._opening;
  }
}

function serializeError(err) {
  if (err == null) return null;
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  if (typeof err === 'string') return { message: err };
  if (typeof err === 'object') return err;
  return { message: String(err) };
}

function emitMasksFor(node, parentKey = null) {
  if (node == null) return;
  if (typeof node === 'string') {
    if (
      (parentKey && SECRET_KEY_RE.test(parentKey)) ||
      SECRET_VALUE_RE.test(node)
    ) {
      for (const line of node.split(NEWLINE_RE)) {
        const trimmed = line.trim();
        if (trimmed) console.log(`::add-mask::${trimmed}`);
      }
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) emitMasksFor(item, parentKey);
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) emitMasksFor(v, k);
  }
}
