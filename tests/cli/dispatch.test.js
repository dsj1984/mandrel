// tests/cli/dispatch.test.js — `mandrel dispatch` is the script's entry
// function behind the CLI's flag allowlist: same envelope, same exit code.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runDispatch } from '../../.agents/scripts/dispatch.js';
import run from '../../lib/cli/dispatch.js';
import { makeDispatchBoard } from '../helpers/dispatch-board.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', '..', 'bin', 'mandrel.js');

const tickets = () => [
  { id: 7, labels: ['type::story', 'agent::ready'] },
  { id: 8, labels: ['type::story', 'agent::review-spec'] },
  {
    id: 9,
    labels: ['type::story', 'agent::executing', 'env::local'],
    assignees: ['me'],
  },
];

async function viaScript(argv) {
  const board = makeDispatchBoard(tickets());
  const { out, deps } = board.capture();
  const code = await runDispatch(argv, deps);
  return { code, stdout: out.join(''), writes: board.writes };
}

async function viaCli(argv) {
  const board = makeDispatchBoard(tickets());
  const { out, deps } = board.capture();
  let code = null;
  await run(argv, { ...deps, exit: (c) => (code = c) });
  return { code, stdout: out.join(''), writes: board.writes };
}

describe('mandrel dispatch ≡ dispatch.js (AC-1)', () => {
  const argvs = [
    ['--env', 'local', '7'],
    ['--env', 'local', '8'],
    ['--env', 'local', '--dry-run', '7'],
    ['--stop', '9'],
    ['--status', '--json'],
    ['7'],
  ];
  for (const argv of argvs) {
    it(`${argv.join(' ')} — same envelope and exit code`, async () => {
      const script = await viaScript(argv);
      const cli = await viaCli(argv);
      assert.equal(cli.code, script.code);
      assert.equal(cli.stdout, script.stdout);
      assert.deepEqual(cli.writes, script.writes);
    });
  }
});

describe('the bin entry', () => {
  const runBin = (args) =>
    spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

  it('rejects a flag outside the documented set before doing any work (AC-2)', () => {
    const result = runBin(['dispatch', '--steal', '7']);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /unknown flag '--steal' for subcommand 'dispatch'/,
    );
    assert.equal(result.stdout, '');
  });

  it('exits 0 on --help with a usage block (AC-13)', () => {
    const result = runBin(['dispatch', '--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage: mandrel dispatch/);
  });
});

describe('config resolution', () => {
  it('resolves config from the directory the operator runs it in, not the package root', async () => {
    let seenCwd = null;
    await run(['--status', '--json'], {
      write: () => {},
      exit: () => {},
      resolveConfigImpl: ({ cwd }) => {
        seenCwd = cwd;
        return null;
      },
      createProviderImpl: () => {
        throw new Error('stop');
      },
    });
    assert.equal(seenCwd, process.cwd());
  });
});
