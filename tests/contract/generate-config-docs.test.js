// tests/contract/generate-config-docs.test.js
//
// Story #3049 — contract test for `generate-config-docs.js`. The CLI is
// driven by `npm run docs:check` in CI; this contract test exercises the
// exported helpers against synthetic fixtures so a regression in the
// schema-walker or splice helpers fails locally instead of waiting for CI.
//
// Coverage:
//   - `renderRegion` produces a deterministic table for a known schema.
//   - `spliceRegion` rewrites an existing BEGIN/END block in place.
//   - `spliceRegion` inserts the block after `## Top-level shape` when the
//     markers are absent.
//   - `spliceRegion` throws when only one marker is present.
//   - Spawning the binary in `--check` mode against an up-to-date doc
//     exits 0; against a doctored doc it exits non-zero with the diff
//     hint.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REGION_BEGIN,
  REGION_END,
  renderRegion,
  spliceRegion,
} from '../../.agents/scripts/generate-config-docs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const bin = path.join(
  repoRoot,
  '.agents',
  'scripts',
  'generate-config-docs.js',
);

function stubSection(description) {
  return {
    type: 'object',
    description,
    properties: {},
  };
}

const SYNTHETIC_SCHEMA = {
  $defs: {},
  type: 'object',
  properties: {
    project: {
      type: 'object',
      description: 'Project-scoped configuration.',
      properties: {
        baseBranch: {
          type: 'string',
          default: 'main',
          description: 'Default integration branch.',
        },
      },
    },
    github: stubSection('GitHub provider config.'),
    planning: stubSection('Planning workflow config.'),
    delivery: stubSection('Delivery workflow config.'),
  },
};

describe('renderRegion — deterministic schema-to-table', () => {
  it('emits one section per top-level key with the documented columns', () => {
    const body = renderRegion(SYNTHETIC_SCHEMA);
    assert.match(body, /## `project`/);
    assert.match(body, /Project-scoped configuration\./);
    assert.match(
      body,
      /\| Key \| Required \| Type \| Default \| Description \|/,
    );
    assert.match(body, /`baseBranch`/);
    assert.match(body, /`"main"`/);
  });
});

describe('spliceRegion — in-place rewrite', () => {
  it('replaces the body between BEGIN and END markers', () => {
    const before = [
      '# Doc',
      '',
      'Intro.',
      '',
      REGION_BEGIN,
      'OLD BODY',
      REGION_END,
      '',
      '## After',
    ].join('\n');
    const after = spliceRegion(before, 'NEW BODY');
    assert.match(
      after,
      /BEGIN GENERATED:agentrc[\s\S]*NEW BODY[\s\S]*END GENERATED:agentrc/,
    );
    assert.ok(
      !after.includes('OLD BODY'),
      'splice should remove the prior body',
    );
    assert.match(after, /## After/);
  });

  it('inserts the block after the Top-level shape anchor when markers are absent', () => {
    const before = [
      '# Doc',
      '',
      '## Top-level shape',
      '',
      'Some prose.',
      '',
      '---',
      '',
      '## Next section',
    ].join('\n');
    const after = spliceRegion(before, 'FRESH BODY');
    assert.match(after, /## Top-level shape/);
    assert.match(
      after,
      /BEGIN GENERATED:agentrc[\s\S]*FRESH BODY[\s\S]*END GENERATED:agentrc/,
    );
    assert.match(after, /## Next section/);
    const beginIdx = after.indexOf(REGION_BEGIN);
    const nextSectionIdx = after.indexOf('## Next section');
    assert.ok(beginIdx < nextSectionIdx, 'block must precede ## Next section');
  });

  it('throws when only one marker is present', () => {
    const onlyBegin = ['# Doc', REGION_BEGIN, 'unbalanced', '## After'].join(
      '\n',
    );
    assert.throws(
      () => spliceRegion(onlyBegin, 'NEW'),
      /Only one region marker present/,
    );
  });
});

describe('generate-config-docs CLI --check', () => {
  it('exits 0 against the live docs/configuration.md (already up to date)', () => {
    const res = spawnSync(process.execPath, [bin, '--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(
      res.status,
      0,
      `expected exit 0; got ${res.status}; stderr=${res.stderr}`,
    );
  });

  it('exits non-zero with a regenerate hint when the doc is doctored', () => {
    const docPath = path.join(repoRoot, 'docs', 'configuration.md');
    const original = readFileSync(docPath, 'utf8');
    const beginIdx = original.indexOf(REGION_BEGIN);
    assert.ok(beginIdx !== -1, 'expected REGION_BEGIN marker in the live doc');
    const sandboxDir = mkdtempSync(path.join(tmpdir(), 'gen-config-docs-'));
    try {
      // Doctor in place via a temp swap so the test does not leave the
      // working tree mutated even if the assertion fails.
      const doctored = original.replace(
        REGION_BEGIN,
        `${REGION_BEGIN}\n\n_doctored line_\n`,
      );
      writeFileSync(docPath, doctored, 'utf8');
      try {
        const res = spawnSync(process.execPath, [bin, '--check'], {
          cwd: repoRoot,
          encoding: 'utf8',
        });
        assert.notEqual(res.status, 0, 'expected non-zero exit on stale doc');
        assert.match(
          res.stderr,
          /generate-config-docs\.js.*regenerate/i,
          `expected regenerate hint in stderr; got: ${res.stderr}`,
        );
      } finally {
        writeFileSync(docPath, original, 'utf8');
      }
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });
});
