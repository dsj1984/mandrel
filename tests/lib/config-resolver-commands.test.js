import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { Volume } from 'memfs';
import {
  COMMANDS_DEFAULTS,
  PROJECT_ROOT,
  resolveConfig,
} from '../../.agents/scripts/lib/config-resolver.js';
import { setupFsMock } from './fs-mock.js';

/**
 * Regression: callers that read `config.project.commands.test` directly
 * (without `getCommands()`) previously got `undefined` when the operator
 * omitted the `commands` block. `applyDefaults()` now enriches the
 * canonical block with COMMANDS_DEFAULTS so every field is present.
 */
describe('config-resolver — commands defaults', () => {
  let vol;

  beforeEach((t) => {
    vol = new Volume();
    setupFsMock(t, vol);
    resolveConfig({ bustCache: true });
  });

  it('applies COMMANDS_DEFAULTS when project.commands is omitted', () => {
    vol.mkdirSync(PROJECT_ROOT, { recursive: true });
    vol.writeFileSync(
      path.join(PROJECT_ROOT, '.agentrc.json'),
      JSON.stringify({
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
      }),
    );
    const { project, agentSettings } = resolveConfig({ bustCache: true });
    assert.deepEqual(project.commands, agentSettings.commands);
    assert.equal(project.commands.test, COMMANDS_DEFAULTS.test);
    assert.equal(project.commands.lintBaseline, COMMANDS_DEFAULTS.lintBaseline);
    assert.equal(project.commands.formatCheck, COMMANDS_DEFAULTS.formatCheck);
  });
});
