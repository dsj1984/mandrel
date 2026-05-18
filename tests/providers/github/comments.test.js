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
  it('getRecentComments: GETs the repo comments feed', async () => {
    const gh = makeFakeGh({
      'GET /issues/comments': {
        status: 200,
        json: [
          { id: 1, body: 'hello' },
          { id: 2, body: 'world' },
        ],
      },
    });
    const gw = new CommentGateway({ gh, owner: 'o', repo: 'r' });
    const out = await gw.getRecentComments(50);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 1);
  });

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
});
