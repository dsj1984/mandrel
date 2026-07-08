/**
 * Unit tests for the subagent-agent-tool-required supported-depth guard.
 *
 * The check scans `.agents/workflows/*.md` for sub-agent workflow
 * definitions that declare the `Agent` tool, and flags only those whose
 * declared `nesting-depth` exceeds the announced/supported ceiling. Nested
 * Agent dispatch is supported (verified depth 2, announced max 5 — Claude
 * Code 2.1.202), so declaring `Agent` at a supported depth is legitimate and
 * must NOT be flagged. Each test writes a fixture workflows directory and
 * points the check at it via `state.scanRoot`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import check, {
  ANNOUNCED_MAX_DEPTH,
} from '../../../.agents/scripts/lib/checks/subagent-agent-tool-required.js';

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

  it('exposes the announced max nesting depth as a positive integer', () => {
    assert.equal(Number.isInteger(ANNOUNCED_MAX_DEPTH), true);
    assert.ok(ANNOUNCED_MAX_DEPTH > 0);
  });

  it('returns null for a sub-agent workflow that declares Agent with no depth (shallow level-1 fan-out)', () => {
    fixture.write(
      'story-deliver.md',
      [
        '---',
        'description: >-',
        '  Execute one Story end-to-end. Runs as a sub-agent under',
        '  /deliver and may dispatch a level-2 critic via Agent.',
        'tools: [Bash, Read, Edit, Agent]',
        '---',
        '',
        '# /deliver',
        '',
        'The sub-agent dispatches a nested critic Agent at a supported depth.',
      ].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.equal(finding, null);
  });

  it('returns null for a sub-agent workflow that declares Agent at a supported depth (within ceiling)', () => {
    fixture.write(
      'depth-two.md',
      [
        '---',
        'description: Runs as a sub-agent of /deliver and fans out one level.',
        'nesting-depth: 2',
        'tools: [Bash, Read, Agent]',
        '---',
        '',
        '# /depth-two',
      ].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.equal(finding, null);
  });

  it('returns null for a sub-agent workflow that declares Agent exactly at the ceiling', () => {
    fixture.write(
      'depth-ceiling.md',
      [
        '---',
        'description: Runs as a sub-agent and fans out to the announced max.',
        `nesting-depth: ${ANNOUNCED_MAX_DEPTH}`,
        'tools: [Bash, Agent]',
        '---',
        '',
        '# /depth-ceiling',
      ].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.equal(finding, null);
  });

  it('returns a blocker finding when a sub-agent workflow declares an Agent fan-out deeper than the ceiling', () => {
    const tooDeep = ANNOUNCED_MAX_DEPTH + 1;
    fixture.write(
      'over-deep.md',
      [
        '---',
        'description: >-',
        '  Runs as a sub-agent of /deliver and dispatches further',
        '  sub-agents beyond the supported depth.',
        `nesting-depth: ${tooDeep}`,
        'tools: [Bash, Read, Edit, Agent]',
        '---',
        '',
        '# /over-deep',
        '',
        'Dispatches per-Story sub-agents via Agent at an unsupported depth.',
      ].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.ok(finding, 'expected a finding');
    assert.equal(finding.id, 'subagent-agent-tool-required');
    assert.equal(finding.severity, 'blocker');
    assert.match(finding.detail, /over-deep\.md/);
    assert.match(finding.detail, new RegExp(`nesting-depth ${tooDeep}`));
    assert.match(finding.detail, /exceeds supported ceiling/);
  });

  it('detects an over-deep fan-out declared with a block-style YAML tools list', () => {
    const tooDeep = ANNOUNCED_MAX_DEPTH + 2;
    fixture.write(
      'block-style.md',
      [
        '---',
        'description: Runs as a sub-agent of /epic-deliver.',
        `nesting-depth: ${tooDeep}`,
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
    assert.match(finding.detail, new RegExp(`nesting-depth ${tooDeep}`));
  });

  it('reads the declared depth from a body <!-- nesting-depth --> marker', () => {
    const tooDeep = ANNOUNCED_MAX_DEPTH + 1;
    fixture.write(
      'body-depth.md',
      [
        '---',
        'description: Runs as a sub-agent of /deliver.',
        'tools: [Bash, Agent]',
        '---',
        '',
        '# /body-depth',
        '',
        `<!-- nesting-depth: ${tooDeep} -->`,
      ].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.ok(finding);
    assert.match(finding.detail, /body-depth\.md/);
  });

  it('honours a stricter supportedDepth override from state', () => {
    fixture.write(
      'depth-two.md',
      [
        '---',
        'description: Runs as a sub-agent of /deliver.',
        'nesting-depth: 2',
        'tools: [Bash, Agent]',
        '---',
        '',
        '# /depth-two',
      ].join('\n'),
    );
    // Ceiling 2 → depth 2 is allowed.
    assert.equal(
      check.detect({ scanRoot: fixture.root, supportedDepth: 2 }),
      null,
    );
    // Ceiling 1 → depth 2 now exceeds it and is flagged.
    const finding = check.detect({ scanRoot: fixture.root, supportedDepth: 1 });
    assert.ok(
      finding,
      'expected a finding when the depth exceeds the override',
    );
    assert.match(finding.detail, /exceeds supported ceiling 1/);
  });

  it('does NOT flag host workflows (no sub-agent role) even at an over-deep declared depth', () => {
    fixture.write(
      'epic-deliver.md',
      [
        '---',
        'description: Drives an Epic end-to-end as the host workflow.',
        `nesting-depth: ${ANNOUNCED_MAX_DEPTH + 3}`,
        'tools: [Bash, Agent]',
        '---',
        '',
        '# /deliver',
        '',
        'Host workflow fans out per-Story workers.',
      ].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.equal(finding, null);
  });

  it('emits a fixCommand that explains the depth ceiling and does NOT tell contributors to strip Agent', () => {
    fixture.write(
      'over-deep.md',
      [
        '---',
        'description: A sub-agent that declares an over-deep Agent fan-out.',
        `nesting-depth: ${ANNOUNCED_MAX_DEPTH + 1}`,
        'tools: [Bash, Agent]',
        '---',
        '# /over-deep',
      ].join('\n'),
    );
    const finding = check.detect({ scanRoot: fixture.root });
    assert.ok(finding);
    // The remediation is about depth, not removing the capability.
    assert.match(finding.fixCommand, /depth/i);
    assert.match(finding.fixCommand, /supported/i);
    // It must affirm the capability, not deny it.
    assert.match(finding.fixCommand, /Sub-agents CAN\b/);
    // It must NOT repeat the retired "strip Agent / sub-agents cannot
    // dispatch" remediation prose.
    assert.doesNotMatch(finding.fixCommand, /NO Agent/);
    assert.doesNotMatch(finding.fixCommand, /cannot dispatch/i);
    assert.doesNotMatch(finding.fixCommand, /[Ff]latten fan-out/);
  });

  it('returns null when the workflows directory does not exist', () => {
    const finding = check.detect({
      scanRoot: path.join(fixture.root, 'nonexistent'),
    });
    assert.equal(finding, null);
  });
});
