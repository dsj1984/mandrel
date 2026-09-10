/**
 * Story #5145 — the `--auto` sweep's cross-run ledger has to survive the
 * checkout that produced it.
 *
 * AC-1: `--ledger-commit` on a changed ledger produces exactly one branch, one
 *       ledger-only commit, one push and one `pr.create` with no auto-merge
 *       flag; `--dry-run` and an unchanged ledger produce none of it.
 * AC-2: without the flag, an unpersistable checkout says so — `ledger.unpersisted`
 *       in the summary plus a stderr line naming the ledger file.
 * AC-3: a failing push or `pr.create` exits non-zero naming the step, and only
 *       after the run summary has already been printed.
 *
 * Story #5281 — and it has to survive the retry an unattended sweep will make:
 * the branch is unique per base commit, cut from `origin/<base>`, the run
 * refuses (naming its step) off the base branch, restores the branch it started
 * on, and resumes a committed-but-unpushed ledger branch at push so a failed
 * push plus its retry open exactly one PR.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeTempDir } from '../../test-temp.js';
import { resolveLedgerSummary, runLedgerCommit } from '../ledger-commit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const CLI = path.join(REPO_ROOT, '.agents/scripts/audit-to-stories.js');

const LEDGER = 'baselines/audit-ledger.json';
const NOW = new Date('2026-09-05T12:00:00.000Z');

const FIXTURE = `# Audit: Security

## Executive Summary

Severity tally: Critical 0 / High 1 / Medium 0 / Low 0

## Detailed Findings

### SQLi in login handler
- **Severity:** High
- **Location:** \`src/auth/login.js:42\`
- **Dimension:** security
- **Current State:** The login query concatenates user input.
- **Recommendation:** Parameterise the query.
`;

/**
 * A `gitSync`-shaped recorder. `responses` maps the first argument of a git
 * invocation to canned stdout; `failOn` names a sub-command that throws, so a
 * step failure can be aimed precisely.
 */
function fakeGit({ responses = {}, failOn, refs = [] } = {}) {
  const calls = [];
  const known = new Set(refs);
  const git = (_cwd, ...args) => {
    calls.push(args);
    if (failOn && args[0] === failOn) {
      throw new Error(`git ${failOn} exploded`);
    }
    if (args[0] === 'rev-parse') {
      // `--verify --quiet <ref>` is the ref-existence probe; `--short <ref>`
      // is the base-sha read the branch name carries.
      const ref = args.at(-1);
      if (args.includes('--verify')) return known.has(ref) ? 'deadbee' : '';
      if (args.includes('--short')) return responses.short ?? 'abc1234';
    }
    return responses[args[0]] ?? '';
  };
  git.calls = calls;
  return git;
}

/** A `gh` facade exposing only the `pr.create` seam this module touches. */
function fakeGh({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    pr: {
      create: async (flags) => {
        calls.push(flags);
        if (fail) throw new Error('gh pr create exploded');
        return { stdout: 'https://github.com/o/r/pull/1' };
      },
    },
  };
}

/** git responses describing a dirty ledger on a pushable base branch. */
const CHANGED_ON_BASE = {
  status: ` M ${LEDGER}`,
  remote: 'origin\n',
  'rev-parse': 'main',
  short: 'abc1234',
};

/** The branch name those responses produce: dated, and qualified by the base. */
const BRANCH = 'chore/audit-ledger-2026-09-05-abc1234';

