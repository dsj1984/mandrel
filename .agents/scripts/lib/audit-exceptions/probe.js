/**
 * The opt-in `--probe` pass: ask each tool installed in the analysed repo which
 * of its own suppressions suppress nothing — biome's unused-suppression
 * diagnostics, eslint's unused disable directives, TypeScript's TS2578 and
 * knip's configuration hints. Tools run read-only (no write or fix flag) from
 * their package's own JS bin under the current `node`, so the pass works the
 * same on Windows. An absent, failing or timed-out tool is a degradation.
 *
 * @module lib/audit-exceptions/probe
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnCaptureAsync } from '../child-exec.js';
import { readJsonc } from './read.js';

export const PROBE_TIMEOUT_MS = 180_000;

const relTo = (root, file) =>
  path.relative(root, path.resolve(root, file)).split(path.sep).join('/');

/** Each tool: package + bin, when it applies, its args, and how to read hits. */
const TOOLS = Object.freeze([
  {
    id: 'biome',
    pkg: '@biomejs/biome',
    bin: 'biome',
    applies: (scope) =>
      scope.fileSet.has('biome.json') || scope.fileSet.has('biome.jsonc'),
    args: ['lint', '--reporter=github', '--max-diagnostics=none', '.'],
    hits: (out, root) =>
      [
        ...out.matchAll(
          /^::\w+ title=suppressions\/unused,file=([^,]+),line=(\d+)/gm,
        ),
      ].map((m) => ({
        file: relTo(root, m[1]),
        line: Number(m[2]),
      })),
  },
  {
    id: 'eslint',
    pkg: 'eslint',
    bin: 'eslint',
    applies: (scope) =>
      scope.files.some((f) =>
        /(?:^|\/)(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.\w+)?)$/.test(f),
      ),
    args: ['.', '--report-unused-disable-directives', '--format', 'json'],
    hits: (out, root) => {
      let results;
      try {
        results = JSON.parse(out);
      } catch {
        return [];
      }
      return results.flatMap((r) =>
        (r.messages ?? [])
          .filter(
            (m) =>
              m.ruleId === null &&
              /unused eslint-disable/i.test(m.message ?? ''),
          )
          .map((m) => ({ file: relTo(root, r.filePath), line: m.line })),
      );
    },
  },
  {
    id: 'typescript',
    pkg: 'typescript',
    bin: 'tsc',
    applies: (scope) => scope.fileSet.has('tsconfig.json'),
    args: [
      '--noEmit',
      '--incremental',
      'false',
      '--pretty',
      'false',
      '-p',
      'tsconfig.json',
    ],
    hits: (out, root) =>
      [...out.matchAll(/^(.+?)\((\d+),\d+\): error TS2578:/gm)].map((m) => ({
        file: relTo(root, m[1]),
        line: Number(m[2]),
      })),
  },
  {
    id: 'knip',
    pkg: 'knip',
    bin: 'knip',
    applies: (scope) => scope.files.some((f) => /^\.?knip\.jsonc?$/.test(f)),
    args: ['--no-progress'],
    hits: (out, root) =>
      [...out.matchAll(/^(\S+)\s+(\S+)\s+Remove from (\w+)/gm)].map((m) => ({
        file: relTo(root, m[2]),
        target: m[1],
      })),
  },
]);

/**
 * @param {string} root
 * @param {string} pkg
 * @param {string} binName
 * @returns {string|null} absolute path of the package's JS bin.
 */
function resolveBin(root, pkg, binName) {
  const dir = path.join(root, 'node_modules', pkg);
  const manifest = readJsonc(dir, 'package.json');
  const bin =
    typeof manifest?.bin === 'string' ? manifest.bin : manifest?.bin?.[binName];
  if (!bin) return null;
  const abs = path.join(dir, bin);
  return fs.existsSync(abs) ? abs : null;
}

function matches(record, hit) {
  if (record.file !== hit.file) return false;
  return hit.target === undefined
    ? record.line === hit.line
    : record.target === hit.target;
}

/**
 * @param {object} tool
 * @param {object[]} records
 * @param {object} opts
 * @returns {Promise<{ flagged: number, degradation: object|null }>}
 */
async function runTool(tool, records, { root, timeoutMs, spawn }) {
  const bin = resolveBin(root, tool.pkg, tool.bin);
  if (!bin) {
    return {
      flagged: 0,
      degradation: {
        input: `probe:${tool.id}`,
        reason: 'tool not installed',
        detail: tool.pkg,
      },
    };
  }
  const res = await spawn(process.execPath, [bin, ...tool.args], {
    cwd: root,
    timeout: timeoutMs,
  });
  const hits = tool.hits(`${res.stdout}\n${res.stderr}`, root);
  if (res.status !== 0 && hits.length === 0 && res.stdout === '') {
    return {
      flagged: 0,
      degradation: {
        input: `probe:${tool.id}`,
        reason: 'tool run failed',
        detail: res.stderr.slice(0, 500),
      },
    };
  }
  let flagged = 0;
  for (const record of records) {
    if (hits.some((h) => matches(record, h))) {
      record.probe = { verdict: 'dead', basis: 'tool' };
      flagged += 1;
    }
  }
  return { flagged, degradation: null };
}

/**
 * Flip every record a tool reports unused to `probe: dead (tool)`.
 *
 * @param {object[]} records
 * @param {object} opts
 * @param {string} opts.root
 * @param {object} opts.scope
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.spawn] - `spawnCaptureAsync` seam.
 * @returns {Promise<{ tools: Array<{id: string, flagged: number}>, degradations: object[] }>}
 */
export async function runProbes(
  records,
  { root, scope, timeoutMs = PROBE_TIMEOUT_MS, spawn = spawnCaptureAsync },
) {
  const tools = [];
  const degradations = [];
  for (const tool of TOOLS.filter((t) => t.applies(scope))) {
    const { flagged, degradation } = await runTool(tool, records, {
      root,
      timeoutMs,
      spawn,
    });
    if (degradation) degradations.push(degradation);
    else tools.push({ id: tool.id, flagged });
  }
  return { tools, degradations };
}
