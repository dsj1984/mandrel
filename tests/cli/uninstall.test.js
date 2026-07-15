// tests/cli/uninstall.test.js
/**
 * Unit tests for lib/cli/uninstall.js — the `mandrel uninstall` subcommand.
 *
 * Strategy: stand up a real tmp project tree mirroring exactly what the
 * consent-first bootstrap leaves behind (the install ledger plus the
 * mutated files), run `runUninstall` against that root with a captured
 * write/exit, and assert the reversal undoes the install while preserving
 * any pre-existing user content. The filesystem is a throwaway tmp dir
 * (created in beforeEach, removed in afterEach) — no network, no shared
 * state — so this is a unit test of the reversal logic per
 * testing-standards.md.
 *
 * Acceptance contract (Story #3525):
 *   1. node --test tests/cli/uninstall.test.js exits 0
 *   2. uninstall removes install-added npm scripts, the pre-commit hook,
 *      the CLAUDE.md import block, and the generated slash-command files
 *   3. a CLAUDE.md / agentrc key / settings hook present before install is
 *      left intact after uninstall
 *   4. GitHub-side settings are untouched unless --include-github is passed
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  LEDGER_SCHEMA_VERSION,
  ledgerPath,
} from '../../.agents/scripts/lib/bootstrap/install-ledger.js';
import {
  BOOTSTRAP_COMMAND,
  GITIGNORE_BLOCKS,
  SYNC_COMMAND,
  SYSTEM_PROMPT_BLOCK,
  SYSTEM_PROMPT_CLAUDE_MD,
  SYSTEM_PROMPT_IMPORT,
} from '../../.agents/scripts/lib/bootstrap/project-bootstrap.js';
import {
  DOWNSTREAM_PRE_COMMIT,
  PRE_COMMIT_MARKER,
  QUALITY_NPM_SCRIPTS,
} from '../../.agents/scripts/lib/bootstrap/quality-bootstrap.js';
import uninstall, {
  planUninstall,
  runUninstall,
} from '../../lib/cli/uninstall.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpRoot;

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** The full set of reversible local-file ledger entries the install records. */
function reversibleEntries() {
  return [
    {
      phaseGroup: 'ide-wiring',
      target: 'CLAUDE.md',
      action: 'merge',
      reversible: true,
    },
    {
      phaseGroup: 'ide-wiring',
      target: '.claude/settings.json',
      action: 'merge',
      reversible: true,
    },
    {
      phaseGroup: 'ide-wiring',
      target: '.claude/plugins/mandrel',
      action: 'run',
      reversible: true,
    },
    {
      phaseGroup: 'ide-wiring',
      target: '.gitignore',
      action: 'merge',
      reversible: true,
    },
    {
      phaseGroup: 'repo-config',
      target: 'package.json',
      action: 'merge',
      reversible: true,
    },
    {
      phaseGroup: 'repo-config',
      target: '.agentrc.json',
      action: 'create',
      reversible: true,
      // Schema v2 (Story #3895): the live `agentrc` phase outcome. A fresh
      // install seeds the file from the starter → `seeded`, which is the only
      // outcome that authorizes deletion on uninstall.
      executedAction: 'seeded',
    },
    {
      phaseGroup: 'quality-gates',
      target: '.husky/pre-commit',
      action: 'configure',
      reversible: true,
    },
  ];
}

/** The irreversible github-admin entries the install records. */
function githubEntries() {
  return [
    {
      phaseGroup: 'github-admin',
      target: 'acme/widgets labels',
      action: 'create',
      reversible: false,
    },
    {
      phaseGroup: 'github-admin',
      target: 'acme/widgets branch protection',
      action: 'configure',
      reversible: false,
    },
  ];
}

function writeLedger(
  root,
  { entries, schemaVersion = LEDGER_SCHEMA_VERSION } = {},
) {
  writeJson(ledgerPath(root), {
    schemaVersion,
    appliedAt: '2026-06-03T00:00:00.000Z',
    repo: 'acme/widgets',
    approvedGroups: [
      'ide-wiring',
      'repo-config',
      'quality-gates',
      'github-admin',
    ],
    entries: entries ?? [...reversibleEntries(), ...githubEntries()],
  });
}

/**
 * Materialize a fresh-install tree (no pre-existing user content): every file
 * is exactly what the bootstrap would author from nothing.
 */