test('AC-1: a changed ledger yields one branch, one ledger-only commit, one push and one PR', async () => {
  const git = fakeGit({ responses: CHANGED_ON_BASE });
  const gh = fakeGh();

  const result = await runLedgerCommit({
    ledgerPath: LEDGER,
    baseBranch: 'main',
    cwd: '/repo',
    git,
    gh,
    now: NOW,
  });

  assert.equal(result.committed, true);
  assert.equal(result.branch, BRANCH);
  assert.equal(result.resumed, false);
  assert.equal(result.prUrl, 'https://github.com/o/r/pull/1');
  assert.equal(
    result.subject,
    'chore(audit): reconcile audit ledger 2026-09-05',
  );

  const writes = git.calls.filter(([verb]) =>
    ['fetch', 'checkout', 'add', 'commit', 'push'].includes(verb),
  );
  assert.deepEqual(writes, [
    ['fetch', 'origin', 'main'],
    ['checkout', '-b', BRANCH, 'origin/main'],
    ['add', '--', LEDGER],
    [
      'commit',
      '-m',
      'chore(audit): reconcile audit ledger 2026-09-05',
      '--',
      LEDGER,
    ],
    ['push', '--set-upstream', 'origin', BRANCH],
    // The branch the run started on is restored, so the operator's checkout is
    // where they left it.
    ['checkout', 'main'],
  ]);

  // The commit is scoped by pathspec, so it cannot pick up unrelated dirt.
  const commit = writes.find(([verb]) => verb === 'commit');
  assert.deepEqual(commit.slice(commit.indexOf('--')), ['--', LEDGER]);

  assert.equal(gh.calls.length, 1);
  const flags = gh.calls[0];
  assert.deepEqual(flags.slice(0, 4), ['--base', 'main', '--head', BRANCH]);
  // Auto-merge is never requested — a human lands the ledger PR.
  assert.ok(
    !flags.some((f) => /auto/i.test(f) && f.startsWith('--')),
    `unexpected auto-merge flag in ${JSON.stringify(flags)}`,
  );
});

test('AC-1: an unchanged ledger commits nothing and opens no PR', async () => {
  const git = fakeGit({
    responses: { remote: 'origin\n', 'rev-parse': 'main', short: 'abc1234' },
  });
  const gh = fakeGh();

  const result = await runLedgerCommit({
    ledgerPath: LEDGER,
    baseBranch: 'main',
    cwd: '/repo',
    git,
    gh,
    now: NOW,
  });

  assert.deepEqual(result, {
    committed: false,
    reason: 'ledger-unchanged',
    ledgerPath: LEDGER,
  });
  assert.equal(
    git.calls.some(([verb]) =>
      ['fetch', 'checkout', 'add', 'commit', 'push'].includes(verb),
    ),
    false,
  );
  assert.equal(gh.calls.length, 0);
});

test('AC-1: --dry-run never reaches the ledger-commit tail', async () => {
  const { runAuditToStories } = await import(pathToFileURL(CLI).href);
  const commits = [];

  await runAuditToStories(['--auto', '--dry-run', '--ledger-commit'], {
    runAutoImpl: async () => ({ summary: { mode: 'auto' }, stories: [] }),
    persistImpl: () => {},
    runLedgerCommitImpl: async (opts) => {
      commits.push(opts);
      return { committed: true };
    },
    stdout: { write: () => {} },
  });

  assert.deepEqual(commits, []);
});

test('AC-2: an unpersistable checkout reports ledger.unpersisted and warns by name', () => {
  const workDir = makeTempDir('audit-ledger-unpersisted-');
  fs.mkdirSync(path.join(workDir, 'audits'), { recursive: true });
  fs.writeFileSync(
    path.join(workDir, 'audits', 'audit-security-results.md'),
    FIXTURE,
  );
  // A repository with no `origin` remote — the ephemeral-clone shape.
  execFileSync('git', ['init', '--quiet'], { cwd: workDir });

  const proc = spawnSync(
    process.execPath,
    [CLI, '--auto', '--no-provider', '--glob', 'audits/*.md'],
    { cwd: workDir, encoding: 'utf8' },
  );

  assert.equal(proc.status, 0, proc.stderr);
  const summary = JSON.parse(proc.stdout.slice(proc.stdout.indexOf('{')));
  assert.equal(summary.ledger.unpersisted, true);
  assert.match(proc.stderr, /ledger not persisted/);
  assert.ok(
    proc.stderr.includes(LEDGER),
    `stderr must name ${LEDGER}: ${proc.stderr}`,
  );
});

