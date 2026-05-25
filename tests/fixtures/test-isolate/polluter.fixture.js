/**
 * Fixture for test-isolate self-test. This file is intentionally named with
 * `.fixture.js` (not `.test.js`) so it stays out of the default discovery
 * glob. The test-isolate suite invokes it explicitly.
 *
 * The single test mutates `process.env.TEST_ISOLATE_FIXTURE_VAR` and never
 * restores it — modelling the F14B-class pollution pattern that motivated
 * Story #2963.
 */

import { test } from 'node:test';

test('polluter: sets env var and never cleans up', () => {
  process.env.TEST_ISOLATE_FIXTURE_VAR = 'leaked';
});