function seedFreshInstall(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'CLAUDE.md'),
    SYSTEM_PROMPT_CLAUDE_MD,
    'utf8',
  );
  writeJson(path.join(root, '.claude', 'settings.json'), {
    extraKnownMarketplaces: {
      mandrel: { source: { source: 'directory', path: './.claude' } },
    },
    enabledPlugins: { 'mandrel@mandrel': true },
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: SYNC_COMMAND }] },
      ],
    },
  });
  const cmdDir = path.join(root, '.claude', 'plugins', 'mandrel', 'commands');
  fs.mkdirSync(cmdDir, { recursive: true });
  fs.writeFileSync(
    path.join(cmdDir, 'epic-deliver.md'),
    '# generated\n',
    'utf8',
  );
  fs.writeFileSync(path.join(cmdDir, 'doctor.md'), '# generated\n', 'utf8');
  fs.mkdirSync(path.join(root, '.claude', '.claude-plugin'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, '.claude', '.claude-plugin', 'marketplace.json'),
    '{}\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, '.gitignore'),
    `${GITIGNORE_BLOCKS.commands.block}${GITIGNORE_BLOCKS.mcp.block}`,
    'utf8',
  );
  writeJson(path.join(root, 'package.json'), {
    name: 'fresh',
    version: '0.0.0',
    type: 'module',
    scripts: {
      'sync:commands': SYNC_COMMAND,
      prepare: SYNC_COMMAND,
      bootstrap: BOOTSTRAP_COMMAND,
      ...QUALITY_NPM_SCRIPTS,
    },
  });
  writeJson(path.join(root, '.agentrc.json'), {
    $schema: './.agents/schemas/agentrc.schema.json',
    github: { owner: 'acme', repo: 'widgets' },
  });
  fs.mkdirSync(path.join(root, '.husky'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.husky', 'pre-commit'),
    DOWNSTREAM_PRE_COMMIT,
    'utf8',
  );
  writeLedger(root);
}