test('AC-2: the summary is annotated and warned for every unpersistable shape', async () => {
  const warned = [];
  const logger = { warn: (m) => warned.push(m) };
  const summarise = (responses, extra = {}) =>
    resolveLedgerSummary({
      ledger: { path: LEDGER, suppressed: 0 },
      ledgerPath: LEDGER,
      cwd: '/repo',
      git: fakeGit({ responses }),
      logger,
      ...extra,
    });

  // HEAD parked off the base branch: a commit here reaches no shared state.
  const offBase = await summarise({
    status: ` M ${LEDGER}`,
    remote: 'origin\n',
    'rev-parse': 'story-1',
  });
  assert.equal(offBase.unpersisted, true);
  assert.equal(offBase.suppressed, 0, 'the plan ledger summary is preserved');
  assert.match(warned.at(-1), /not the base branch/);
  assert.ok(warned.at(-1).includes(LEDGER));

  // No remote at all — the ephemeral-clone shape.
  const noOrigin = await summarise({
    status: ` M ${LEDGER}`,
    'rev-parse': 'main',
  });
  assert.equal(noOrigin.unpersisted, true);
  assert.match(warned.at(-1), /no "origin" remote/);

  // Persistable: changed, on the base branch, with a remote to push to.
  const ok = await summarise(CHANGED_ON_BASE);
  assert.equal(ok.unpersisted, undefined);

  // Unchanged is never "unpersisted" — there is nothing to lose.
  const clean = await summarise({ remote: '', 'rev-parse': 'story-1' });
  assert.equal(clean.unpersisted, undefined);

  // --dry-run wrote nothing and --ledger-commit is about to persist it, so
  // neither probes git or warns at all.
  const before = warned.length;
  for (const extra of [{ dryRun: true }, { ledgerCommit: true }]) {
    const skipped = await summarise(
      { status: ` M ${LEDGER}`, 'rev-parse': 'story-1' },
      extra,
    );
    assert.equal(skipped.unpersisted, undefined);
  }
  assert.equal(warned.length, before, 'no warning on the skipped arms');
});

test('AC-3: a failing push or pr.create throws naming the failed step', async () => {
  await assert.rejects(
    runLedgerCommit({
      ledgerPath: LEDGER,
      baseBranch: 'main',
      cwd: '/repo',
      git: fakeGit({ responses: CHANGED_ON_BASE, failOn: 'push' }),
      gh: fakeGh(),
      now: NOW,
    }),
    /--ledger-commit failed at step "push-branch"/,
  );

  await assert.rejects(
    runLedgerCommit({
      ledgerPath: LEDGER,
      baseBranch: 'main',
      cwd: '/repo',
      git: fakeGit({ responses: CHANGED_ON_BASE }),
      gh: fakeGh({ fail: true }),
      now: NOW,
    }),
    /--ledger-commit failed at step "open-pull-request"/,
  );
});

test('AC-3: the run summary is printed before the ledger-commit failure', async () => {
  const { runAuditToStories } = await import(pathToFileURL(CLI).href);
  const persisted = [];

  await assert.rejects(
    runAuditToStories(['--auto', '--ledger-commit'], {
      runAutoImpl: async () => ({
        summary: { mode: 'auto', totals: { create: 1 } },
        stories: [],
      }),
      persistImpl: (text) => persisted.push(text),
      runLedgerCommitImpl: async () => {
        throw new Error('--ledger-commit failed at step "push-branch": boom');
      },
      stdout: { write: () => {} },
    }),
    /--ledger-commit failed at step "push-branch"/,
  );

  assert.equal(
    persisted.length,
    1,
    'summary must be persisted before the throw',
  );
  assert.match(persisted[0], /"mode": "auto"/);
});

// --- Story #5281: the retry an unattended sweep will actually make -----------

