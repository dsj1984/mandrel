import assert from 'node:assert/strict';
import test from 'node:test';
import { renderManifestMarkdown } from '../../.agents/scripts/lib/presentation/manifest-renderer.js';

test('manifest-renderer: renders simple manifest', () => {
  const manifest = {
    epicId: 1,
    epicTitle: 'Epic',
    summary: 'Summary',
    storyManifest: [
      {
        storyId: 10,
        storySlug: 'story-10',
        tasks: [{ id: 101, title: 'T1' }],
        type: 'story',
        earliestWave: 1,
      },
    ],
    dryRun: true,
    generatedAt: new Date().toISOString(),
  };

  const output = renderManifestMarkdown(manifest);

  // Verify Epic Header
  assert.ok(
    output.includes('# 📋 Dispatch Manifest — Epic #1'),
    'Missing epic header',
  );

  // Verify Wave Header and Table Structure
  assert.ok(output.includes('## Wave Summary'), 'Missing waves section');
  assert.ok(
    output.includes('| Wave | Status | Progress | Stories | Tasks |'),
    'Missing wave summary table header',
  );
  assert.ok(output.includes('Wave 1'), 'Missing wave row data');

  // Verify Story Execution Plan Header and Table Structure
  assert.ok(
    output.includes('## Execution Plan'),
    'Missing story execution plan section',
  );
  assert.ok(
    output.includes('| | Story | Title | Tasks |'),
    'Missing story execution table header',
  );
  assert.ok(
    output.includes('| ⬜ | #10 | story-10 |'),
    'Missing story row data',
  );
});
