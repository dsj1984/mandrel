#!/usr/bin/env node
/**
 * CLI: keep the committed `.agentrc` validator in step with its schema
 * (Story #5109).
 *
 * `getAgentrcValidator()` used to compile `AGENTRC_SCHEMA` with AJV in every
 * process that touched configuration — 36 of the 79 entry scripts, at ~35 ms
 * each — to produce a function that is a pure derivative of a literal already
 * committed to the repository. The compile is now done **once, here**, and its
 * output is committed as `lib/generated/agentrc-validator.js`; the runtime
 * imports that module and only falls back to a live compile behind
 * `MANDREL_AGENTRC_VALIDATOR=dynamic`.
 *
 * A generated artifact that nothing re-derives is a lie waiting to happen, so
 * this script joins the standalone-ratchet family — `check-arch-cycles.js`,
 * `check-cyclomatic.js`, `check-dead-exports.js` — and follows their contract:
 *
 *   - `--check` regenerates in memory and compares against the committed
 *     file. Exit 0 when they agree, exit 1 (naming the fix) when they do not.
 *     `npm run lint` runs this, so a schema edit that skips regeneration is
 *     refused before it can ship a validator that accepts the wrong config.
 *   - No flag rewrites the file. That is the sanctioned motion after a
 *     deliberate schema change.
 *
 * The comparison is over the exact bytes, which is what makes the gate
 * meaningful: AJV's standalone emit is deterministic for a given schema and
 * AJV version, so a diff means either the schema moved or the compiler did,
 * and both demand a fresh artifact.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { runAsCli } from '../.agents/scripts/lib/cli-utils.js';
import { AGENTRC_SCHEMA } from '../.agents/scripts/lib/config-settings-schema.js';

const require = createRequire(import.meta.url);

/** Repo-relative home of the committed artifact. */
export const GENERATED_VALIDATOR_PATH =
  '.agents/scripts/lib/generated/agentrc-validator.js';

/** The command that rewrites it — quoted in every failure message. */
const REGEN_COMMAND = 'npm run validator:gen';

/**
 * AJV options for the generated validator.
 *
 * `allErrors: true` MUST match the runtime fallback in
 * `config-settings-schema.js#getAgentrcValidator` — it is the difference
 * between reporting one error and reporting all of them, and every caller
 * that renders `validate.errors` would change behaviour if the two diverged.
 * `code.source` is what makes the instance emittable; `code.esm` selects the
 * ES-module emit. Neither touches validation semantics.
 */
const AJV_OPTIONS = Object.freeze({
  allErrors: true,
  code: { source: true, esm: true },
});

/**
 * Banner prepended to the emitted module.
 *
 * The `createRequire` shim is load-bearing: AJV's `esm` emit still reaches for
 * its shared runtime helpers (`ajv/dist/runtime/*`) with `require(...)`, which
 * is not defined inside an ES module. Handing the generated code a real
 * `require` is the smallest fix that keeps the emit verbatim — rewriting those
 * calls into imports would mean re-deriving AJV's own codegen by hand, and
 * would silently rot the next time it changes shape.
 *
 * The coverage pragma matches `config-settings-schema.js`: generated code has
 * no branches anyone authored, so a coverage figure over it measures nothing.
 */
const BANNER = `/* node:coverage ignore file -- generated artifact; see check-generated-validator.js */
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Precompiled AJV validator for \`AGENTRC_SCHEMA\`
 * (.agents/scripts/lib/config-settings-schema.js), emitted by
 * scripts/check-generated-validator.js.
 *
 * Regenerate with \`${REGEN_COMMAND}\`; \`npm run lint\` fails when this file
 * and the schema disagree.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
`;

/**
 * Emit the standalone validator source for `AGENTRC_SCHEMA`.
 *
 * Exported so the parity test can assert the committed artifact and a fresh
 * emit agree without shelling out to this CLI.
 *
 * @returns {string} Complete module source, newline-terminated.
 */
export function generateValidatorSource() {
  const ajvModule = require('ajv');
  const Ajv = ajvModule.default ?? ajvModule;
  const standaloneModule = require('ajv/dist/standalone');
  const standaloneCode = standaloneModule.default ?? standaloneModule;
  const ajv = new Ajv(AJV_OPTIONS);
  const validate = ajv.compile(AGENTRC_SCHEMA);
  const body = standaloneCode(ajv, validate);
  return `${BANNER}\n${body.trim()}\n`;
}

/**
 * Read the committed artifact, or `null` when it is absent.
 *
 * @param {string} absPath
 * @returns {string | null}
 */
function readCommitted(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Top-level CLI entry. Exported so tests can drive both modes through the
 * injected seams rather than by spawning a process.
 *
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   generateImpl?: () => string,
 *   writeFileImpl?: (p: string, data: string) => void,
 * }} [opts]
 * @returns {number} 0 = in step (or written); 1 = stale artifact.
 */
export function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  generateImpl = generateValidatorSource,
  writeFileImpl = (p, data) => fs.writeFileSync(p, data),
} = {}) {
  const checkOnly = argv.includes('--check');
  const absPath = path.resolve(cwd, GENERATED_VALIDATOR_PATH);
  const expected = generateImpl();

  if (!checkOnly) {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileImpl(absPath, expected);
    stdout.write(
      `[generated-validator] wrote ${expected.length} bytes to ${GENERATED_VALIDATOR_PATH}\n`,
    );
    return 0;
  }

  const actual = readCommitted(absPath);
  if (actual === null) {
    stderr.write(
      `[generated-validator] ❌ ${GENERATED_VALIDATOR_PATH} is missing — run \`${REGEN_COMMAND}\`\n`,
    );
    return 1;
  }
  if (actual !== expected) {
    stderr.write(
      `[generated-validator] ❌ ${GENERATED_VALIDATOR_PATH} is stale against AGENTRC_SCHEMA ` +
        `(committed ${actual.length} bytes, regenerated ${expected.length}) — run \`${REGEN_COMMAND}\`\n`,
    );
    return 1;
  }
  stdout.write(
    `[generated-validator] ✅ ${GENERATED_VALIDATOR_PATH} is in step with AGENTRC_SCHEMA\n`,
  );
  return 0;
}

async function main() {
  return runCli();
}

runAsCli(import.meta.url, main, {
  source: 'generated-validator',
  propagateExitCode: true,
  errorPrefix: '[generated-validator] ❌ Fatal error',
  usage: {
    invocation: 'node scripts/check-generated-validator.js [--check]',
    summary:
      'Regenerate the committed AJV validator for `AGENTRC_SCHEMA`, or (with --check) fail when the committed artifact is stale against the schema.',
    flags: [
      [
        '--check',
        'Compare only: exit 1 when the committed artifact differs from a fresh emit. Writes nothing.',
      ],
    ],
    notes: [
      'Exit codes:\n  0  artifact written, or already in step\n  1  committed artifact is missing or stale',
      `Regenerate with \`${REGEN_COMMAND}\`. The runtime falls back to a live AJV compile when MANDREL_AGENTRC_VALIDATOR=dynamic.`,
    ],
  },
});
