/**
 * epic-ops.test.js — the plan-side container-Epic write (Story #5139).
 *
 * The degradation posture is what these tests mostly pin, because it is
 * deliberately asymmetric and easy to get backwards:
 *
 *   - an unensurable `type::epic` label **skips the Epic entirely** (a
 *     container without the label is not a container — nothing can find it);
 *   - a failed sub-issue edge only **warns** (the body checklist is the
 *     durable mirror).
 *
 * In both cases the Stories are already live and must be left untouched.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GhExecError } from '../../../gh-exec.js';
import { Logger } from '../../../Logger.js';
import { createContainerEpic, EPIC_SUGGESTION_THRESHOLD } from '../epic-ops.js';

const EPIC = { title: 'Auth hardening', goal: 'Group the auth work.' };
const THREE = [{ id: 11 }, { id: 12 }, { id: 13 }];

/** A provider double with every surface `createContainerEpic` reaches for. */
function providerDouble({
  ensure = async () => ({ missing: [] }),
  existing = [],
  create,
  posts = [],
  listThrows = false,
} = {}) {
  const created = [];
  return {
    created,
    posts,
    ensureLabels: ensure,
    listTicketsByLabel: async () => {
      if (listThrows) throw new Error('search down');
      return existing;
    },
    createIssue:
      create ??
      (async (payload) => {
        created.push(payload);
        return { number: 90, id: 90, url: 'https://x/90' };
      }),
    getTicket: async (n) => ({ internalId: n + 90000 }),
    getDependencyWriteContext: () => ({
      owner: 'o',
      repo: 'r',
      gh: {
        api: async ({ method, endpoint, body }) => {
          if (method === 'POST') posts.push({ endpoint, body });
          return {};
        },
      },
    }),
  };
}

describe('createContainerEpic — the no-Epic outcomes', () => {
  it('returns null when no Epic was requested', async () => {
    const provider = providerDouble();
    assert.equal(
      await createContainerEpic({ provider, epic: null, created: THREE }),
      null,
    );
    assert.equal(provider.created.length, 0);
  });

  it('returns null below the 3-Story threshold', async () => {
    const provider = providerDouble();
    const out = await createContainerEpic({
      provider,
      epic: EPIC,
      created: [{ id: 11 }, { id: 12 }],
    });
    assert.equal(out, null);
    assert.equal(provider.created.length, 0);
    assert.equal(EPIC_SUGGESTION_THRESHOLD, 3);
  });

  it('throws when the request carries a title but no goal', async () => {
    await assert.rejects(
      () =>
        createContainerEpic({
          provider: providerDouble(),
          epic: { title: 'T', goal: '' },
          created: THREE,
        }),
      /requires both a title and a goal/,
    );
  });
});