test('AC-4: a failed push then a retry opens exactly one PR and restores HEAD', async () => {
  // Run 1: the ledger is dirty, the branch is fresh, and the push explodes.
  const firstGit = fakeGit({ responses: CHANGED_ON_BASE, failOn: 'push' });
  const firstGh = fakeGh();
  await assert.rejects(
    runLedgerCommit({
      ledgerPath: LEDGER,
      baseBranch: 'main',
      cwd: '/repo',
      git: firstGit,
      gh: firstGh,
      now: NOW,
    }),
    /--ledger-commit failed at step "push-branch"/,
  );
  assert.equal(firstGh.calls.length, 0, 'a failed push opens no PR');
  assert.deepEqual(
    firstGit.calls.at(-1),
    ['checkout', 'main'],
    'HEAD is restored to the branch the run started on',
  );

  // Run 2, same day, same checkout: the ledger file is now CLEAN (its change is
  // committed on the branch run 1 left behind) and that branch was never
  // pushed. Reporting `ledger-unchanged` here is what used to strand the work.
  const retryGit = fakeGit({
    responses: { remote: 'origin\n', 'rev-parse': 'main', short: 'abc1234' },
    refs: [`refs/heads/${BRANCH}`],
  });
  const retryGh = fakeGh();
  const result = await runLedgerCommit({
    ledgerPath: LEDGER,
    baseBranch: 'main',
    cwd: '/repo',
    git: retryGit,
    gh: retryGh,
    now: NOW,
  });

  assert.equal(result.committed, true);
  assert.equal(result.resumed, true);
  assert.equal(result.branch, BRANCH);
  assert.equal(retryGh.calls.length, 1, 'the retry opens the only PR');
  // It resumes at push: no second branch, no second commit.
  assert.equal(
    retryGit.calls.some(([verb]) => ['commit', 'add'].includes(verb)),
    false,
  );
  assert.deepEqual(
    retryGit.calls.filter(([verb]) => verb === 'checkout'),
    [
      ['checkout', BRANCH],
      ['checkout', 'main'],
    ],
  );

  // One PR across both runs.
  assert.equal(firstGh.calls.length + retryGh.calls.length, 1);
});

test('AC-4: a ledger branch already pushed is not resumed', async () => {
  const git = fakeGit({
    responses: { remote: 'origin\n', 'rev-parse': 'main', short: 'abc1234' },
    refs: [`refs/heads/${BRANCH}`, `refs/remotes/origin/${BRANCH}`],
  });
  const gh = fakeGh();
  const result = await runLedgerCommit({
    ledgerPath: LEDGER,
    baseBranch: 'main',
    cwd: '/repo',
    git,
    gh,
    now: NOW,
  });
  assert.equal(result.committed, false);
  assert.equal(result.reason, 'ledger-unchanged');
  assert.equal(gh.calls.length, 0);
});

test('AC-5: HEAD off the base branch refuses by name and commits nothing', async () => {
  const git = fakeGit({
    responses: {
      status: ` M ${LEDGER}`,
      remote: 'origin\n',
      'rev-parse': 'story-1',
      short: 'abc1234',
    },
  });
  const gh = fakeGh();

  await assert.rejects(
    runLedgerCommit({
      ledgerPath: LEDGER,
      baseBranch: 'main',
      cwd: '/repo',
      git,
      gh,
      now: NOW,
    }),
    (err) => {
      assert.match(
        err.message,
        /--ledger-commit failed at step "verify-base-branch"/,
      );
      assert.match(err.message, /HEAD is on "story-1"/);
      return true;
    },
  );

  assert.equal(
    git.calls.some(([verb]) =>
      ['fetch', 'checkout', 'add', 'commit', 'push'].includes(verb),
    ),
    false,
    'the refusal happens before any write',
  );
  assert.equal(gh.calls.length, 0);
});

test('AC-5: a checkout with no origin refuses by name before writing', async () => {
  const git = fakeGit({
    responses: { status: ` M ${LEDGER}`, 'rev-parse': 'main', short: 'a1' },
  });
  await assert.rejects(
    runLedgerCommit({
      ledgerPath: LEDGER,
      baseBranch: 'main',
      cwd: '/repo',
      git,
      gh: fakeGh(),
      now: NOW,
    }),
    /--ledger-commit failed at step "verify-origin"/,
  );
  assert.equal(
    git.calls.some(([verb]) => ['commit', 'push'].includes(verb)),
    false,
  );
});

