import nodeFs from 'node:fs';
import path from 'node:path';

import { Logger } from '../Logger.js';

/**
 * Terse hot-path result emission (Story #4685).
 *
 * The orchestration CLIs an agent invokes on every delivery turn
 * (`single-story-init`, `single-story-close`, `single-story-confirm-merge`,
 * `sync-branch-from-base`, the close `emit-blocked` path) historically dumped
 * their whole result object to stdout as pretty-printed JSON:
 *
 *   --- STORY CLOSE RESULT ---
 *   { ... every field, 2-space indented ... }
 *   --- END RESULT ---
 *
 * That blob stays resident for the rest of the session and is re-read as
 * cache every subsequent turn, yet the agent acts on only a handful of its
 * fields (the machine contract is the separate terminal envelope). This helper
 * routes the full detail to a temp log the agent can read on demand and emits
 * a single structured summary line in its place.
 *
 * The escape hatch `MANDREL_RESULT_DETAIL=inline` restores the old inline
 * pretty dump for interactive debugging.
 */

/** Env var that restores the legacy inline pretty dump when set to `inline`. */
const RESULT_DETAIL_ENV = 'MANDREL_RESULT_DETAIL';

/**
 * Turn a human label (`STORY CLOSE RESULT`) into a filesystem-safe log
 * basename fragment (`story-close-result`).
 *
 * @param {string} label
 * @returns {string}
 */
function slugify(label) {
  return (
    String(label)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'result'
  );
}

/**
 * The full detail block, byte-compatible with the legacy dump the hot-path
 * scripts used to write to stdout — same markers, same pretty JSON — so a log
 * a human opens reads exactly as the old inline dump did.
 *
 * @param {string} label
 * @param {unknown} result
 * @returns {string}
 */
function detailBlock(label, result) {
  return `--- ${label} ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---`;
}

/**
 * Route a verbose result object off the agent's turn-resident stdout: write the
 * full pretty detail to a temp log and emit a single-line structured summary in
 * its place.
 *
 * @param {object} args
 * @param {string} args.label Human label for the result (e.g. `STORY CLOSE RESULT`).
 * @param {unknown} args.result The full result object; pretty-printed to the log.
 * @param {Record<string, unknown>} [args.summary] The few fields the agent acts
 *   on; serialized compactly onto the single summary line.
 * @param {string|number} [args.scope] Disambiguating suffix for the log name
 *   (typically the Story id) so concurrent deliveries don't clobber one file.
 * @param {string} [args.logDir] Directory for the detail log. Defaults to
 *   `<cwd>/temp/orchestration`.
 * @param {typeof nodeFs} [args.fs] Filesystem seam (tests).
 * @param {{ info: (m: string) => void }} [args.log] Logger seam (tests).
 * @param {NodeJS.ProcessEnv} [args.env] Environment seam (tests).
 * @returns {{ logPath: string|null, inline: boolean, error?: string }}
 */
export function emitTerseResult({
  label,
  result,
  summary = {},
  scope,
  logDir,
  fs = nodeFs,
  log = Logger,
  env = process.env,
} = {}) {
  const body = detailBlock(label, result);

  // Escape hatch: restore the full inline pretty dump for interactive debugging.
  if (String(env[RESULT_DETAIL_ENV] ?? '').toLowerCase() === 'inline') {
    log.info?.(`\n${body}\n`);
    return { logPath: null, inline: true };
  }

  const dir = logDir ?? path.join(process.cwd(), 'temp', 'orchestration');
  const name = `${slugify(label)}${scope ? `-${scope}` : ''}.log`;

  try {
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, name);
    fs.writeFileSync(logPath, `${body}\n`);
    log.info?.(
      `${label} · ${JSON.stringify(summary)} · full detail → ${logPath}`,
    );
    return { logPath, inline: false };
  } catch (err) {
    // Never lose detail: if the log write fails, fall back to the inline dump
    // so the result is still recoverable from the transcript.
    log.info?.(`\n${body}\n`);
    return { logPath: null, inline: true, error: err?.message ?? String(err) };
  }
}