function makeCapture() {
  const lines = [];
  let exitCode = null;
  return {
    lines,
    get text() {
      return lines.join('');
    },
    get exitCode() {
      return exitCode;
    },
    write: (s) => lines.push(s),
    exit: (code) => {
      exitCode = code;
    },
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('uninstall module exports', () => {
  it('exports runUninstall and planUninstall as named exports', () => {
    assert.equal(typeof runUninstall, 'function');
    assert.equal(typeof planUninstall, 'function');
  });

  it('exports a default function for bin/mandrel.js dispatch', () => {
    assert.equal(typeof uninstall, 'function');
  });
});

// ---------------------------------------------------------------------------
// planUninstall — pure partitioning over the ledger
// ---------------------------------------------------------------------------

describe('planUninstall', () => {
  it('dedupes file targets and routes irreversible entries to manual', () => {
    const ledger = {
      entries: [
        { target: 'package.json', reversible: true },
        { target: 'package.json', reversible: true }, // repo-config + quality both touch it
        { target: 'CLAUDE.md', reversible: true },
        { target: 'acme/widgets labels', reversible: false },
      ],
    };
    const { fileTargets, manual } = planUninstall(ledger);
    assert.deepEqual(fileTargets, ['package.json', 'CLAUDE.md']);
    assert.equal(manual.length, 1);
    assert.equal(manual[0].target, 'acme/widgets labels');
  });

  it('surfaces a reversible entry with no handler as a manual follow-up', () => {
    const ledger = {
      entries: [{ target: 'some/unknown/target', reversible: true }],
    };
    const { fileTargets, manual } = planUninstall(ledger);
    assert.deepEqual(fileTargets, []);
    assert.equal(manual.length, 1);
  });
});

// ---------------------------------------------------------------------------
// AC2 — fresh install reversal
// ---------------------------------------------------------------------------

describe('runUninstall — fresh install (AC2)', () => {
  it('removes npm scripts, pre-commit hook, CLAUDE.md import, and slash commands', () => {
    seedFreshInstall(tmpRoot);
    const cap = makeCapture();

    const result = runUninstall({
      projectRoot: tmpRoot,
      write: cap.write,
      exit: cap.exit,
    });

    assert.equal(cap.exitCode, 0);
    assert.equal(result.ledgerFound, true);

    // CLAUDE.md was install-authored (only the framework block) → removed.
    assert.equal(fs.existsSync(path.join(tmpRoot, 'CLAUDE.md')), false);
    // Generated plugin command surface is gone.
    assert.equal(
      fs.existsSync(path.join(tmpRoot, '.claude', 'plugins', 'mandrel')),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(tmpRoot, '.claude', '.claude-plugin')),
      false,
    );
    // Install-authored settings.json (only the sync hook) is removed.
    assert.equal(
      fs.existsSync(path.join(tmpRoot, '.claude', 'settings.json')),
      false,
    );
    // pre-commit hook (framework-only) is removed.
    assert.equal(
      fs.existsSync(path.join(tmpRoot, '.husky', 'pre-commit')),
      false,
    );
    // package.json framework scripts are gone.
    const pkg = readJson(path.join(tmpRoot, 'package.json'));
    assert.equal(pkg.scripts, undefined);
    assert.equal(pkg.name, 'fresh'); // operator fields preserved
    // Install-created .agentrc.json is removed.
    assert.equal(fs.existsSync(path.join(tmpRoot, '.agentrc.json')), false);
    // The ledger itself is removed so a re-run is a no-op.
    assert.equal(fs.existsSync(ledgerPath(tmpRoot)), false);
  });

  it('is idempotent — a second run reports no ledger', () => {
    seedFreshInstall(tmpRoot);
    runUninstall({ projectRoot: tmpRoot, write: () => {}, exit: () => {} });

    const cap = makeCapture();
    runUninstall({ projectRoot: tmpRoot, write: cap.write, exit: cap.exit });
    assert.equal(cap.exitCode, 0);
    assert.match(cap.text, /No install ledger found/);
  });
});

// ---------------------------------------------------------------------------
// AC3 — pre-existing user content is preserved
// ---------------------------------------------------------------------------

describe('runUninstall — preserves pre-existing content (AC3)', () => {
  it('keeps an operator CLAUDE.md, strips only the framework import block', () => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    const operatorClaude = `# My Project Guide\n\nProject-specific notes the operator wrote.\n\n${SYSTEM_PROMPT_BLOCK}`;
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), operatorClaude, 'utf8');
    writeLedger(tmpRoot, {
      entries: [{ target: 'CLAUDE.md', reversible: true }],
    });

    runUninstall({ projectRoot: tmpRoot, write: () => {}, exit: () => {} });

    const after = fs.readFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'utf8');
    assert.match(after, /My Project Guide/);
    assert.match(after, /Project-specific notes/);
    assert.equal(after.includes(SYSTEM_PROMPT_IMPORT), false);
  });

  it('keeps an operator settings hook, removes only the sync hook', () => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    writeJson(path.join(tmpRoot, '.claude', 'settings.json'), {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'echo operator-hook' }] },
          { hooks: [{ type: 'command', command: SYNC_COMMAND }] },
        ],
      },
    });
    writeLedger(tmpRoot, {
      entries: [{ target: '.claude/settings.json', reversible: true }],
    });

    runUninstall({ projectRoot: tmpRoot, write: () => {}, exit: () => {} });

    const settings = readJson(path.join(tmpRoot, '.claude', 'settings.json'));
    const cmds = settings.hooks.UserPromptSubmit.flatMap((g) =>
      g.hooks.map((h) => h.command),
    );
    assert.deepEqual(cmds, ['echo operator-hook']);
  });

  it('keeps operator package.json scripts and an overridden framework key', () => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    writeJson(path.join(tmpRoot, 'package.json'), {
      name: 'operator-app',
      scripts: {
        test: 'vitest',
        bootstrap: 'echo my-own-bootstrap', // operator overrode the key
        'sync:commands': SYNC_COMMAND, // framework value → removable
        prepare: `husky && ${SYNC_COMMAND}`, // appended fragment → strip only fragment
      },
    });
    writeLedger(tmpRoot, {
      entries: [{ target: 'package.json', reversible: true }],
    });

    runUninstall({ projectRoot: tmpRoot, write: () => {}, exit: () => {} });

    const pkg = readJson(path.join(tmpRoot, 'package.json'));
    assert.equal(pkg.scripts.test, 'vitest');
    assert.equal(pkg.scripts.bootstrap, 'echo my-own-bootstrap'); // preserved
    assert.equal(pkg.scripts['sync:commands'], undefined); // removed
    assert.equal(pkg.scripts.prepare, 'husky'); // fragment stripped
  });

  it('keeps an operator .gitignore line while removing framework entries', () => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.gitignore'),
      `node_modules/\ndist/\n${GITIGNORE_BLOCKS.commands.block}${GITIGNORE_BLOCKS.mcp.block}`,
      'utf8',
    );
    writeLedger(tmpRoot, {
      entries: [{ target: '.gitignore', reversible: true }],
    });

    runUninstall({ projectRoot: tmpRoot, write: () => {}, exit: () => {} });

    const gi = fs.readFileSync(path.join(tmpRoot, '.gitignore'), 'utf8');
    assert.match(gi, /node_modules\//);
    assert.match(gi, /dist\//);
    assert.equal(gi.includes('.claude/commands/'), false);
    assert.equal(gi.includes('.mcp.json'), false);
  });

  it('leaves a custom pre-commit hook in place, stripping only the quality line', () => {
    fs.mkdirSync(path.join(tmpRoot, '.husky'), { recursive: true });
    const custom = `#!/bin/sh\nnpm run my-custom-check\n${PRE_COMMIT_MARKER}\n`;
    fs.writeFileSync(
      path.join(tmpRoot, '.husky', 'pre-commit'),
      custom,
      'utf8',
    );
    writeLedger(tmpRoot, {
      entries: [{ target: '.husky/pre-commit', reversible: true }],
    });

    runUninstall({ projectRoot: tmpRoot, write: () => {}, exit: () => {} });

    const hook = fs.readFileSync(
      path.join(tmpRoot, '.husky', 'pre-commit'),
      'utf8',
    );
    assert.match(hook, /my-custom-check/);
    assert.equal(hook.includes(PRE_COMMIT_MARKER), false);
  });
});

// ---------------------------------------------------------------------------
// Story #3541 — heading-only / comment-only operator content is preserved
// ---------------------------------------------------------------------------

