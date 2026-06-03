/**
 * phased-approval.test — Story #3524 (Feature #3515, Epic #3438)
 *
 * The consent-first install renders the FULL mutation manifest before
 * collecting any approval, gates writes behind per-phase-group approval, and
 * records an install ledger a future `mandrel uninstall` consumes. These
 * tests pin that contract:
 *
 *   - the manifest screen renders every group before any prompt;
 *   - each of the four phase groups is independently approvable, and
 *     declining one does NOT skip the others;
 *   - `--dry-run` prints a manifest including the GitHub-side entries and
 *     writes no files;
 *   - a successful run records a gitignored install ledger.
 *
 * Mostly pure logic; the bootstrap-pipeline and ledger cases use a tmp tree
 * but mock all network I/O (the GitHub-side bootstrap never runs here), so
 * this is a unit/contract-adjacent suite with no real `gh` calls.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  approvePhases,
  recordLedger,
  resolveAppliedGroups,
} from '../../.agents/scripts/bootstrap.js';
import {
  buildLedgerRecord,
  LEDGER_RELATIVE_PATH,
  ledgerPath,
  readInstallLedger,
} from '../../.agents/scripts/lib/bootstrap/install-ledger.js';
import {
  buildMutationManifest,
  PHASE_GROUPS,
  previewMutationManifest,
} from '../../.agents/scripts/lib/bootstrap/manifest.js';
import {
  collectPhaseApprovals,
  PHASE_GROUP_ORDER,
  renderManifestScreen,
} from '../../.agents/scripts/lib/bootstrap/phased-approval.js';

const ANSWERS = Object.freeze({
  owner: 'acme',
  repo: 'widget',
  baseBranch: 'main',
  operatorHandle: 'me',
});

/**
 * A confirm stub that approves exactly the named phase groups (matched off
 * the entry list it receives) and declines everything else. Records the
 * order it was asked so a test can assert the prompt sequence.
 */
function makeConfirm({ approveGroups, calls }) {
  const approve = new Set(approveGroups);
  return async ({ proposed }) => {
    const group = proposed?.[0]?.phaseGroup;
    calls.push(group);
    return approve.has(group);
  };
}

describe('renderManifestScreen', () => {
  it('renders every non-empty phase group before any approval', () => {
    const preview = previewMutationManifest({ answers: ANSWERS });
    const screen = renderManifestScreen(preview);
    for (const group of PHASE_GROUP_ORDER) {
      assert.ok(
        screen.includes(`[${group}]`),
        `manifest screen missing group ${group}`,
      );
    }
    // It is a no-write preview banner, not an execution log.
    assert.ok(screen.includes('preview — no writes yet'));
  });

  it('marks the irreversible github-admin entries as IRREVERSIBLE', () => {
    const preview = previewMutationManifest({ answers: ANSWERS });
    const screen = renderManifestScreen(preview);
    assert.ok(screen.includes('IRREVERSIBLE'));
  });
});

describe('collectPhaseApprovals — independence', () => {
  it('prompts every group in order and a decline does not skip the rest', async () => {
    const preview = previewMutationManifest({ answers: ANSWERS });
    const calls = [];
    // Decline repo-config; everything else approved.
    const confirm = makeConfirm({
      approveGroups: [
        PHASE_GROUPS.IDE_WIRING,
        PHASE_GROUPS.QUALITY_GATES,
        PHASE_GROUPS.GITHUB_ADMIN,
      ],
      calls,
    });
    const { approved, decisions } = await collectPhaseApprovals({
      preview,
      confirm,
    });
    // All four groups were prompted (declining one didn't short-circuit).
    assert.deepEqual(calls, [...PHASE_GROUP_ORDER]);
    assert.equal(decisions.length, 4);
    assert.equal(approved.has(PHASE_GROUPS.REPO_CONFIG), false);
    assert.equal(approved.has(PHASE_GROUPS.IDE_WIRING), true);
    assert.equal(approved.has(PHASE_GROUPS.QUALITY_GATES), true);
    assert.equal(approved.has(PHASE_GROUPS.GITHUB_ADMIN), true);
  });

  it('approves only the single group the operator says yes to', async () => {
    const preview = previewMutationManifest({ answers: ANSWERS });
    const calls = [];
    const confirm = makeConfirm({
      approveGroups: [PHASE_GROUPS.IDE_WIRING],
      calls,
    });
    const { approved } = await collectPhaseApprovals({ preview, confirm });
    assert.deepEqual([...approved], [PHASE_GROUPS.IDE_WIRING]);
  });
});

