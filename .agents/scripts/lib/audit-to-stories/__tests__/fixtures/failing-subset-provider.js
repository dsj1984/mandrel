/**
 * Test fixture (Story #4678, AC-8): a dedup provider whose fingerprint lookup
 * throws an HTTP 422 for a deterministic subset of calls and resolves to no
 * match otherwise. Loaded via the `AUDIT_TO_STORIES_PROVIDER_FIXTURE` seam so
 * the real `--scan` CLI exercises the soft-fail path end-to-end without any
 * network. The scan must still exit 0.
 */

const state = { calls: 0 };

export default {
  async findIssuesByFingerprint() {
    state.calls += 1;
    // Fail on every other lookup so the run always covers a genuine subset:
    // some groups degrade to create, the rest classify normally.
    if (state.calls % 2 === 0) {
      const err = new Error(
        'Validation Failed: the search is longer than 256 characters',
      );
      err.status = 422;
      throw err;
    }
    return [];
  },
};
