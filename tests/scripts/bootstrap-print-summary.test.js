/**
 * bootstrap-print-summary.test — Story #2459 / Task #2472
 *
 * Pins `renderSummary` to byte-identical output across four fixture
 * shapes:
 *
 *   1. `success`          — full report; every section emits its happy path.
 *   2. `skipped-quality`  — `report.quality.skipped === true` (the
 *                            quality-gates bootstrap was skipped via
 *                            `--skip-quality`).
 *   3. `skipped-winperf`  — `report.winPerf.skipped === true` (non-Windows
 *                            host, the Windows git-perf check was skipped).
 *   4. `github-error`     — GitHub bootstrap surfaced an error and the
 *                            report carries `{ error }` instead of the
 *                            normal envelope.
 *
 * The expected strings reproduce the exact lines the original
 * inline-ladder `printSummary` emitted before the SECTIONS refactor — any
 * future drift fails this test.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderSummary, SECTIONS } from '../../.agents/scripts/bootstrap.js';

function makeReport(overrides = {}) {
  const base = {
    pkg: {
      created: false,
      scriptsSyncCommands: 'added',
      scriptsPrepare: 'appended',
      deps: { added: ['ajv', 'picomatch'], skipped: [] },
    },
    install: { ran: true, manager: 'npm', skipped: false },
    agentrc: { action: 'seeded' },
    claudeSettings: { action: 'merged' },
    gitignore: { commands: 'added', mcp: 'added' },
    parity: { ok: true, missingCommand: [], orphanCommand: [] },
    quality: {
      skipped: false,
      helper: { action: 'created' },
      hook: { action: 'merged' },
      scripts: { action: 'added' },
      config: { action: 'created' },
    },
    winPerf: { platform: 'win32', skipped: false, ok: true, stdout: '' },
    github: {
      labels: { created: ['type::epic', 'type::story'], skipped: [] },
      project: { projectId: 'PVT_x', projectNumber: 1, created: false },
      branchProtection: { status: 'configured' },
      mergeMethods: { status: 'configured' },
    },
  };
  return { ...base, ...overrides };
}

describe('renderSummary — byte-identical snapshots', () => {
  it('emits the full happy-path summary unchanged', () => {
    const expected = [
      '',
      '=== Bootstrap Summary ===',
      '  package.json           created=false sync:commands=added prepare=appended deps+=2',
      '  install                ran via npm',
      '  .agentrc.json          seeded',
      '  .claude/settings.json  merged',
      '  .gitignore commands    added',
      '  .gitignore mcp         added',
      '  parity                 OK',
      '  quality.helper         created',
      '  quality.hook           merged',
      '  quality.scripts        added',
      '  quality.config         created',
      '  windows-git-perf       OK',
      '  github.labels          created=2 skipped=0',
      '  github.project         1',
      '  github.branchProtection configured',
      '  github.mergeMethods    configured',
    ].join('\n');
    assert.equal(renderSummary(makeReport()), expected);
  });

  it('emits the "quality skipped" line and suppresses the four expansion rows', () => {
    const expected = [
      '',
      '=== Bootstrap Summary ===',
      '  package.json           created=false sync:commands=added prepare=appended deps+=2',
      '  install                ran via npm',
      '  .agentrc.json          seeded',
      '  .claude/settings.json  merged',
      '  .gitignore commands    added',
      '  .gitignore mcp         added',
      '  parity                 OK',
      '  quality                skipped',
      '  windows-git-perf       OK',
      '  github.labels          created=2 skipped=0',
      '  github.project         1',
      '  github.branchProtection configured',
      '  github.mergeMethods    configured',
    ].join('\n');
    assert.equal(
      renderSummary(makeReport({ quality: { skipped: true } })),
      expected,
    );
  });

  it('emits the "skipped (<platform>)" line for the windows-git-perf section on non-Windows', () => {
    const expected = [
      '',
      '=== Bootstrap Summary ===',
      '  package.json           created=false sync:commands=added prepare=appended deps+=2',
      '  install                ran via npm',
      '  .agentrc.json          seeded',
      '  .claude/settings.json  merged',
      '  .gitignore commands    added',
      '  .gitignore mcp         added',
      '  parity                 OK',
      '  quality.helper         created',
      '  quality.hook           merged',
      '  quality.scripts        added',
      '  quality.config         created',
      '  windows-git-perf       skipped (linux)',
      '  github.labels          created=2 skipped=0',
      '  github.project         1',
      '  github.branchProtection configured',
      '  github.mergeMethods    configured',
    ].join('\n');
    assert.equal(
      renderSummary(
        makeReport({
          winPerf: { platform: 'linux', skipped: true },
        }),
      ),
      expected,
    );
  });

  it('emits the bare "github skipped" line when report.github is falsy', () => {
    const expected = [
      '',
      '=== Bootstrap Summary ===',
      '  package.json           created=false sync:commands=added prepare=appended deps+=2',
      '  install                ran via npm',
      '  .agentrc.json          seeded',
      '  .claude/settings.json  merged',
      '  .gitignore commands    added',
      '  .gitignore mcp         added',
      '  parity                 OK',
      '  quality.helper         created',
      '  quality.hook           merged',
      '  quality.scripts        added',
      '  quality.config         created',
      '  windows-git-perf       OK',
      '  github                 skipped',
    ].join('\n');
    assert.equal(renderSummary(makeReport({ github: null })), expected);
  });
});

describe('SECTIONS shape', () => {
  it('is a frozen array of {name, render} entries', () => {
    assert.ok(Array.isArray(SECTIONS));
    assert.ok(Object.isFrozen(SECTIONS));
    for (const s of SECTIONS) {
      assert.equal(typeof s.name, 'string');
      assert.equal(typeof s.render, 'function');
    }
  });

  it('lists every logical section in canonical order', () => {
    const names = SECTIONS.map((s) => s.name);
    assert.deepEqual(names, [
      'banner',
      'package.json',
      'install',
      'agentrc',
      'claudeSettings',
      'gitignore.commands',
      'gitignore.mcp',
      'parity',
      'quality',
      'winPerf',
      'github',
    ]);
  });
});
