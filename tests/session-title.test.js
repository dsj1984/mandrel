// tests/session-title.test.js
//
// Story #6119 — session-title.js builds every host session title: the event
// table, id rendering, the 48-character cap, the disabled answer and the
// usage-error exits.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runSessionTitle } from '../.agents/scripts/session-title.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const CLI = path.join(REPO_ROOT, '.agents', 'scripts', 'session-title.js');

async function run(argv, config = {}) {
  let out = '';
  let err = '';
  const code = await runSessionTitle(
    { argv },
    {
      resolveConfigImpl: () => config,
      stdout: { write: (s) => (out += s) },
      stderr: { write: (s) => (err += s) },
    },
  );
  return { code, out, err, json: out ? JSON.parse(out) : null };
}

const titleOf = async (argv) => (await run(argv)).json.title;

describe('session-title — the event table', () => {
  const cases = [
    [['--event', 'plan-seed', '--summary', 'auto titles'], '○ auto titles'],
    [['--event', 'plan-ticket', '--ids', '12'], '○ Planning #12'],
    [['--event', 'planned', '--ids', '12'], '○ Planned #12'],
    [['--event', 'deliver', '--ids', '12'], '◐ Delivery #12'],
    [['--event', 'deliver-prompt', '--summary', 'add a flag'], '◐ add a flag'],
    [['--event', 'delivered', '--ids', '12'], '● Delivered #12'],
    [['--event', 'blocked', '--ids', '12'], '⊗ Blocked #12'],
    [['--event', 'orchestrate'], '◐ Orchestrating'],
    [['--event', 'audit', '--lens', 'security'], '◐ Audit security'],
    [['--event', 'audited', '--lens', 'security'], '● Audit security'],
    [['--event', 'qa', '--summary', 'checkout'], '◐ QA checkout'],
    [['--event', 'qa-done', '--summary', 'checkout'], '● QA checkout'],
  ];
  for (const [argv, expected] of cases) {
    test(`${argv[1]} → ${expected}`, async () => {
      assert.equal(await titleOf(argv), expected);
    });
  }

  test('AC-1: plan-seed prints the exact envelope when the key is unset', async () => {
    const { code, out } = await run([
      '--event',
      'plan-seed',
      '--summary',
      'session auto titles',
    ]);
    assert.equal(code, 0);
    assert.equal(out, '{"title":"○ session auto titles","apply":true}\n');
  });

  test('--json is accepted', async () => {
    const { code, json } = await run(['--event', 'orchestrate', '--json']);
    assert.equal(code, 0);
    assert.equal(json.title, '◐ Orchestrating');
  });
});

describe('session-title — ids', () => {
  test('one to three ids render space-separated, # dropped and re-added', async () => {
    assert.equal(
      await titleOf(['--event', 'deliver', '--ids', '#7, 3,#5']),
      '◐ Delivery #7 #3 #5',
    );
  });

  test('more than three ids render as a min–max range with a count', async () => {
    assert.equal(
      await titleOf(['--event', 'deliver', '--ids', '6110,6108,6111,6109']),
      '◐ Delivery #6108–#6111 (4)',
    );
  });
});

describe('session-title — text and the 48-character cap', () => {
  test('control characters are stripped and whitespace collapsed', async () => {
    assert.equal(
      await titleOf(['--event', 'qa', '--summary', ' a\u0007\tb \n  c ']),
      '◐ QA a b c',
    );
    assert.equal(
      await titleOf(['--event', 'qa', '--summary', 'a\u0007b']),
      '◐ QA ab',
    );
  });

  test('a long title cuts only the free text, keeping glyph and verb', async () => {
    const title = await titleOf(['--event', 'audit', '--lens', 'x'.repeat(80)]);
    assert.equal([...title].length, 48);
    assert.ok(title.startsWith('◐ Audit x'));
    assert.ok(title.endsWith('…'));
  });

  test('a title at the cap is left whole', async () => {
    const text = 'y'.repeat(48 - '◐ QA '.length);
    assert.equal(
      await titleOf(['--event', 'qa', '--summary', text]),
      `◐ QA ${text}`,
    );
  });
});

describe('session-title — disabled', () => {
  test('sessionTitles: false answers apply: false and exits 0', async () => {
    const { code, out } = await run(['--event', 'orchestrate'], {
      delivery: { routing: { sessionTitles: false } },
    });
    assert.equal(code, 0);
    assert.equal(out, '{"title":null,"apply":false,"reason":"disabled"}\n');
  });
});

describe('session-title — usage errors exit 2', () => {
  const bad = [
    ['an unknown event', ['--event', 'nope']],
    ['a missing event', ['--ids', '1']],
    ['a missing input', ['--event', 'deliver']],
    ['an extra input', ['--event', 'deliver', '--ids', '1', '--lens', 'x']],
    ['an input on orchestrate', ['--event', 'orchestrate', '--summary', 'x']],
    ['the wrong input', ['--event', 'deliver', '--summary', 'x']],
    ['a non-numeric id', ['--event', 'deliver', '--ids', '12,abc']],
    ['an empty summary', ['--event', 'qa', '--summary', ' \t ']],
    ['an unknown flag', ['--event', 'orchestrate', '--bogus']],
  ];
  for (const [name, argv] of bad) {
    test(name, async () => {
      const { code, out, err } = await run(argv);
      assert.equal(code, 2);
      assert.equal(out, '');
      assert.match(err, /Usage: node \.agents\/scripts\/session-title\.js/);
    });
  }

  test('the real CLI exits 2 on a usage error and 0 on --help', () => {
    const fail = spawnSync(process.execPath, [CLI, '--event', 'nope'], {
      encoding: 'utf8',
    });
    assert.equal(fail.status, 2);
    const help = spawnSync(process.execPath, [CLI, '--help'], {
      encoding: 'utf8',
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: /);
    assert.match(help.stdout, /qa-done/);
  });
});