describe('runUninstall — heading-only and comment-only operator content (Story #3541)', () => {
  it('preserves a CLAUDE.md whose only non-framework content is markdown headings', () => {
    // Operator wrote a CLAUDE.md that is nothing but headings before install.
    // The install appended SYSTEM_PROMPT_BLOCK — uninstall must strip the block
    // and keep the headings rather than deleting the file.
    fs.mkdirSync(tmpRoot, { recursive: true });
    const operatorHeadings = `# My Project\n\n## Architecture\n\n### Subsection\n\n${SYSTEM_PROMPT_BLOCK}`;
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), operatorHeadings, 'utf8');
    writeLedger(tmpRoot, {
      entries: [{ target: 'CLAUDE.md', reversible: true }],
    });

    runUninstall({ projectRoot: tmpRoot, write: () => {}, exit: () => {} });

    // File must still exist (operator content preserved).
    assert.equal(
      fs.existsSync(path.join(tmpRoot, 'CLAUDE.md')),
      true,
      'CLAUDE.md was wrongly deleted when operator content was heading-only',
    );
    const after = fs.readFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'utf8');
    assert.match(after, /# My Project/, 'top-level heading must survive');
    assert.match(after, /## Architecture/, 'second heading must survive');
    assert.equal(
      after.includes(SYSTEM_PROMPT_IMPORT),
      false,
      'framework import must be stripped',
    );
  });

  it('removes a CLAUDE.md that is byte-identical to the install-authored template', () => {
    // The install created the file from nothing — uninstall should delete it.
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'CLAUDE.md'),
      SYSTEM_PROMPT_CLAUDE_MD,
      'utf8',
    );
    writeLedger(tmpRoot, {
      entries: [{ target: 'CLAUDE.md', reversible: true }],
    });

    runUninstall({ projectRoot: tmpRoot, write: () => {}, exit: () => {} });

    assert.equal(
      fs.existsSync(path.join(tmpRoot, 'CLAUDE.md')),
      false,
      'install-created CLAUDE.md must be removed',
    );
  });

  it('preserves a pre-commit hook whose only non-framework lines are shebang/comments', () => {
    // Operator hook: shebang + a comment, no executable lines.  The install
    // appended PRE_COMMIT_MARKER — uninstall must strip the line and keep the
    // shebang/comment rather than deleting the file.
    fs.mkdirSync(path.join(tmpRoot, '.husky'), { recursive: true });
    const operatorHook = `#!/bin/sh\n# My project pre-commit notes\n${PRE_COMMIT_MARKER}\n`;
    fs.writeFileSync(
      path.join(tmpRoot, '.husky', 'pre-commit'),
      operatorHook,
      'utf8',
    );
    writeLedger(tmpRoot, {
      entries: [{ target: '.husky/pre-commit', reversible: true }],
    });

    runUninstall({ projectRoot: tmpRoot, write: () => {}, exit: () => {} });

    // File must still exist (operator content preserved).
    assert.equal(
      fs.existsSync(path.join(tmpRoot, '.husky', 'pre-commit')),
      true,
      'pre-commit was wrongly deleted when operator content was shebang/comment-only',
    );
    const hook = fs.readFileSync(
      path.join(tmpRoot, '.husky', 'pre-commit'),
      'utf8',
    );
    assert.match(hook, /#!/, 'shebang must survive');
    assert.match(hook, /My project pre-commit notes/, 'comment must survive');
    assert.equal(
      hook.includes(PRE_COMMIT_MARKER),
      false,
      'quality-preview line must be stripped',
    );
  });

  it('removes a pre-commit hook that is byte-identical to the install-authored template', () => {
    // The install created the file from nothing — uninstall should delete it.
    fs.mkdirSync(path.join(tmpRoot, '.husky'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.husky', 'pre-commit'),
      DOWNSTREAM_PRE_COMMIT,
      'utf8',
    );
    writeLedger(tmpRoot, {
      entries: [{ target: '.husky/pre-commit', reversible: true }],
    });

    runUninstall({ projectRoot: tmpRoot, write: () => {}, exit: () => {} });

    assert.equal(
      fs.existsSync(path.join(tmpRoot, '.husky', 'pre-commit')),
      false,
      'install-created pre-commit hook must be removed',
    );
  });
});

// ---------------------------------------------------------------------------
// Story #3542 — retain .mcp.json gitignore entry when .mcp.json exists
// ---------------------------------------------------------------------------

