/**
 * Unit tests for `.agents/scripts/providers/github/comments.js`.
 *
 * Covers comment CRUD (recent / per-ticket / delete / post) plus the
 * structured-comment badge prefix that `postComment` prepends when the
 * payload carries a known `type`.
 *
 * Story #2462 / Task #2480 — CommentGateway is the second slice of the
 * seven-gateway split.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const commentsMod = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'providers', 'github', 'comments.js'),
  ).href
);
const ghExecMod = await import(
  pathToFileURL(path.join(ROOT, '.agents', 'scripts', 'lib', 'gh-exec.js')).href
);

const { CommentGateway } = commentsMod;
const { createGh } = ghExecMod;

function makeFakeGh(routes) {
  const calls = [];
  const exec = async ({ args, input }) => {
    calls.push({ args, input });
    const method = args[2] ?? 'GET';
    const endpoint = args[3] ?? '';
    for (const [key, val] of Object.entries(routes)) {
      const [m, ...rest] = key.split(' ');
      if (m === method && endpoint.includes(rest.join(' '))) {
        if (val.status >= 200 && val.status < 300) {
          return {
            stdout: JSON.stringify(val.json ?? {}),
            stderr: '',
            code: 0,
          };
        }
        const err = new Error(`gh-exec: gh exited with code ${val.status}`);
        err.code = val.status;
        throw err;
      }
    }
    return { stdout: '{}', stderr: '', code: 0 };
  };
  exec.calls = calls;
  const gh = createGh(exec);
  gh.__exec = exec;
  return gh;
}

describe('providers/github/comments.js — CommentGateway', () => {
  it('getTicketComments: paginates the per-ticket comments endpoint', async () => {
    const gh = makeFakeGh({
      'GET /issues/42/comments': {
        status: 200,
        json: [{ id: 9, body: 'c1' }],
      },
    });
    const gw = new CommentGateway({ gh, owner: 'o', repo: 'r' });
    const out = await gw.getTicketComments(42);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 9);
  });

  it('getRepoCommentsSince: one paginated repo-wide read with an encoded since', async () => {
    const gh = makeFakeGh({
      'GET /repos/o/r/issues/comments?since=': {
        status: 200,
        json: [{ id: 7, body: 'c', issue_url: '.../issues/3' }],
      },
    });
    const gw = new CommentGateway({ gh, owner: 'o', repo: 'r' });
    const out = await gw.getRepoCommentsSince('2026-11-01T00:00:00Z');
    assert.equal(out[0].id, 7);
    assert.match(
      gh.__exec.calls[0].args[3],
      /issues\/comments\?since=2026-11-01T00%3A00%3A00Z&page=1/,
    );
  });

  it('getRepoCommentsSince: reads past the default 50-page cap on a wide window', async () => {
    const exec = async ({ args }) => {
      const page = Number(/[?&]page=(\d+)/.exec(args[3])[1]);
      const n = page <= 60 ? 100 : 7;
      const items = Array.from({ length: n }, (_, i) => ({
        id: page * 1000 + i,
      }));
      return { stdout: JSON.stringify(items), stderr: '', code: 0 };
    };
    const gw = new CommentGateway({
      gh: createGh(exec),
      owner: 'o',
      repo: 'r',
    });
    const out = await gw.getRepoCommentsSince('2020-01-01T00:00:00Z');
    assert.equal(out.length, 6007);
  });

  it('deleteComment: issues a DELETE call against the comments endpoint', async () => {
    const gh = makeFakeGh({
      'DELETE /issues/comments/123': { status: 204, json: {} },
    });
    const gw = new CommentGateway({ gh, owner: 'o', repo: 'r' });
    await gw.deleteComment(123);
    assert.equal(gh.__exec.calls.length, 1);
    assert.equal(gh.__exec.calls[0].args[2], 'DELETE');
  });

  it('postComment: prepends the structured-comment badge when payload.type is known', async () => {
    const invalidated = [];
    const gh = makeFakeGh({
      'POST /issues/55/comments': {
        status: 201,
        json: { id: 999 },
      },
    });
    const gw = new CommentGateway({
      gh,
      owner: 'o',
      repo: 'r',
      hooks: { invalidateTicket: (id) => invalidated.push(id) },
    });
    const out = await gw.postComment(55, {
      body: 'Working...',
      type: 'progress',
    });
    assert.equal(out.commentId, 999);
    assert.deepEqual(invalidated, [55]);
    const sentBody = JSON.parse(gh.__exec.calls[0].input).body;
    assert.ok(sentBody.startsWith('🔄 **Progress**'));
    assert.ok(sentBody.includes('Working...'));
  });

  it('postComment: accepts a bare string body (legacy shape)', async () => {
    const gh = makeFakeGh({
      'POST /issues/55/comments': { status: 201, json: { id: 1 } },
    });
    const gw = new CommentGateway({ gh, owner: 'o', repo: 'r' });
    const out = await gw.postComment(55, 'plain body');
    assert.equal(out.commentId, 1);
    const sentBody = JSON.parse(gh.__exec.calls[0].input).body;
    assert.equal(sentBody, 'plain body');
  });

  it('postComment: skips the badge when payload.type is unknown', async () => {
    const gh = makeFakeGh({
      'POST /issues/55/comments': { status: 201, json: { id: 2 } },
    });
    const gw = new CommentGateway({ gh, owner: 'o', repo: 'r' });
    await gw.postComment(55, { body: 'msg', type: 'unknown-type' });
    const sentBody = JSON.parse(gh.__exec.calls[0].input).body;
    assert.equal(sentBody, 'msg');
  });

  // Story #2852: end-to-end retry exercised through getTicketComments to
  // prove paginateRest's wrap survives a real gateway round-trip.
  it('getTicketComments: retries on a transient 502 and recovers without losing prior pages', async () => {
    // Three logical pages: full-page 1, transient 502, page 2 (short).
    // The gw passes through paginateRest → withTransientRetry → gh.api,
    // so the retry must be observed at the api-call level.
    const fullPage = new Array(100).fill(0).map((_, i) => ({
      id: i + 1,
      body: `c${i + 1}`,
    }));
    let call = 0;
    const gh = {
      api: async () => {
        call++;
        if (call === 1) {
          return { stdout: JSON.stringify(fullPage), stderr: '', code: 0 };
        }
        if (call === 2) {
          const err = new Error('gh: HTTP 502');
          err.status = 502;
          throw err;
        }
        // Retry of page 2 succeeds with a short page.
        return {
          stdout: JSON.stringify([{ id: 101, body: 'c101' }]),
          stderr: '',
          code: 0,
        };
      },
    };
    const gw = new CommentGateway({ gh, owner: 'o', repo: 'r' });
    // The default retry sleeps with setTimeout — keep delay small so the
    // test stays fast. The retry path itself is verified by the call count.
    const out = await gw.getTicketComments(42);
    assert.equal(out.length, 101);
    assert.equal(call, 3, 'transient triggered exactly one retry of page 2');
  });
});
