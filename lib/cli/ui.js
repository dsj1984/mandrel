// lib/cli/ui.js
/**
 * `mandrel ui` subcommand: start the local dispatch board on 127.0.0.1,
 * print its URL, and run until interrupted. It refuses to start where no
 * GitHub repository is configured, since every board read needs one. The server stores nothing; a
 * random per-process token, embedded in the served page, guards the API.
 *
 * Usage:
 *   mandrel ui                # http://127.0.0.1:4319/
 *   mandrel ui --port 5000
 *
 * Injectable seams (used by tests): `write`, `errOut`, `exit`, `token`,
 * `sources` and `createServer`.
 */

import { randomBytes } from 'node:crypto';

import { createUiServer } from './ui/server.js';
import { projectSources } from './ui/sources.js';

export const DEFAULT_PORT = 4319;

const UI_USAGE = `Usage: mandrel ui [--port <n>]

Serves the local dispatch board on http://127.0.0.1:<port>/ (default ${DEFAULT_PORT})
until interrupted. Bound to 127.0.0.1 only; see
.agents/docs/runbooks/dispatch-board.md.
`;

/**
 * @param {string[]} argv
 * @returns {{ port: number, help: boolean }}
 */
export function parseUiArgs(argv) {
  let port = DEFAULT_PORT;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--port') port = parsePort(argv[++i]);
    else if (arg.startsWith('--port=')) port = parsePort(arg.slice(7));
    else throw new Error(`unexpected argument '${arg}'`);
  }
  return { port, help };
}

function parsePort(value) {
  if (!/^\d{1,5}$/.test(value ?? '') || Number(value) > 65535) {
    throw new Error('--port needs an integer from 0 to 65535');
  }
  return Number(value);
}

/**
 * @param {string[]} argv
 * @param {{
 *   write?: (s: string) => void,
 *   errOut?: (s: string) => void,
 *   exit?: (code: number) => void,
 *   token?: string,
 *   sources?: ReturnType<typeof import('./ui/sources.js').createSources>,
 *   createServer?: typeof createUiServer,
 * }} [deps]
 * @returns {Promise<import('node:http').Server|null>} The listening server.
 */
export async function runUi(
  argv = [],
  {
    write = process.stdout.write.bind(process.stdout),
    errOut = process.stderr.write.bind(process.stderr),
    exit = process.exit.bind(process),
    token = randomBytes(32).toString('hex'),
    sources,
    createServer = createUiServer,
  } = {},
) {
  let args;
  try {
    args = parseUiArgs(argv);
  } catch (err) {
    errOut(`mandrel ui: ${err.message}\n`);
    exit(1);
    return null;
  }
  if (args.help) {
    write(UI_USAGE);
    return null;
  }
  const boardSources = projectSources(sources, errOut, exit);
  if (!boardSources) return null;
  return listenOn(createServer({ token, sources: boardSources }), args.port, {
    write,
    errOut,
    exit,
  });
}

/** Listen on 127.0.0.1 and print the URL; resolves `null` when the port is taken. */
function listenOn(server, port, { write, errOut, exit }) {
  return new Promise((resolve) => {
    server.once('error', (err) => {
      errOut(`mandrel ui: cannot listen on port ${port}: ${err.code}\n`);
      exit(1);
      resolve(null);
    });
    server.listen(port, '127.0.0.1', () => {
      write(`mandrel ui: http://127.0.0.1:${server.address().port}/\n`);
      resolve(server);
    });
  });
}

/**
 * Default export consumed by `bin/mandrel.js`.
 *
 * @param {string[]} argv
 * @param {Parameters<typeof runUi>[1]} [deps]
 * @returns {Promise<void>}
 */
export default async function run(argv, deps) {
  await runUi(argv, deps);
}