describe('createContainerEpic — the happy path', () => {
  it('creates one type::epic issue with NO agent:: label', async () => {
    const provider = providerDouble();
    const out = await createContainerEpic({
      provider,
      epic: EPIC,
      created: THREE,
    });
    assert.equal(provider.created.length, 1);
    const payload = provider.created[0];
    assert.deepEqual(payload.labels, ['type::epic']);
    assert.ok(
      !payload.labels.some((l) => l.startsWith('agent::')),
      'an Epic must never be born with a lifecycle label',
    );
    assert.equal(out.id, 90);
    assert.deepEqual(out.childIds, [11, 12, 13]);
    assert.equal(out.adopted, false);
  });

  it('embeds every child in the body checklist and stamps a fingerprint', async () => {
    const provider = providerDouble();
    await createContainerEpic({ provider, epic: EPIC, created: THREE });
    const { body } = provider.created[0];
    assert.match(body, /- \[ \] #11\n- \[ \] #12\n- \[ \] #13/);
    assert.match(body, /<!-- mandrel-epic-fingerprint [0-9a-f]{8} -->/);
    assert.ok(!body.includes('## Spec'), 'the container carries no Spec');
  });

  it('links every child as a sub-issue by DATABASE id', async () => {
    const provider = providerDouble();
    const out = await createContainerEpic({
      provider,
      epic: EPIC,
      created: THREE,
    });
    assert.deepEqual(
      provider.posts.map((p) => p.body.sub_issue_id).sort(),
      [90011, 90012, 90013],
    );
    assert.equal(provider.posts[0].endpoint, '/repos/o/r/issues/90/sub_issues');
    assert.deepEqual(out.edges, { added: 3, skipped: 0, failed: 0 });
  });
});

describe('createContainerEpic — dry run', () => {
  it('reports the intended Epic and writes nothing', async () => {
    const provider = providerDouble();
    const out = await createContainerEpic({
      provider,
      epic: EPIC,
      created: THREE,
      opts: { dryRun: true },
    });
    assert.equal(out.id, -1);
    assert.equal(out.title, EPIC.title);
    assert.equal(provider.created.length, 0);
    assert.equal(provider.posts.length, 0);
  });

  it('reports the placeholder ids a dry-run persist produces', async () => {
    const out = await createContainerEpic({
      provider: providerDouble(),
      epic: EPIC,
      created: [{ id: -1 }, { id: -2 }, { id: -3 }],
      opts: { dryRun: true },
    });
    assert.deepEqual(out.childIds, [-1, -2, -3]);
  });
});

describe('createContainerEpic — degradation', () => {
  it('SKIPS the Epic when type::epic cannot be ensured', async () => {
    const provider = providerDouble({
      ensure: async () => ({ missing: ['type::epic'] }),
    });
    const out = await createContainerEpic({
      provider,
      epic: EPIC,
      created: THREE,
    });
    assert.equal(out, null, 'an unlabelled container is not a container');
    assert.equal(provider.created.length, 0);
  });

  it('SKIPS the Epic when the label ensure throws', async () => {
    const provider = providerDouble({
      ensure: async () => {
        throw new Error('labels API down');
      },
    });
    assert.equal(
      await createContainerEpic({ provider, epic: EPIC, created: THREE }),
      null,
    );
  });

  it("warns with gh's own reason when the label ensure throws", async (t) => {
    // Story #5201: the degrade warning logged `err.message` only, which for a
    // classified gh failure is just the exit status — the sentence GitHub
    // actually returned never reached the operator. The Epic-skip posture is
    // unchanged; only the warning gained the reason.
    const warnings = [];
    t.mock.method(Logger, 'warn', (msg) => warnings.push(String(msg)));
    const provider = providerDouble({
      ensure: async () => {
        throw new GhExecError('gh-exec: gh exited with code 1', {
          stderr: 'HTTP 422: Validation Failed\ndescription is too long',
        });
      },
    });
    assert.equal(
      await createContainerEpic({ provider, epic: EPIC, created: THREE }),
      null,
      'the fail-closed skip is unchanged',
    );
    assert.match(warnings.join('\n'), /description is too long/);
  });

  it('still creates the Epic when sub-issue linking fails outright', async () => {
    const provider = providerDouble();
    provider.getDependencyWriteContext = () => {
      throw new Error('no write context');
    };
    const out = await createContainerEpic({
      provider,
      epic: EPIC,
      created: THREE,
    });
    assert.equal(out.id, 90, 'a lost edge must not cost the container');
    assert.equal(out.edges, null);
    assert.match(provider.created[0].body, /- \[ \] #11/);
  });

  it('still creates the Epic on a provider with no write surface at all', async () => {
    const provider = providerDouble();
    provider.getDependencyWriteContext = undefined;
    const out = await createContainerEpic({
      provider,
      epic: EPIC,
      created: THREE,
    });
    assert.equal(out.id, 90);
    assert.equal(out.edges, null);
  });

  it('creates a new container when the resume lookup fails', async () => {
    const provider = providerDouble({ listThrows: true });
    const out = await createContainerEpic({
      provider,
      epic: EPIC,
      created: THREE,
    });
    assert.equal(out.adopted, false);
    assert.equal(provider.created.length, 1);
  });

  it('tolerates a provider with no listTicketsByLabel', async () => {
    const provider = providerDouble();
    provider.listTicketsByLabel = undefined;
    const out = await createContainerEpic({
      provider,
      epic: EPIC,
      created: THREE,
    });
    assert.equal(out.adopted, false);
  });
});

describe('createContainerEpic — resume', () => {
  /** Re-derive the fingerprint the first run stamped. */
  async function fingerprintFor(created) {
    const provider = providerDouble();
    await createContainerEpic({ provider, epic: EPIC, created });
    return provider.created[0].body.match(
      /<!-- mandrel-epic-fingerprint ([0-9a-f]{8}) -->/,
    )[1];
  }

  it('adopts an open Epic carrying the same fingerprint', async () => {
    const fp = await fingerprintFor(THREE);
    const provider = providerDouble({
      // The mapped ticket shape `listTicketsByLabel` returns: `id` is the
      // issue number and the link is `url`.
      existing: [
        {
          id: 77,
          url: 'https://x/77',
          body: `body <!-- mandrel-epic-fingerprint ${fp} -->`,
        },
      ],
    });
    const out = await createContainerEpic({
      provider,
      epic: EPIC,
      created: THREE,
    });
    assert.equal(out.id, 77);
    assert.equal(out.adopted, true);
    assert.equal(
      provider.created.length,
      0,
      'must not open a second container',
    );
    // Adoption still re-links, so a half-linked first attempt completes.
    assert.equal(provider.posts.length, 3);
  });

  it('does NOT adopt a container grouping a different child set', async () => {
    const fp = await fingerprintFor(THREE);
    const provider = providerDouble({
      existing: [{ id: 77, body: `<!-- mandrel-epic-fingerprint ${fp} -->` }],
    });
    // Same title, different Stories — a different container.
    const out = await createContainerEpic({
      provider,
      epic: EPIC,
      created: [{ id: 21 }, { id: 22 }, { id: 23 }],
    });
    assert.equal(out.adopted, false);
    assert.equal(provider.created.length, 1);
  });
});
