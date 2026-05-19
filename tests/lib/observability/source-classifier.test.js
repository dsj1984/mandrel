/**
 * Unit tests for `lib/observability/source-classifier.js`
 * (Epic #2547 / Story #2553 / Task #2556).
 *
 * Pure-function tests: no I/O, no temp dirs. Each case asserts the
 * classifier returns the documented `"framework"` / `"consumer"` tag for
 * a representative input shape.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyPathSource } from '../../../.agents/scripts/lib/observability/source-classifier.js';

describe('source-classifier — framework classification by failingPath', () => {
  it('tags paths under .agents/ as framework', () => {
    assert.equal(
      classifyPathSource('.agents/scripts/story-init.js', ''),
      'framework',
    );
    assert.equal(
      classifyPathSource('repo/.agents/personas/engineer.md', ''),
      'framework',
    );
  });

  it('tags .agentrc.json as framework', () => {
    assert.equal(classifyPathSource('.agentrc.json', ''), 'framework');
    assert.equal(
      classifyPathSource('subproject/.agentrc.json', ''),
      'framework',
    );
  });

  it('tags paths under .claude/ as framework', () => {
    assert.equal(
      classifyPathSource('.claude/settings.json', ''),
      'framework',
    );
    assert.equal(
      classifyPathSource('host/.claude/hooks/post-commit', ''),
      'framework',
    );
  });
});

describe('source-classifier — framework classification by command', () => {
  it('tags commands invoking node .agents/scripts/ as framework', () => {
    assert.equal(
      classifyPathSource(
        '',
        'node .agents/scripts/story-init.js --story 2553',
      ),
      'framework',
    );
  });

  it('tags commands that reference any framework prefix as framework', () => {
    assert.equal(
      classifyPathSource('', 'ls .agents/scripts'),
      'framework',
    );
    assert.equal(
      classifyPathSource('', 'cat .agentrc.json'),
      'framework',
    );
    assert.equal(
      classifyPathSource('', 'rg foo .claude/'),
      'framework',
    );
  });
});

describe('source-classifier — consumer classification', () => {
  it('tags ordinary repo paths as consumer', () => {
    assert.equal(
      classifyPathSource('src/components/Button.tsx', ''),
      'consumer',
    );
    assert.equal(
      classifyPathSource('tests/integration/checkout.test.ts', ''),
      'consumer',
    );
    assert.equal(
      classifyPathSource('package.json', ''),
      'consumer',
    );
  });

  it('tags ordinary commands as consumer', () => {
    assert.equal(
      classifyPathSource('', 'npm run test'),
      'consumer',
    );
    assert.equal(
      classifyPathSource('', 'pnpm install'),
      'consumer',
    );
  });

  it('does NOT confuse `agents` substrings without the dot prefix', () => {
    // Critical: only the dot-prefixed framework directory should match,
    // not a regular folder called "agents" inside the consumer.
    assert.equal(
      classifyPathSource('src/agents/orchestrator.ts', ''),
      'consumer',
    );
    assert.equal(
      classifyPathSource('docs/agents-overview.md', ''),
      'consumer',
    );
  });
});

describe('source-classifier — defaults & coercion', () => {
  it('returns consumer when both inputs are empty strings', () => {
    assert.equal(classifyPathSource('', ''), 'consumer');
  });

  it('returns consumer when both inputs are undefined / null', () => {
    assert.equal(classifyPathSource(undefined, undefined), 'consumer');
    assert.equal(classifyPathSource(null, null), 'consumer');
  });

  it('returns consumer when called with no arguments at all', () => {
    assert.equal(classifyPathSource(), 'consumer');
  });

  it('coerces non-string inputs without throwing', () => {
    assert.equal(classifyPathSource(42, { not: 'a string' }), 'consumer');
    assert.equal(classifyPathSource([], []), 'consumer');
  });
});

describe('source-classifier — framework-wins on mixed inputs', () => {
  it('framework path beats consumer command', () => {
    assert.equal(
      classifyPathSource('.agents/scripts/foo.js', 'npm run test'),
      'framework',
    );
  });

  it('framework command beats consumer path', () => {
    assert.equal(
      classifyPathSource(
        'src/checkout/index.ts',
        'node .agents/scripts/story-init.js',
      ),
      'framework',
    );
  });

  it('both framework still resolves to framework', () => {
    assert.equal(
      classifyPathSource(
        '.agents/scripts/foo.js',
        'node .agents/scripts/foo.js',
      ),
      'framework',
    );
  });
});
