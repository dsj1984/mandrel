/**
 * `--probe` over each tool's own report, with the tool spawn replaced: the
 * engine must map eslint's unused-directive messages, TypeScript's TS2578 and
 * knip's configuration hints onto the matching records, and treat an absent
 * or failing tool as a degradation.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { runEngine } from '../engine.js';
import { fakeGh, installManifest, lines, makeRepo } from './fixtures/repo.js';

describe('--probe tool reports', () => {
  let env;
  let calls;
  before(async () => {
    const root = makeRepo({
      'package.json': { name: 'p' },
      'eslint.config.js': 'export default [];\n',
      'tsconfig.json': { compilerOptions: {} },
      'knip.json': {
        ignore: ['gone/**', 'src/**'],
        ignoreDependencies: ['left-pad'],
      },
      'biome.json': {},
      'src/a.js': lines(
        '// eslint-disable-next-line no-console -- noisy',
        'console.log(1);',
        '// @ts-expect-error legacy typing',
        'const x = 1;',
        'export { x };',
      ),
    });
    // The bin path must exist for the tool to count as installed; package.json stands in.
    installManifest(root, 'node_modules/eslint', {
      name: 'eslint',
      bin: { eslint: 'package.json' },
    });
    installManifest(root, 'node_modules/typescript', {
      name: 'typescript',
      bin: { tsc: 'package.json' },
    });
    installManifest(root, 'node_modules/knip', {
      name: 'knip',
      bin: { knip: 'package.json' },
    });
    calls = [];
    const outputs = {
      eslint: JSON.stringify([
        {
          filePath: path.join(root, 'src/a.js'),
          messages: [
            {
              ruleId: null,
              line: 1,
              message:
                "Unused eslint-disable directive (no problems were reported from 'no-console').",
            },
            { ruleId: 'no-undef', line: 2, message: 'x' },
          ],
        },
      ]),
      typescript:
        "src/a.js(3,1): error TS2578: Unused '@ts-expect-error' directive.",
      knip: lines(
        'Configuration hints (2)',
        'gone/**     knip.json  Remove from ignore',
        'left-pad    knip.json  Remove from ignoreDependencies',
      ),
    };
    const spawn = async (_node, [bin, ...args]) => {
      const tool = Object.keys(outputs).find((t) =>
        bin.includes(`node_modules${path.sep}${t}`),
      );
      calls.push({ tool, args });
      return { status: 1, stdout: outputs[tool], stderr: '' };
    };
    env = await runEngine({
      cwd: root,
      probe: true,
      today: '2026-10-07',
      gh: fakeGh({}),
      spawn,
    });
  });

  it('runs each installed tool read-only — no write or fix flag', () => {
    assert.deepEqual(calls.map((c) => c.tool).sort(), [
      'eslint',
      'knip',
      'typescript',
    ]);
    for (const { args } of calls) {
      assert.ok(
        !args.some((a) => /^--(?:write|fix|apply)/.test(a)),
        args.join(' '),
      );
    }
    assert.ok(
      calls.find((c) => c.tool === 'typescript').args.includes('--noEmit'),
    );
  });

  it('flips the directives each tool reports unused to dead (tool)', () => {
    const at = (line) =>
      env.records.find((r) => r.file === 'src/a.js' && r.line === line);
    assert.equal(at(1).verdict, 'dead');
    assert.equal(at(1).verdictBasis, 'tool');
    assert.equal(at(3).verdictBasis, 'tool');
  });

  it('maps knip configuration hints onto the config and dependency records', () => {
    const knip = env.records.filter((r) => r.file === 'knip.json');
    assert.equal(knip.find((r) => r.target === 'gone/**').verdictBasis, 'tool');
    assert.equal(
      knip.find((r) => r.target === 'left-pad').verdictBasis,
      'tool',
    );
    assert.notEqual(knip.find((r) => r.target === 'src/**').verdict, 'dead');
  });

  it('reports an applicable but absent tool as a degradation', () => {
    assert.ok(
      env.degradations.some(
        (d) => d.input === 'probe:biome' && d.reason === 'tool not installed',
      ),
    );
    assert.deepEqual(env.probes.map((p) => p.id).sort(), [
      'eslint',
      'knip',
      'typescript',
    ]);
  });
});

describe('--probe on a failing tool', () => {
  it('degrades rather than flipping anything', async () => {
    const root = makeRepo({
      'tsconfig.json': {},
      'src/a.ts': lines('// @ts-ignore', 'export const a = 1;'),
    });
    installManifest(root, 'node_modules/typescript', {
      name: 'typescript',
      bin: { tsc: 'package.json' },
    });
    const spawn = async () => ({ status: 1, stdout: '', stderr: 'boom' });
    const env = await runEngine({
      cwd: root,
      probe: true,
      today: '2026-10-07',
      gh: fakeGh({}),
      spawn,
    });
    assert.ok(
      env.degradations.some(
        (d) => d.input === 'probe:typescript' && d.reason === 'tool run failed',
      ),
    );
    assert.equal(env.records[0].verdict, 'unjustified');
  });
});