test('AC-6: the tail names the branch and PR on success, and the reason on a skip', async () => {
  const { runAuditToStories } = await import(pathToFileURL(CLI).href);
  const warned = [];
  // Capture at the Logger seam, not at `console.warn`: scripts under
  // `.agents/scripts/` route human-facing output through Logger, and the
  // enforcement guard reads a raw `console.*` here as a boundary violation.
  const { Logger } = await import('../../Logger.js');
  const originalWarn = Logger.warn;
  Logger.warn = (message) => warned.push(String(message));
  try {
    await runAuditToStories(['--auto', '--ledger-commit'], {
      runAutoImpl: async () => ({ summary: { mode: 'auto' }, stories: [] }),
      persistImpl: () => {},
      runLedgerCommitImpl: async () => ({
        committed: true,
        branch: BRANCH,
        prUrl: 'https://github.com/o/r/pull/7',
        ledgerPath: LEDGER,
      }),
      stdout: { write: () => {} },
    });
    await runAuditToStories(['--auto', '--ledger-commit'], {
      runAutoImpl: async () => ({ summary: { mode: 'auto' }, stories: [] }),
      persistImpl: () => {},
      runLedgerCommitImpl: async () => ({
        committed: false,
        reason: 'ledger-unchanged',
        ledgerPath: LEDGER,
      }),
      stdout: { write: () => {} },
    });
  } finally {
    Logger.warn = originalWarn;
  }

  const success = warned.find((line) => line.includes('pushed'));
  assert.ok(success, `expected a success line in ${JSON.stringify(warned)}`);
  assert.ok(success.includes(BRANCH));
  assert.ok(success.includes('https://github.com/o/r/pull/7'));

  const skip = warned.find((line) => line.includes('skipped'));
  assert.ok(skip, `expected a skip line in ${JSON.stringify(warned)}`);
  assert.ok(skip.includes('ledger-unchanged'));
  assert.ok(skip.includes(LEDGER));
});

test('AC-7: --severity refuses a value the filter would silently ignore', async () => {
  const { runAuditToStories } = await import(pathToFileURL(CLI).href);
  await assert.rejects(
    runAuditToStories(['--scan', '--severity', 'Hgh', '--no-provider'], {
      stdout: { write: () => {} },
    }),
    (err) => {
      assert.match(err.message, /--severity "Hgh" is not a severity/);
      assert.match(err.message, /critical, high, medium, low/);
      return true;
    },
  );
});

test('AC-6: the tail reports a resumed branch and a missing PR URL honestly', async () => {
  const { runAuditToStories } = await import(pathToFileURL(CLI).href);
  const { Logger } = await import('../../Logger.js');
  const warned = [];
  const originalWarn = Logger.warn;
  Logger.warn = (message) => warned.push(String(message));
  try {
    await runAuditToStories(['--auto', '--ledger-commit'], {
      runAutoImpl: async () => ({ summary: { mode: 'auto' }, stories: [] }),
      persistImpl: () => {},
      runLedgerCommitImpl: async () => ({
        committed: true,
        resumed: true,
        branch: BRANCH,
        prUrl: null,
        ledgerPath: LEDGER,
      }),
      stdout: { write: () => {} },
    });
  } finally {
    Logger.warn = originalWarn;
  }
  const line = warned.find((l) => l.includes('pushed'));
  assert.match(line, /resumed an unpushed ledger branch/);
  assert.match(line, /\(no URL reported by gh\)/);
});

test('AC-7: --severity all is accepted verbatim and a canonical level normalises', async () => {
  const { runAuditToStories } = await import(pathToFileURL(CLI).href);
  const seen = [];
  const scan = async (severity) => {
    await runAuditToStories(
      [
        '--scan',
        '--no-provider',
        '--severity',
        severity,
        '--glob',
        'none/*.md',
      ],
      {
        buildPlanImpl: (args) => {
          seen.push(args.severity);
          return { groups: [], findings: [], summary: {} };
        },
        stdout: { write: () => {} },
      },
    );
  };
  await scan('all');
  await scan('High');
  assert.deepEqual(seen, ['all', 'high']);
});
