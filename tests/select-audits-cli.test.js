import assert from 'node:assert/strict';
import test from 'node:test';
import { __setGitRunners } from '../.agents/scripts/lib/git-utils.js';
import {
  matchesAnyFilePattern,
  matchesFilePattern,
  selectAudits,
} from '../.agents/scripts/select-audits.js';
import { MockProvider } from './fixtures/mock-provider.js';

test('matchesFilePattern: pinned glob behaviour (post-relocation parity)', () => {
  assert.equal(matchesFilePattern('**.js', 'bundlejs'), false);
  assert.equal(matchesFilePattern('**/*.lock', 'yarn.lock'), true);
  assert.equal(matchesFilePattern('**/auth/*.js', 'src/auth/login.js'), true);
  assert.equal(matchesFilePattern('*.md', 'README.md'), true);
});

test('matchesAnyFilePattern: returns true when any pattern matches any file', () => {
  assert.equal(
    matchesAnyFilePattern(['*.ts', 'src/**/*.js'], ['src/lib/foo.js']),
    true,
  );
  assert.equal(matchesAnyFilePattern(['*.ts'], ['foo.js']), false);
  assert.equal(matchesAnyFilePattern([], ['foo.js']), false);
});

test('selectAudits: keyword matching against ticket title/body still selects the right audit', async () => {
  const provider = new MockProvider({
    tickets: {
      300: {
        id: 300,
        title: 'Improve accessibility of modal dialogs',
        body: 'Screen-reader coverage missing.',
        labels: [],
      },
    },
  });

  __setGitRunners(
    () => '',
    () => ({ status: 0, stdout: '', stderr: '' }),
  );

  const { selectedAudits, ticketId, gate, context } = await selectAudits({
    ticketId: 300,
    gate: 'gate2',
    provider,
  });

  assert.equal(ticketId, 300);
  assert.equal(gate, 'gate2');
  assert.equal(context.ticketTitle, 'Improve accessibility of modal dialogs');
  assert.ok(
    selectedAudits.includes('audit-lighthouse'),
    'accessibility keyword should select the lighthouse audit (which covers a11y)',
  );
});

test('selectAudits: glob filePattern from audit-rules.json selects an audit on a matching changed file', async () => {
  // Regression guard for the behaviour formerly asserted via the deleted
  // MCP-routed tests: selectAudits must apply the `triggers.filePatterns`
  // globs declared in audit-rules.json against the working tree's
  // changed files. We pick `audit-security` (manifest declares
  // `**/auth/*.js` under filePatterns) and a ticket whose title/body share
  // no manifest keywords, so the audit can only be selected by glob.
  const provider = new MockProvider({
    tickets: {
      400: {
        id: 400,
        title: 'Refactor billing module',
        body: 'No keyword overlap with the security/privacy/a11y audits.',
        labels: [],
      },
    },
  });

  const fakeGitSpawn = async () => ({
    status: 0,
    stdout: 'src/auth/login.js\n',
    stderr: '',
  });

  const { selectedAudits } = await selectAudits({
    ticketId: 400,
    gate: 'gate1',
    provider,
    injectedGitSpawn: fakeGitSpawn,
  });

  assert.ok(
    selectedAudits.includes('audit-security'),
    'changed file matching `**/auth/*.js` must select audit-security via the schema filePatterns rule',
  );
});

test('selectAudits: ETIMEDOUT returns the degraded envelope (default mode)', async () => {
  // Tech Spec #819 / Story #826 — historical behaviour was a silent
  // keyword-only fallback that hid the diff timeout from callers. The new
  // contract returns `{ ok: false, degraded: true, reason: 'GIT_DIFF_TIMEOUT', detail }`
  // so the caller can decide whether to abort or downgrade.
  const provider = new MockProvider({
    tickets: {
      301: {
        id: 301,
        title: 'Improve accessibility of dropdown menus',
        body: 'tab key behaviour broken',
        labels: [],
      },
    },
  });

  const neverResolves = () => new Promise(() => {});

  const result = await selectAudits({
    ticketId: 301,
    gate: 'gate2',
    provider,
    injectedGitSpawn: neverResolves,
    gitTimeoutMsOverride: 25,
    gateModeOpts: { argv: [], env: {} },
  });

  assert.equal(result.ok, false);
  assert.equal(result.degraded, true);
  assert.equal(result.reason, 'GIT_DIFF_TIMEOUT');
  assert.match(result.detail, /timed out after 25 ms/);
  assert.equal(result.selectedAudits, undefined);
});

test('selectAudits: ETIMEDOUT throws under --gate-mode (hard-fail closed)', async () => {
  const provider = new MockProvider({
    tickets: {
      302: {
        id: 302,
        title: 'Refactor module',
        body: '',
        labels: [],
      },
    },
  });

  const neverResolves = () => new Promise(() => {});

  await assert.rejects(
    () =>
      selectAudits({
        ticketId: 302,
        gate: 'gate2',
        provider,
        injectedGitSpawn: neverResolves,
        gitTimeoutMsOverride: 25,
        gateModeOpts: { argv: ['--gate-mode'], env: {} },
      }),
    (err) => {
      assert.equal(err.code, 'GIT_DIFF_TIMEOUT');
      assert.equal(err.degraded, true);
      return true;
    },
  );
});
