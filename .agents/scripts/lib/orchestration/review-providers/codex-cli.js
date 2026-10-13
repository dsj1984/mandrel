/**
 * review-providers/codex-cli.js — the Codex CLI mechanics behind the `codex`
 * provider: the `codex --version` probe and one `codex exec` review run
 * (read-only sandbox, ephemeral, schema-constrained output).
 *
 * `codex exec review` is deliberately not used: its `--base` conflicts with a
 * prompt (no depth directive) and it ignores `--output-schema`.
 *
 * @typedef {import('./types.js').Severity} Severity
 * @typedef {import('./types.js').ReviewDepth} ReviewDepth
 * @typedef {{ status: number, stdout: string, stderr: string }} InvokeResult
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnCaptureAsync, spawnChild } from '../../child-exec.js';
import { resolvedTempRoot } from '../../config/temp-paths.js';
import { resolveConfig } from '../../config-resolver.js';
import { PROJECT_ROOT } from '../../project-root.js';
import { PROVIDER_SEVERITY_MAP } from './provider-severity.js';
import { renderDepthDirective } from './review-depth.js';

const PROBE_TIMEOUT_MS = 5000;
const INVOKE_TIMEOUT_MS = 15 * 60 * 1000;
const IS_WINDOWS = process.platform === 'win32';

/**
 * Codex severity tokens (case-insensitive) → canonical `Severity`; an
 * unnamed token falls through to `'suggestion'`. The keys are also the
 * schema's severity enum.
 *
 * @type {Readonly<Record<string, Severity>>}
 */
export const CODEX_SEVERITY_MAP = PROVIDER_SEVERITY_MAP;

/**
 * Codex structured output is strict: every property required, no extras,
 * nullable location.
 */
const FINDINGS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'body', 'file', 'line', 'category'],
        properties: {
          severity: { type: 'string', enum: Object.keys(CODEX_SEVERITY_MAP) },
          title: { type: 'string' },
          body: { type: 'string' },
          file: { type: ['string', 'null'] },
          line: { type: ['integer', 'null'] },
          category: { type: 'string' },
        },
      },
    },
  },
});

/**
 * Synchronous so a missing CLI surfaces at construction, not mid-review.
 *
 * @param {{ run?: Function }} [opts] - `(file, args, options)` spawn seam.
 * @returns {boolean} true when `codex --version` exits 0.
 */
export function defaultProbeCodexCommand(opts = {}) {
  try {
    const result = spawnChild('codex', ['--version'], {
      shell: IS_WINDOWS,
      timeout: PROBE_TIMEOUT_MS,
      ...(opts.run ? { run: opts.run } : {}),
    });
    return (result?.status ?? 1) === 0;
  } catch {
    return false;
  }
}

/**
 * @param {{ baseRef: string, headRef: string, depth?: ReviewDepth }} args
 * @returns {string}
 */
function buildReviewPrompt({ baseRef, headRef, depth }) {
  return (
    `Review the code changes in the git diff \`${baseRef}...${headRef}\` ` +
    `of this repository (run \`git diff ${baseRef}...${headRef}\` to read ` +
    `it). ${renderDepthDirective(depth)}\n\n` +
    'Report correctness, security, reliability and maintainability problems ' +
    'the change introduces. For each one give the file and line in the new ' +
    'version when attributable (otherwise null), a short title, a markdown ' +
    'body explaining why it is wrong and how to fix it, and a category. ' +
    'Do not modify any file. Report findings ONLY through the required ' +
    'output schema; an empty `findings` array means no problems.\n'
  );
}

/**
 * @param {string} file
 * @returns {string|null}
 */
function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Run one `codex exec` review in a per-run directory under the project
 * tempRoot (removed afterwards). The prompt rides stdin; the last-message
 * file becomes `stdout`.
 *
 * @param {{ baseRef: string, headRef: string, depth?: ReviewDepth }} args
 * @param {{ run?: Function, tempRoot?: string, cwd?: string }} [deps]
 * @returns {Promise<InvokeResult>}
 */
export async function invokeCodexExec(args, deps = {}) {
  const tempRoot = deps.tempRoot ?? resolvedTempRoot(resolveConfig());
  fs.mkdirSync(tempRoot, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(tempRoot, 'codex-review-'));
  try {
    const schemaPath = path.join(runDir, 'findings.schema.json');
    const lastMessagePath = path.join(runDir, 'last-message.json');
    fs.writeFileSync(schemaPath, JSON.stringify(FINDINGS_SCHEMA));
    const execArgs = ['exec', '--sandbox', 'read-only', '--ephemeral'];
    execArgs.push('--output-schema', schemaPath, '-o', lastMessagePath, '-');
    const result = await spawnCaptureAsync('codex', execArgs, {
      cwd: deps.cwd ?? PROJECT_ROOT,
      input: buildReviewPrompt(args),
      shell: IS_WINDOWS,
      timeout: INVOKE_TIMEOUT_MS,
      ...(deps.run ? { run: deps.run } : {}),
    });
    if (result.status !== 0) return result;
    const lastMessage = readIfPresent(lastMessagePath);
    if (lastMessage === null) {
      return {
        status: 1,
        stdout: '',
        stderr: `codex exec wrote no last-message file. ${result.stderr}`,
      };
    }
    return { status: 0, stdout: lastMessage, stderr: result.stderr };
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}