describe('runUninstall — .mcp.json gitignore retention (Story #3542)', () => {
  it('retains the .mcp.json ignore entry when a real .mcp.json is present', () => {
    // Arrange: a .gitignore with both framework blocks and a real .mcp.json.
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.gitignore'),
      `node_modules/\n${GITIGNORE_BLOCKS.commands.block}${GITIGNORE_BLOCKS.mcp.block}`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmpRoot, '.mcp.json'),
      '{"mcpServers":{}}',
      'utf8',
    );
    writeLedger(tmpRoot, {
      entries: [{ target: '.gitignore', reversible: true }],
    });

    // Act
    const cap = makeCapture();
    runUninstall({ projectRoot: tmpRoot, write: cap.write, exit: cap.exit });

    // Assert: commands entry removed, mcp entry kept
    const gi = fs.readFileSync(path.join(tmpRoot, '.gitignore'), 'utf8');
    assert.equal(
      gi.includes('.claude/commands/'),
      false,
      'commands entry must be stripped',
    );
    assert.match(gi, /\.mcp\.json/, '.mcp.json entry must be retained');
    assert.equal(cap.exitCode, 0);
  });

  it('reports the retention reason in the outcome detail', () => {
    // Arrange
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.gitignore'),
      `${GITIGNORE_BLOCKS.commands.block}${GITIGNORE_BLOCKS.mcp.block}`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmpRoot, '.mcp.json'),
      '{"mcpServers":{}}',
      'utf8',
    );
    writeLedger(tmpRoot, {
      entries: [{ target: '.gitignore', reversible: true }],
    });

    // Act
    const cap = makeCapture();
    runUninstall({ projectRoot: tmpRoot, write: cap.write, exit: cap.exit });

    // Assert: outcome line mentions the retention
    assert.match(
      cap.text,
      /\.mcp\.json/,
      'output must mention .mcp.json retention',
    );
    assert.equal(cap.exitCode, 0);
  });

  it('removes the .mcp.json ignore entry when no .mcp.json exists', () => {
    // Arrange: framework blocks present, no real .mcp.json on disk.
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.gitignore'),
      `node_modules/\n${GITIGNORE_BLOCKS.commands.block}${GITIGNORE_BLOCKS.mcp.block}`,
      'utf8',
    );
    writeLedger(tmpRoot, {
      entries: [{ target: '.gitignore', reversible: true }],
    });

    // Act
    runUninstall({ projectRoot: tmpRoot, write: () => {}, exit: () => {} });

    // Assert: both framework entries removed
    const gi = fs.readFileSync(path.join(tmpRoot, '.gitignore'), 'utf8');
    assert.equal(
      gi.includes('.claude/commands/'),
      false,
      'commands entry must be stripped',
    );
    assert.equal(
      gi.includes('.mcp.json'),
      false,
      '.mcp.json entry must be stripped when no file exists',
    );
    assert.match(gi, /node_modules\//, 'operator content must survive');
  });
});

// ---------------------------------------------------------------------------
// Story #3543 — .agentrc.json reversal (contract mismatch fix)
// ---------------------------------------------------------------------------

