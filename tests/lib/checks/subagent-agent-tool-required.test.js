/**
 * Unit tests for the subagent-agent-tool-required check.
 *
 * The check scans `.agents/workflows/*.md` for sub-agent workflow
 * definitions that declare the `Agent` tool. Each test writes a
 * fixture workflows directory and points the check at it via
 * `state.scanRoot`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import check from '../../../.agents/scripts/lib/checks/subagent-agent-tool-required.js';

function makeFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'subagent-agent-fixture-'));
  return {
    root,
    write(relPath, contents) {
      const full = path.join(root, relPath);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents, 'utf8');
    },
  };
}

let fixture;

describe('subagent-agent-tool-required.detect', () => {
  beforeEach(() => {
    fixture = makeFixtureRoot();
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('returns null for sub-agent workflows that flatten fan-out (no Agent in tools list)', () => {
    fixture.write(
      'story-execute.md',
      [
        '---',
        'description: >-',
        '  Execute one Story end-to-end. Runs as a sub-agent under',
        '  /epic-deliver and uses Bash + Read + Edit only.',
        'tools: [Bash, Read, Edit, Grep, Glob, Write]',
        '---',
        '',
        '# /story-execute',
        '',
        'The sub-agent does not dispatch nested Agents.',
      ].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.equal(finding, null);
  });

  it('returns a blocker finding when a sub-agent workflow lists Agent in flow-style frontmatter', () => {
    fixture.write(
      'cascade-fanout.md',
      [
        '---',
        'description: >-',
        '  Runs as a sub-agent of /epic-deliver and dispatches further',
        '  sub-agents in turn.',
        'tools: [Bash, Read, Edit, Agent]',
        '---',
        '',
        '# /cascade-fanout',
        '',
        'Dispatches per-Story sub-agents via Agent.',
      ].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.ok(finding, 'expected a finding');
    assert.equal(finding.id, 'subagent-agent-tool-required');
    assert.equal(finding.severity, 'blocker');
    assert.match(finding.detail, /cascade-fanout\.md/);
    assert.match(finding.detail, /frontmatter tools:/);
  });

  it('detects block-style YAML tools list containing Agent', () => {
    fixture.write(
      'block-style.md',
      [
        '---',
        'description: Runs as a sub-agent of /epic-deliver.',
        'tools:',
        '  - Bash',
        '  - Read',
        '  - Agent',
        '---',
        '',
        '# /block-style',
      ].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.ok(finding);
    assert.match(finding.detail, /block-style\.md/);
  });

  it('does NOT flag host workflows (no sub-agent role) even when Agent is in the tool list', () => {
    fixture.write(
      'epic-deliver.md',
      [
        '---',
        'description: Drives an Epic end-to-end as the host workflow.',
        'tools: [Bash, Agent]',
        '---',
        '',
        '# /epic-deliver',
        '',
        'Host workflow fans out per-Story sub-agents.',
      ].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.equal(finding, null);
  });

  it('emits a fixCommand citing the flatten-fan-out remediation pattern', () => {
    fixture.write(
      'leaky.md',
      [
        '---',
        'description: A sub-agent that misuses Agent.',
        'tools: [Bash, Agent]',
        '---',
        '# /leaky',
      ].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.ok(finding);
    assert.match(finding.fixCommand, /[Ff]latten/);
    assert.match(finding.fixCommand, /NO Agent/);
  });

  it('returns null when the workflows directory does not exist', () => {
    const finding = check.detect({
      scanRoot: path.join(fixture.root, 'nonexistent'),
    });
    assert.equal(finding, null);
  });
});
