import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { Volume } from 'memfs';
import {
  NOTIFICATIONS_DEFAULTS,
  PROJECT_ROOT,
  resolveConfig,
} from '../../.agents/scripts/lib/config-resolver.js';
import { setupFsMock } from './fs-mock.js';

/**
 * Regression: notify.js reads `orchestration.notifications.{commentEvents,
 * webhookEvents}` directly, and an empty allowlist suppresses the channel
 * entirely. The legacy shim and applyDefaults() must enrich an omitted
 * `github.notifications` block with NOTIFICATIONS_DEFAULTS so comment +
 * webhook channels don't silently disable themselves.
 */
describe('config-resolver — notifications defaults', () => {
  let vol;

  beforeEach((t) => {
    vol = new Volume();
    setupFsMock(t, vol);
    resolveConfig({ bustCache: true });
  });

  it('applies NOTIFICATIONS_DEFAULTS when github.notifications is omitted', () => {
    vol.mkdirSync(PROJECT_ROOT, { recursive: true });
    vol.writeFileSync(
      path.join(PROJECT_ROOT, '.agentrc.json'),
      JSON.stringify({
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        github: { owner: 'org', repo: 'repo', operatorHandle: '@me' },
      }),
    );
    // Epic #2880 / F14B removed `orchestration` from the resolved config
    // (hard-cutover of the legacy shim per `git-conventions.md`). The
    // canonical surface for these defaults is `github.notifications`.
    const { github } = resolveConfig({ bustCache: true });
    assert.deepEqual(github.notifications, {
      mentionOperator: NOTIFICATIONS_DEFAULTS.mentionOperator,
      commentEvents: [...NOTIFICATIONS_DEFAULTS.commentEvents],
      webhookEvents: [...NOTIFICATIONS_DEFAULTS.webhookEvents],
    });
  });
});