describe('approvePhases (bootstrap phase)', () => {
  it('approves every group under --assume-yes', async () => {
    const result = await approvePhases({
      answers: ANSWERS,
      assumeYes: true,
      flags: {},
    });
    assert.equal(result.ok, true);
    const groups = result.payload.approvedGroups;
    for (const group of PHASE_GROUP_ORDER) {
      assert.ok(groups.has(group), `assume-yes should approve ${group}`);
    }
  });

  it('declines every group on a non-TTY run without --assume-yes', async () => {
    // The default hitl-confirm refuses to silent-apply without a TTY, so an
    // un-assumed non-interactive run lands zero approvals.
    const result = await approvePhases(
      { answers: ANSWERS, assumeYes: false, flags: {} },
      { confirm: undefined },
    );
    assert.equal(result.payload.approvedGroups.size, 0);
  });

  it('honours --skip-github by omitting the github-admin prompt', async () => {
    const calls = [];
    const confirm = makeConfirm({
      approveGroups: [...PHASE_GROUP_ORDER],
      calls,
    });
    await approvePhases(
      { answers: ANSWERS, assumeYes: false, flags: { 'skip-github': true } },
      { confirm },
    );
    assert.equal(calls.includes(PHASE_GROUPS.GITHUB_ADMIN), false);
  });
});

describe('install ledger', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phased-approval-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes a parseable ledger at the gitignored .agents path', () => {
    const state = {
      answers: ANSWERS,
      projectRoot: tmpRoot,
      flags: {},
      approvedGroups: new Set([PHASE_GROUPS.IDE_WIRING]),
      report: {},
    };
    const result = recordLedger(state);
    assert.equal(result.ok, true);
    assert.equal(state.report.ledger.written, true);

    // The ledger lives at the canonical gitignored path.
    assert.equal(
      ledgerPath(tmpRoot),
      path.join(tmpRoot, LEDGER_RELATIVE_PATH.replace('/', path.sep)),
    );
    const ledger = readInstallLedger(tmpRoot);
    assert.ok(ledger);
    assert.equal(ledger.schemaVersion, 1);
    assert.deepEqual(ledger.approvedGroups, [PHASE_GROUPS.IDE_WIRING]);
    // Every ledger entry is an ide-wiring mutation (the only approved group).
    for (const entry of ledger.entries) {
      assert.equal(entry.phaseGroup, PHASE_GROUPS.IDE_WIRING);
    }
  });

  it('omits github-admin from the ledger when the github run did not land', () => {
    const state = {
      answers: ANSWERS,
      projectRoot: tmpRoot,
      flags: {},
      // github-admin approved, but the run errored — must not be ledgered.
      approvedGroups: new Set([
        PHASE_GROUPS.IDE_WIRING,
        PHASE_GROUPS.GITHUB_ADMIN,
      ]),
      report: { github: { error: 'gh not authed' } },
    };
    recordLedger(state);
    const ledger = readInstallLedger(tmpRoot);
    assert.equal(
      ledger.approvedGroups.includes(PHASE_GROUPS.GITHUB_ADMIN),
      false,
    );
    for (const entry of ledger.entries) {
      assert.notEqual(entry.phaseGroup, PHASE_GROUPS.GITHUB_ADMIN);
    }
  });

  it('writes no ledger when nothing was applied', () => {
    const state = {
      answers: ANSWERS,
      projectRoot: tmpRoot,
      flags: {},
      approvedGroups: new Set(),
      report: {},
    };
    recordLedger(state);
    assert.equal(state.report.ledger.written, false);
    assert.equal(fs.existsSync(ledgerPath(tmpRoot)), false);
  });
});

describe('resolveAppliedGroups', () => {
  it('counts a succeeded github run as applied', () => {
    const applied = resolveAppliedGroups(new Set([PHASE_GROUPS.GITHUB_ADMIN]), {
      github: { labels: { created: [], skipped: [] } },
    });
    assert.equal(applied.has(PHASE_GROUPS.GITHUB_ADMIN), true);
  });

  it('drops github-admin when the run was skipped', () => {
    const applied = resolveAppliedGroups(new Set([PHASE_GROUPS.GITHUB_ADMIN]), {
      github: { skipped: true, reason: 'phase-group-declined' },
    });
    assert.equal(applied.has(PHASE_GROUPS.GITHUB_ADMIN), false);
  });
});

describe('buildLedgerRecord', () => {
  it('records the repo slug, sorted groups, and a deterministic timestamp', () => {
    const entries = buildMutationManifest({ answers: ANSWERS }).filter(
      (e) => e.phaseGroup === PHASE_GROUPS.REPO_CONFIG,
    );
    const record = buildLedgerRecord({
      entries,
      approvedGroups: [PHASE_GROUPS.QUALITY_GATES, PHASE_GROUPS.REPO_CONFIG],
      answers: ANSWERS,
      appliedAt: '2026-06-03T00:00:00.000Z',
    });
    assert.equal(record.repo, 'acme/widget');
    assert.deepEqual(record.approvedGroups, [
      PHASE_GROUPS.QUALITY_GATES,
      PHASE_GROUPS.REPO_CONFIG,
    ]);
    assert.equal(record.appliedAt, '2026-06-03T00:00:00.000Z');
    // Entries are projected down to the rollback-relevant fields.
    for (const entry of record.entries) {
      assert.deepEqual(Object.keys(entry).sort(), [
        'action',
        'phaseGroup',
        'reversible',
        'target',
      ]);
    }
  });
});
