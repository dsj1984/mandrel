import nodeFs from 'node:fs';
import path from 'node:path';

import { orchestrationLogDir } from '../config/temp-paths.js';
import { Logger } from '../Logger.js';

/**
 * Hot-path CLIs log their full result and print one summary line, keeping a
 * pretty JSON blob out of the agent's resident context.
 * `MANDREL_RESULT_DETAIL=inline` restores the inline dump.
 */

const RESULT_DETAIL_ENV = 'MANDREL_RESULT_DETAIL';

/**
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
 * @param {string} label
 * @param {unknown} result
 * @returns {string}
 */
function detailBlock(label, result) {
  return `--- ${label} ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---`;
}

/**
 * @param {object} args
 * @param {string} args.label
 * @param {unknown} args.result
 * @param {Record<string, unknown>} [args.summary]
 * @param {string|number} [args.scope] Log-name suffix so concurrent
 *   deliveries don't clobber one file.
 * @param {string} [args.logDir]
 * @param {object} [args.config]
 * @param {typeof nodeFs} [args.fs]
 * @param {{ info: (m: string) => void }} [args.log]
 * @param {NodeJS.ProcessEnv} [args.env]
 * @returns {{ logPath: string|null, inline: boolean, error?: string }}
 */
export function emitTerseResult({
  label,
  result,
  summary = {},
  scope,
  logDir,
  config,
  fs = nodeFs,
  log = Logger,
  env = process.env,
} = {}) {
  const body = detailBlock(label, result);

  if (String(env[RESULT_DETAIL_ENV] ?? '').toLowerCase() === 'inline') {
    log.info?.(`\n${body}\n`);
    return { logPath: null, inline: true };
  }

  const dir = logDir ?? orchestrationLogDir(config);
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
    // Never lose detail: fall back to the inline dump.
    log.info?.(`\n${body}\n`);
    return { logPath: null, inline: true, error: err?.message ?? String(err) };
  }
}
