import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { parseTapOutput } from '../../../.agents/scripts/lib/test-profile/parse-tap.js';
import { renderProfileReport } from '../../../.agents/scripts/lib/test-profile/render-report.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/test-profile/sample.tap',
);

test('renderProfileReport lists top slow entries with kind labels', () => {
  const profile = parseTapOutput(fs.readFileSync(fixturePath, 'utf8'));
  const text = renderProfileReport(profile, { topN: 20, wallDurationMs: 1600 });

  assert.match(text, /Total duration: 1\.600s/);
  assert.match(text, /Tests: 2/);
  assert.match(text, /Suites: 2/);
  assert.match(text, /\[suite\]/);
  assert.match(text, /\[test\s\]/);
  assert.match(text, /slowSuite/);
  assert.match(text, /Top 20 slowest/);
});
