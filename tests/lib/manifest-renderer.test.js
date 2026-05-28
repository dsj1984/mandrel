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
  // Story #3194 (Epic #3163) dropped the Tasks column; helpers now tally
  // Story-tier counts only. Story #3196 will pivot the per-wave H2 body
  // off Task-tier counts in turn.
  assert.ok(
    output.includes('| Wave | Status | Stories |'),
    'Missing wave summary table header',
  );
  assert.ok(output.includes('Wave 1'), 'Missing wave row data');

  // Verify per-wave nested H2/H3 layout (Story #1194 Task #1212): the
  // legacy `## Execution Plan` table was replaced with one `## Wave N`
  // section per wave nesting Stories (H3) and Tasks (checkbox lists).
  assert.ok(
    !output.includes('## Execution Plan'),
    'Legacy Execution Plan heading should be gone',
  );
  assert.ok(
    !output.includes('## Story Details'),
    'Legacy Story Details heading should be gone',
  );
  assert.ok(output.match(/^## .* Wave 1/m), 'Missing per-wave H2 heading');
  assert.ok(output.includes('### '), 'Missing per-Story H3 heading');
  assert.ok(output.includes('#10'), 'Missing story id reference');
});
