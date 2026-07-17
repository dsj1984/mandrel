// tests/lib/framework-version.test.js
/**
 * Unit tests for the framework-version helper.
 *
 * The module is the legacy-stamp marker surface (#4574 deleted the retired
 * stamp producer half). Covers:
 *  - authoredMarkerLine() renders the canonical visible marker string.
 *  - AUTHORED_MARKER_LINE_RE recognises the line authoredMarkerLine emits
 *    (the parser-side contract the serializer round-trip depends on).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUTHORED_MARKER_LINE_RE,
  authoredMarkerLine,
} from '../../.agents/scripts/lib/framework-version.js';

describe('authoredMarkerLine', () => {
  it('renders the canonical marker string', () => {
    assert.equal(
      authoredMarkerLine({ version: '1.86.0', authoredAt: '2026-07-07' }),
      '> 🏷️ Authored with Mandrel v1.86.0 · 2026-07-07',
    );
  });
});

describe('AUTHORED_MARKER_LINE_RE', () => {
  it('matches the line authoredMarkerLine emits', () => {
    const line = authoredMarkerLine({
      version: '1.86.0',
      authoredAt: '2026-07-07',
    });
    assert.match(line, AUTHORED_MARKER_LINE_RE);
  });

  it('does not match ordinary body prose', () => {
    assert.doesNotMatch('## Goal\nDo the thing.', AUTHORED_MARKER_LINE_RE);
    assert.doesNotMatch('> a plain blockquote', AUTHORED_MARKER_LINE_RE);
  });
});
