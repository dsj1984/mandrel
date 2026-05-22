// tests/contract/delivery/skip-ci-story-commits.test.js
/**
 * Contract test — Story #2899 Task #2928 (Epic #2880, F13).
 *
 * With `delivery.ci.skipForStoryPushes: true` (the framework default),
 * `task-commit.js` MUST append a trailing `[skip ci]` marker to per-Task
 * Story-branch commit subjects so the push-per-Task pattern does not
 * stampede the CI fleet. With `delivery.ci.skipForStoryPushes: false`,
 * the same subject MUST NOT carry the marker. The Epic-branch merge
 * commit produced by `story-close.js`'s merge runner uses
 * `buildMergeMessage` (a separate helper that does NOT consult
 * `buildCommitSubject`); the marker MUST NOT appear there regardless of
 * the config value.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCommitSubject,
  resolveSkipCiFlag,
} from '../../../.agents/scripts/task-commit.js';
import { buildMergeMessageWithCap } from '../../../.agents/scripts/lib/orchestration/story-close/merge-subject.js';

describe('contract/delivery/skip-ci-story-commits', () => {
  describe('buildCommitSubject (Story-branch per-Task commits)', () => {
    it('appends [skip ci] when skipCi=true (config skipForStoryPushes: true)', () => {
      const subject = buildCommitSubject({
        type: 'feat',
        scope: 'delivery',
        title: 'Append skip-ci marker',
        taskId: 1234,
        skipCi: true,
      });
      assert.ok(
        subject.endsWith(' [skip ci]'),
        `expected trailing [skip ci], got ${JSON.stringify(subject)}`,
      );
      // Sanity: the conventional-commit body is still intact in front.
      assert.match(
        subject,
        /^feat\(delivery\): append skip-ci marker \(resolves #1234\) \[skip ci\]$/,
      );
    });

    it('omits [skip ci] when skipCi=false (config skipForStoryPushes: false)', () => {
      const subject = buildCommitSubject({
        type: 'feat',
        scope: 'delivery',
        title: 'No marker when opted out',
        taskId: 1235,
        skipCi: false,
      });
      assert.equal(subject.includes('[skip ci]'), false);
    });

    it('omits [skip ci] when skipCi is unspecified', () => {
      const subject = buildCommitSubject({
        type: 'feat',
        scope: 'delivery',
        title: 'No marker by default param',
        taskId: 1236,
      });
      assert.equal(subject.includes('[skip ci]'), false);
    });
  });

  describe('resolveSkipCiFlag (config consultation)', () => {
    it('returns true when the operator config sets skipForStoryPushes:true', () => {
      const flag = resolveSkipCiFlag({
        resolveConfigImpl: () => ({
          delivery: { ci: { skipForStoryPushes: true } },
        }),
        getCiDeliveryImpl: (cfg) => ({
          skipForStoryPushes: cfg.delivery.ci.skipForStoryPushes,
        }),
      });
      assert.equal(flag, true);
    });

    it('returns false when the operator config sets skipForStoryPushes:false', () => {
      const flag = resolveSkipCiFlag({
        resolveConfigImpl: () => ({
          delivery: { ci: { skipForStoryPushes: false } },
        }),
        getCiDeliveryImpl: (cfg) => ({
          skipForStoryPushes: cfg.delivery.ci.skipForStoryPushes,
        }),
      });
      assert.equal(flag, false);
    });

    it('honors an explicit CLI override over the config', () => {
      const flag = resolveSkipCiFlag({
        cliFlag: false,
        resolveConfigImpl: () => ({
          delivery: { ci: { skipForStoryPushes: true } },
        }),
        getCiDeliveryImpl: (cfg) => ({
          skipForStoryPushes: cfg.delivery.ci.skipForStoryPushes,
        }),
      });
      assert.equal(flag, false);
    });
  });

  describe('buildMergeMessageWithCap (Epic-branch merge commit)', () => {
    it('never carries [skip ci] in the merge subject (path is config-agnostic)', () => {
      const { message } = buildMergeMessageWithCap({
        type: 'feat',
        title: 'Performance defaults and preflight CLI',
        storyId: 2899,
        headerMaxLength: 100,
        logger: { warn: () => {} },
      });
      assert.equal(message.includes('[skip ci]'), false);
    });
  });
});
