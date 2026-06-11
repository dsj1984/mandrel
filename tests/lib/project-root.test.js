/**
 * project-root — proves the `PROJECT_ROOT` leaf module extracted from
 * `config-resolver.js` (Story #3993) resolves the identical path the
 * old in-barrel computation produced, and that the barrel re-export
 * keeps the public surface unchanged.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT as BARREL_PROJECT_ROOT } from '../../.agents/scripts/lib/config-resolver.js';
import { PROJECT_ROOT } from '../../.agents/scripts/lib/project-root.js';

describe('lib/project-root', () => {
  it('resolves the identical path as the old config-resolver computation', () => {
    // The legacy computation lived in .agents/scripts/lib/config-resolver.js:
    // path.resolve(dirname(config-resolver.js), '../../..') → project root.
    const libDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '.agents',
      'scripts',
      'lib',
    );
    const legacy = path.resolve(libDir, '../../..');
    assert.equal(PROJECT_ROOT, legacy);
  });

  it('is re-exported unchanged from the config-resolver barrel', () => {
    assert.equal(BARREL_PROJECT_ROOT, PROJECT_ROOT);
  });
});