describe('runUninstall — .agentrc.json reversal (Story #3543)', () => {
  it('removes an install-created .agentrc.json', () => {
    // Arrange: bootstrap created .agentrc.json from nothing.
    fs.mkdirSync(tmpRoot, { recursive: true });
    writeJson(path.join(tmpRoot, '.agentrc.json'), {
      $schema: './.agents/schemas/agentrc.schema.json',
      github: { owner: 'acme', repo: 'widgets' },
    });
    writeLedger(tmpRoot, {
      entries: [
        { target: '.agentrc.json', reversible: true, executedAction: 'seeded' },
      ],
    });

    const cap = makeCapture();
    runUninstall({ projectRoot: tmpRoot, write: cap.write, exit: cap.exit });

    assert.equal(cap.exitCode, 0);
    assert.equal(
      fs.existsSync(path.join(tmpRoot, '.agentrc.json')),
      false,
      'install-created .agentrc.json must be removed',
    );
    assert.match(cap.text, /reverted/);
  });

  it('reports skipped when .agentrc.json is absent (idempotent re-run)', () => {
    // Arrange: ledger references .agentrc.json but the file is already gone.
    fs.mkdirSync(tmpRoot, { recursive: true });
    writeLedger(tmpRoot, {
      entries: [{ target: '.agentrc.json', reversible: true }],
    });

    const cap = makeCapture();
    runUninstall({ projectRoot: tmpRoot, write: cap.write, exit: cap.exit });

    assert.equal(cap.exitCode, 0);
    assert.match(cap.text, /skipped/);
    assert.match(cap.text, /file absent/);
  });

  it('routes .agentrc.json to fileTargets (not manual) in planUninstall', () => {
    const ledger = {
      entries: [{ target: '.agentrc.json', reversible: true }],
    };
    const { fileTargets, manual } = planUninstall(ledger);
    assert.deepEqual(fileTargets, ['.agentrc.json']);
    assert.equal(manual.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Story #3895 — uninstall preserves a pre-existing .agentrc.json (data loss)
// ---------------------------------------------------------------------------
//
// The bootstrap records the live `agentrc` phase outcome in the ledger as
// `executedAction` (schema v2). `seeded` means the install authored the file
// from the starter; `already-present` means an operator-authored file was left
// untouched. Uninstall must delete ONLY the `seeded` case — deleting an
// `already-present` file is the data loss this Story closes.
// ---------------------------------------------------------------------------

describe('runUninstall — preserves a pre-existing .agentrc.json (Story #3895)', () => {
  it('does NOT delete an .agentrc.json the install did not create (executedAction=already-present)', () => {
    // Arrange: the operator hand-authored .agentrc.json before install; the
    // bootstrap left it untouched and recorded `already-present`.
    fs.mkdirSync(tmpRoot, { recursive: true });
    const handAuthored = {
      $schema: './.agents/schemas/agentrc.schema.json',
      github: { owner: 'operator', repo: 'their-repo' },
      delivery: { deliverRunner: { concurrencyCap: 1 } }, // operator-specific tuning
    };
    writeJson(path.join(tmpRoot, '.agentrc.json'), handAuthored);
    writeLedger(tmpRoot, {
      entries: [
        {
          target: '.agentrc.json',
          reversible: true,
          executedAction: 'already-present',
        },
      ],
    });

    const cap = makeCapture();
    runUninstall({ projectRoot: tmpRoot, write: cap.write, exit: cap.exit });

    // The pre-existing file MUST survive, byte-for-byte.
    assert.equal(cap.exitCode, 0);
    assert.equal(
      fs.existsSync(path.join(tmpRoot, '.agentrc.json')),
      true,
      'pre-existing .agentrc.json must NOT be deleted on uninstall',
    );
    assert.deepEqual(
      readJson(path.join(tmpRoot, '.agentrc.json')),
      handAuthored,
      'pre-existing .agentrc.json content must be untouched',
    );
    assert.match(cap.text, /pre-existing .agentrc.json preserved/);
  });

  it('still removes an install-created .agentrc.json (executedAction=seeded)', () => {
    // Arrange: a fresh install seeded the file from the starter.
    fs.mkdirSync(tmpRoot, { recursive: true });
    writeJson(path.join(tmpRoot, '.agentrc.json'), {
      $schema: './.agents/schemas/agentrc.schema.json',
      github: { owner: 'acme', repo: 'widgets' },
    });
    writeLedger(tmpRoot, {
      entries: [
        { target: '.agentrc.json', reversible: true, executedAction: 'seeded' },
      ],
    });

    const cap = makeCapture();
    runUninstall({ projectRoot: tmpRoot, write: cap.write, exit: cap.exit });

    assert.equal(cap.exitCode, 0);
    assert.equal(
      fs.existsSync(path.join(tmpRoot, '.agentrc.json')),
      false,
      'install-created .agentrc.json must still be removed',
    );
  });

  it('fails safe — preserves the file when the ledger carries no executedAction hint', () => {
    // Arrange: a v2 ledger written by this framework always carries the hint,
    // but if a malformed/legacy entry omits it, uninstall must not guess and
    // delete operator content. Absence of the hint → preserve.
    fs.mkdirSync(tmpRoot, { recursive: true });
    writeJson(path.join(tmpRoot, '.agentrc.json'), {
      $schema: './.agents/schemas/agentrc.schema.json',
      github: { owner: 'operator', repo: 'their-repo' },
    });
    writeLedger(tmpRoot, {
      entries: [{ target: '.agentrc.json', reversible: true }],
    });

    const cap = makeCapture();
    runUninstall({ projectRoot: tmpRoot, write: cap.write, exit: cap.exit });

    assert.equal(cap.exitCode, 0);
    assert.equal(
      fs.existsSync(path.join(tmpRoot, '.agentrc.json')),
      true,
      'no executedAction hint must fail safe and preserve the file',
    );
  });

  it('planUninstall threads executedAction onto the per-target map', () => {
    const ledger = {
      entries: [
        // repo-config create + quality-gates merge share the target; the first
        // defined executedAction wins.
        {
          target: '.agentrc.json',
          reversible: true,
          executedAction: 'already-present',
        },
        { target: '.agentrc.json', reversible: true },
      ],
    };
    const { fileTargets, executedActionByTarget } = planUninstall(ledger);
    assert.deepEqual(fileTargets, ['.agentrc.json']);
    assert.equal(executedActionByTarget['.agentrc.json'], 'already-present');
  });
});

// ---------------------------------------------------------------------------
// AC4 — GitHub-side state untouched unless --include-github
// ---------------------------------------------------------------------------

describe('runUninstall — GitHub admin entries (AC4)', () => {
  it('surfaces github-admin entries as manual follow-ups, never acting on them', () => {
    seedFreshInstall(tmpRoot);
    const cap = makeCapture();

    const result = runUninstall({
      projectRoot: tmpRoot,
      write: cap.write,
      exit: cap.exit,
      includeGithub: false,
    });

    // Two github-admin entries → two manual follow-ups.
    assert.equal(result.manualCount, 2);
    assert.match(cap.text, /manual/);
    assert.match(cap.text, /pass --include-github to acknowledge/);
    // No remote action is taken regardless of the flag — the message only
    // changes acknowledgement wording.
  });

  it('annotates github-admin entries as acknowledged under --include-github', () => {
    seedFreshInstall(tmpRoot);
    const cap = makeCapture();

    runUninstall({
      projectRoot: tmpRoot,
      write: cap.write,
      exit: cap.exit,
      includeGithub: true,
    });

    assert.match(cap.text, /reverse manually via the GitHub UI\/API/);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('runUninstall — edge cases', () => {
  it('reports a benign no-op (exit 0) when no ledger exists', () => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    const cap = makeCapture();
    const result = runUninstall({
      projectRoot: tmpRoot,
      write: cap.write,
      exit: cap.exit,
    });
    assert.equal(cap.exitCode, 0);
    assert.equal(result.ledgerFound, false);
    assert.match(cap.text, /No install ledger found/);
  });

  it('refuses an unsupported ledger schema version (exit 1)', () => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    writeLedger(tmpRoot, { entries: [], schemaVersion: 999 });
    const cap = makeCapture();
    runUninstall({ projectRoot: tmpRoot, write: cap.write, exit: cap.exit });
    assert.equal(cap.exitCode, 1);
    assert.match(cap.text, /schema v999 is not supported/);
  });

  it('errors (exit 1) on an unreadable/corrupt ledger', () => {
    fs.mkdirSync(path.join(tmpRoot, '.agents'), { recursive: true });
    fs.writeFileSync(ledgerPath(tmpRoot), '{ not valid json', 'utf8');
    const cap = makeCapture();
    runUninstall({ projectRoot: tmpRoot, write: cap.write, exit: cap.exit });
    assert.equal(cap.exitCode, 1);
    assert.match(cap.text, /unreadable/);
  });
});

// ---------------------------------------------------------------------------
// Story #3544 — per-target JSON.parse guard (corrupt operator file)
// ---------------------------------------------------------------------------

describe('runUninstall — corrupt target file guard (Story #3544)', () => {
  it('yields a skipped outcome (not an uncaught throw) when settings.json is invalid JSON', () => {
    // Arrange: an operator-edited .claude/settings.json that is invalid JSON.
    fs.mkdirSync(path.join(tmpRoot, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.claude', 'settings.json'),
      '{ not valid json at all',
      'utf8',
    );
    writeLedger(tmpRoot, {
      entries: [{ target: '.claude/settings.json', reversible: true }],
    });

    const cap = makeCapture();
    // Must not throw — the per-target guard must catch the JSON.parse error.
    let result;
    assert.doesNotThrow(() => {
      result = runUninstall({
        projectRoot: tmpRoot,
        write: cap.write,
        exit: cap.exit,
      });
    });

    // AC2: yields a skipped outcome rather than an uncaught throw
    assert.equal(cap.exitCode, 0);
    assert.match(cap.text, /skipped/);
    assert.match(cap.text, /unparseable/);
    assert.equal(result.parseErrorCount, 1);
  });

  it('yields a skipped outcome (not an uncaught throw) when package.json is invalid JSON', () => {
    // Arrange: an operator-edited package.json that is invalid JSON.
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'package.json'),
      '{ broken json',
      'utf8',
    );
    writeLedger(tmpRoot, {
      entries: [{ target: 'package.json', reversible: true }],
    });

    const cap = makeCapture();
    let result;
    assert.doesNotThrow(() => {
      result = runUninstall({
        projectRoot: tmpRoot,
        write: cap.write,
        exit: cap.exit,
      });
    });

    assert.equal(cap.exitCode, 0);
    assert.match(cap.text, /skipped/);
    assert.match(cap.text, /unparseable/);
    assert.equal(result.parseErrorCount, 1);
  });

  it('continues reverting other targets after a corrupt file (AC3 — one bad file does not abort)', () => {
    // Arrange: settings.json is corrupt; CLAUDE.md and .agentrc.json are valid.
    fs.mkdirSync(path.join(tmpRoot, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.claude', 'settings.json'),
      '{ not valid json',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'CLAUDE.md'),
      SYSTEM_PROMPT_CLAUDE_MD,
      'utf8',
    );
    writeJson(path.join(tmpRoot, '.agentrc.json'), {
      $schema: './.agents/schemas/agentrc.schema.json',
    });
    writeLedger(tmpRoot, {
      entries: [
        { target: '.claude/settings.json', reversible: true },
        { target: 'CLAUDE.md', reversible: true },
        { target: '.agentrc.json', reversible: true, executedAction: 'seeded' },
      ],
    });

    const cap = makeCapture();
    runUninstall({ projectRoot: tmpRoot, write: cap.write, exit: cap.exit });

    // The corrupt settings.json is skipped, but CLAUDE.md and .agentrc.json
    // are still reverted.
    assert.equal(cap.exitCode, 0);
    assert.equal(
      fs.existsSync(path.join(tmpRoot, 'CLAUDE.md')),
      false,
      'CLAUDE.md must be reverted even though settings.json was corrupt',
    );
    assert.equal(
      fs.existsSync(path.join(tmpRoot, '.agentrc.json')),
      false,
      '.agentrc.json must be reverted even though settings.json was corrupt',
    );
    // The corrupt target is reported as skipped.
    assert.match(cap.text, /skipped/);
    assert.match(cap.text, /unparseable/);
  });

  it('leaves the install ledger intact when a target is skipped due to parse error (AC4 — resume possible)', () => {
    // Arrange: settings.json is corrupt; only this one entry in ledger.
    fs.mkdirSync(path.join(tmpRoot, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '.claude', 'settings.json'),
      '{ corrupt',
      'utf8',
    );
    writeLedger(tmpRoot, {
      entries: [{ target: '.claude/settings.json', reversible: true }],
    });

    runUninstall({ projectRoot: tmpRoot, write: () => {}, exit: () => {} });

    // Ledger must still exist so operator can fix the file and re-run.
    assert.equal(
      fs.existsSync(ledgerPath(tmpRoot)),
      true,
      'install ledger must be retained when a target was skipped due to parse error',
    );
  });
});

// ---------------------------------------------------------------------------
// Story #3545 — prepare-removal reporting: empty-after-strip and no-match
// ---------------------------------------------------------------------------

describe('revertPackageJson — prepare-removal reporting (Story #3545)', () => {
  it('deletes the prepare key when stripping the fragment leaves an empty string', () => {
    // `prepare` is exactly ` && <sync>` — after strip + trim the value is "".
    // The key must be deleted, not written as `"prepare": ""`.
    fs.mkdirSync(tmpRoot, { recursive: true });
    writeJson(path.join(tmpRoot, 'package.json'), {
      name: 'empty-prepare',
      scripts: {
        prepare: ` && ${SYNC_COMMAND}`,
      },
    });
    writeLedger(tmpRoot, {
      entries: [{ target: 'package.json', reversible: true }],
    });

    runUninstall({ projectRoot: tmpRoot, write: () => {}, exit: () => {} });

    const pkg = readJson(path.join(tmpRoot, 'package.json'));
    // The key must be absent (not set to "").
    assert.equal(
      pkg.scripts?.prepare,
      undefined,
      'prepare must be deleted when stripping leaves an empty string',
    );
  });

  it('does not report prepare as removed when the sync fragment is absent', () => {
    // `prepare` is an operator value with no SYNC_COMMAND in it — uninstall
    // must leave it completely intact and not list it in the removed scripts.
    fs.mkdirSync(tmpRoot, { recursive: true });
    writeJson(path.join(tmpRoot, 'package.json'), {
      name: 'no-sync-prepare',
      scripts: {
        prepare: 'husky',
        'sync:commands': SYNC_COMMAND, // framework script → removed
      },
    });
    writeLedger(tmpRoot, {
      entries: [{ target: 'package.json', reversible: true }],
    });

    runUninstall({ projectRoot: tmpRoot, write: () => {}, exit: () => {} });

    const pkg = readJson(path.join(tmpRoot, 'package.json'));
    // prepare must be untouched.
    assert.equal(
      pkg.scripts.prepare,
      'husky',
      'prepare must survive when it contains no sync fragment',
    );
    // The framework sync:commands key was removed.
    assert.equal(pkg.scripts['sync:commands'], undefined);
  });
});

// ---------------------------------------------------------------------------
// runUninstall — --dry-run (Story #4047 B6)
// ---------------------------------------------------------------------------

describe('runUninstall — --dry-run', () => {
  it('exits 0 in dry-run mode', () => {
    seedFreshInstall(tmpRoot);
    const cap = makeCapture();
    runUninstall({
      projectRoot: tmpRoot,
      write: cap.write,
      exit: cap.exit,
      dryRun: true,
    });
    assert.equal(cap.exitCode, 0);
  });

  it('does NOT write any files in dry-run mode (CLAUDE.md survives)', () => {
    seedFreshInstall(tmpRoot);
    const originalClaude = fs.readFileSync(
      path.join(tmpRoot, 'CLAUDE.md'),
      'utf8',
    );
    const cap = makeCapture();
    runUninstall({
      projectRoot: tmpRoot,
      write: cap.write,
      exit: cap.exit,
      dryRun: true,
    });
    // File must be unchanged
    const afterClaude = fs.readFileSync(
      path.join(tmpRoot, 'CLAUDE.md'),
      'utf8',
    );
    assert.equal(
      afterClaude,
      originalClaude,
      'CLAUDE.md must not change in dry-run',
    );
  });

  it('does NOT remove the install ledger in dry-run mode', () => {
    seedFreshInstall(tmpRoot);
    const lp = ledgerPath(tmpRoot);
    assert.ok(fs.existsSync(lp), 'ledger must exist before dry-run');
    const cap = makeCapture();
    runUninstall({
      projectRoot: tmpRoot,
      write: cap.write,
      exit: cap.exit,
      dryRun: true,
    });
    assert.ok(fs.existsSync(lp), 'ledger must still exist after dry-run');
  });

  it('prints the planned reversal targets to output', () => {
    seedFreshInstall(tmpRoot);
    const cap = makeCapture();
    runUninstall({
      projectRoot: tmpRoot,
      write: cap.write,
      exit: cap.exit,
      dryRun: true,
    });
    assert.match(cap.text, /dry run/i);
    // Should show some file targets
    assert.match(cap.text, /CLAUDE\.md/);
  });

  it('returns ledgerFound: true and revertedCount: 0', () => {
    seedFreshInstall(tmpRoot);
    const result = runUninstall({
      projectRoot: tmpRoot,
      write: () => {},
      exit: () => {},
      dryRun: true,
    });
    assert.equal(result.ledgerFound, true);
    assert.equal(result.revertedCount, 0);
  });
});
