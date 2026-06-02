#!/usr/bin/env node
// bin/mandrel.js — mandrel CLI entry point

/**
 * Convention-based subcommand dispatcher.
 *
 * Resolves `process.argv[2]` to `lib/cli/<name>.js` and dynamically
 * imports it so the subcommand surface can grow without touching this
 * file. Each subcommand module must export a default function `run(argv)`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function usage(badSub) {
  if (badSub) {
    process.stderr.write(
      `mandrel: unknown subcommand '${badSub}'\n\nUsage: mandrel <subcommand> [args]\n`,
    );
  } else {
    process.stderr.write('Usage: mandrel <subcommand> [args]\n');
  }
}

const sub = process.argv[2];

if (!sub) {
  usage();
  process.exit(1);
}

const subFile = path.resolve(__dirname, '..', 'lib', 'cli', `${sub}.js`);

let mod;
try {
  mod = await import(subFile);
} catch (err) {
  if (err.code === 'ERR_MODULE_NOT_FOUND' && err.message.includes(subFile)) {
    usage(sub);
    process.exit(1);
  }
  // Re-throw broken-module errors so they are visible rather than masked.
  throw err;
}

if (typeof mod.default !== 'function') {
  process.stderr.write(
    `mandrel: subcommand '${sub}' does not export a default function\n`,
  );
  process.exit(1);
}

await mod.default(process.argv.slice(3));
