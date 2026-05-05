/**
 * Renderer + footer-stability tests for the v5.33 structured task body.
 *
 *   - byte-stable rendering of a fixed structured input;
 *   - orchestrator footer (parent: / Epic: / blocked by) survives renderer
 *     round-trip byte-for-byte;
 *   - audit-snapshot line is emitted only for structured (task) bodies.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  composeTaskBody,
  hasStructuredHeader,
  renderOrchestratorFooter,
  renderTaskBody,
} from '../.agents/scripts/lib/templates/task-body-renderer.js';

describe('renderTaskBody', () => {
  it('emits a byte-stable four-section markdown for a fixed input', () => {
    const body = {
      goal: 'Reduce mountPhotoGrid to event-wiring so story s-photo-grid-astro can take over rendering.',
      changes: [
        'src/components/PhotoGrid/mount.ts: remove createImageElement helper',
        'src/components/PhotoGrid/mount.ts: keep wirePhotoEvents signature',
        'data-testid invariance: photo-grid-root, photo-grid-item',
      ],
      acceptance: [
        'src/components/PhotoGrid/mount.ts is under 80 LOC',
        'tests/e2e/photo-grid.spec.ts passes',
      ],
      verify: [
        'npm run test -- src/components/PhotoGrid/mount.test.ts (unit)',
        'npm run test:e2e -- tests/e2e/photo-grid.spec.ts (e2e)',
      ],
    };

    const expected = [
      '## Goal',
      'Reduce mountPhotoGrid to event-wiring so story s-photo-grid-astro can take over rendering.',
      '',
      '## Changes',
      '- src/components/PhotoGrid/mount.ts: remove createImageElement helper',
      '- src/components/PhotoGrid/mount.ts: keep wirePhotoEvents signature',
      '- data-testid invariance: photo-grid-root, photo-grid-item',
      '',
      '## Acceptance',
      '- [ ] src/components/PhotoGrid/mount.ts is under 80 LOC',
      '- [ ] tests/e2e/photo-grid.spec.ts passes',
      '',
      '## Verify',
      '- npm run test -- src/components/PhotoGrid/mount.test.ts (unit)',
      '- npm run test:e2e -- tests/e2e/photo-grid.spec.ts (e2e)',
    ].join('\n');

    assert.equal(renderTaskBody(body), expected);
  });
});

describe('renderOrchestratorFooter — byte stability vs. legacy createTicket footer', () => {
  it('parent only, no Epic line when epicId === parentId', () => {
    const footer = renderOrchestratorFooter({ parentId: 10, epicId: 10 });
    assert.equal(footer, ['---', 'parent: #10'].join('\n'));
  });

  it('emits Epic line when epicId differs from parentId', () => {
    const footer = renderOrchestratorFooter({ parentId: 20, epicId: 10 });
    assert.equal(footer, ['---', 'parent: #20', 'Epic: #10'].join('\n'));
  });

  it('emits dependencies after a blank line', () => {
    const footer = renderOrchestratorFooter({
      parentId: 20,
      epicId: 10,
      dependencies: [5, 6],
    });
    assert.equal(
      footer,
      [
        '---',
        'parent: #20',
        'Epic: #10',
        '',
        'blocked by #5',
        'blocked by #6',
      ].join('\n'),
    );
  });

  it('emits audit-snapshot before the dependency block', () => {
    const footer = renderOrchestratorFooter({
      parentId: 20,
      epicId: 10,
      dependencies: [5],
      auditSnapshot: '2026-05-05',
    });
    assert.equal(
      footer,
      [
        '---',
        'parent: #20',
        'Epic: #10',
        'audit-snapshot: 2026-05-05',
        '',
        'blocked by #5',
      ].join('\n'),
    );
  });
});

describe('composeTaskBody', () => {
  it('matches legacy string-body output byte-for-byte', () => {
    // Replicate exactly what createTicket used to produce pre-v5.33.
    const parentId = 20;
    const epicId = 10;
    const dependencies = [5, 6];
    const legacyParts = [
      'Body text',
      '',
      '---',
      `parent: #${parentId}`,
      `Epic: #${epicId}`,
      '',
      `blocked by #${dependencies[0]}`,
      `blocked by #${dependencies[1]}`,
    ];
    const legacy = legacyParts.join('\n');

    const composed = composeTaskBody({
      body: 'Body text',
      parentId,
      epicId,
      dependencies,
    });
    assert.equal(composed, legacy);
  });

  it('renders structured body + audit-snapshot footer', () => {
    const out = composeTaskBody({
      body: {
        goal: 'g',
        changes: ['src/x.ts: do thing'],
        acceptance: ['x'],
        verify: ['npm run test (unit)'],
      },
      parentId: 728,
      epicId: 700,
      dependencies: [],
      auditSnapshot: '2026-05-05',
    });
    assert.match(out, /^## Goal\n/);
    assert.match(
      out,
      /\n## Verify\n- npm run test \(unit\)\n\n---\nparent: #728\nEpic: #700\naudit-snapshot: 2026-05-05$/,
    );
  });

  it('does not emit audit-snapshot for legacy string body even if passed', () => {
    const out = composeTaskBody({
      body: 'plain string body',
      parentId: 10,
      epicId: 10,
      auditSnapshot: '2026-05-05',
    });
    assert.equal(out.includes('audit-snapshot:'), false);
  });
});

describe('hasStructuredHeader', () => {
  it('detects ## Goal header at start (allowing leading whitespace)', () => {
    assert.equal(hasStructuredHeader('## Goal\nx'), true);
    assert.equal(hasStructuredHeader('\n\n## Goal\nx'), true);
  });

  it('returns false for legacy bodies', () => {
    assert.equal(hasStructuredHeader('Body text\n\n---\nparent: #1'), false);
    assert.equal(hasStructuredHeader(''), false);
    assert.equal(hasStructuredHeader(null), false);
  });
});
