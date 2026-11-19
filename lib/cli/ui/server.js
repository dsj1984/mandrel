// lib/cli/ui/server.js
/**
 * The `mandrel ui` HTTP server, Node built-ins only. It stores nothing: a
 * state read is recomputed through `sources.readState` (reused for at most
 * `cacheMs` to coalesce polls), and an action runs through
 * `sources.runAction`. Every response carries the security headers; every
 * error body is `{ "error": "<code>" }`. A failed state read answers 503
 * with the source's safe code and logs its cause to the operator's
 * terminal, never to the page.
 *
 * @module cli/ui/server
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  doneLimitFrom,
  isAllowedHost,
  isSameOriginJson,
  MAX_BODY_BYTES,
  tokenMatches,
  validateAction,
  validateLaunchOptions,
} from './request-guard.js';
import { storyIdFrom } from './story-detail.js';

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
});

/** The only files served; nothing else on disk is reachable. */
const STATIC_FILES = Object.freeze({
  '/board.js': 'text/javascript; charset=utf-8',
  '/board-model.js': 'text/javascript; charset=utf-8',
  '/panel-model.js': 'text/javascript; charset=utf-8',
  '/preferences.js': 'text/javascript; charset=utf-8',
  '/board-filter.js': 'text/javascript; charset=utf-8',
  '/board.css': 'text/css; charset=utf-8',
});

const TOKEN_PLACEHOLDER = '__MANDREL_TOKEN__';

/** HTTP status for a dispatch exit code: success, refusal, failure. */
const ACTION_STATUS = { 0: 200, 2: 409 };

/** State-read failure codes the page may see; any other is `state-unavailable`. */
const STATE_CODES = new Set([
  'config-invalid',
  'no-github-repo',
  'state-unavailable',
]);

function send(res, status, contentType, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': contentType });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

class RequestError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/**
 * Read a body of at most MAX_BODY_BYTES; larger is a 400 before parsing.
 * Bytes past the cap are drained, not kept, so the response still reaches
 * the client.
 */
async function readJsonBody(req) {
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    throw new RequestError(400, 'body-too-large');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw new RequestError(400, 'body-too-large');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'invalid-json');
  }
}

/**
 * @param {{
 *   token: string,
 *   sources: {
 *     readState: (doneLimit: number) => Promise<object>,
 *     readConnections: () => Promise<object>,
 *     readStory: (id: number, state: object) => Promise<object|null>,
 *     runAction: (a: { action: string, storyId: number, environment: string }) => Promise<{ code: number, envelope: object }>,
 *     environmentNames: () => string[],
 *     launchChoices: () => { models: string[], efforts: string[] },
 *     setLaunchOptions: (o: { storyId: number, model: string|null, effort: string|null }) => Promise<{ ok: boolean }>,
 *   },
 *   cacheMs?: number,
 *   now?: () => number,
 *   log?: (s: string) => void,
 *   uiDir?: string,
 * }} options
 * @returns {import('node:http').Server} Not yet listening.
 */
export function createUiServer({
  token,
  sources,
  cacheMs = 5000,
  now = Date.now,
  log = process.stderr.write.bind(process.stderr),
  uiDir = UI_DIR,
}) {
  /** One cached read per Done limit. */
  const cached = new Map();
  const isFresh = (entry) => entry && now() - entry.at < cacheMs;
  const evict = (key, entry) => {
    if (cached.get(key) === entry) cached.delete(key);
  };

  function readState(doneLimit) {
    const hit = cached.get(doneLimit);
    if (isFresh(hit)) return hit.promise;
    const promise = sources.readState(doneLimit).catch((err) => {
      log(
        `mandrel ui: board state read failed: ${err?.detail ?? err?.message}\n`,
      );
      const code = STATE_CODES.has(err?.code) ? err.code : 'state-unavailable';
      throw new RequestError(503, code);
    });
    const entry = { at: now(), promise };
    cached.set(doneLimit, entry);
    entry.promise.catch(() => evict(doneLimit, entry));
    return entry.promise;
  }

  /** The state for the request's `done` parameter; any other value is a 400. */
  function stateFor(req) {
    const doneLimit = doneLimitFrom(req.url);
    if (doneLimit === null) throw new RequestError(400, 'invalid-done-limit');
    return readState(doneLimit);
  }

  /** The same-origin JSON body checked by `validate`; a 403 or 400 otherwise. */
  async function checkedBody(req, validate) {
    if (!isSameOriginJson(req.headers))
      throw new RequestError(403, 'forbidden');
    const checked = validate(await readJsonBody(req));
    if (!checked.ok) throw new RequestError(400, checked.error);
    return checked.value;
  }

  async function postLaunchOptions(req, res) {
    const value = await checkedBody(req, (body) =>
      validateLaunchOptions(body, sources.launchChoices()),
    );
    const result = await sources.setLaunchOptions(value);
    cached.clear();
    sendJson(res, result.ok ? 200 : 409, result);
  }

  async function postAction(req, res) {
    const value = await checkedBody(req, (body) =>
      validateAction(body, sources.environmentNames()),
    );
    const { code, envelope } = await sources.runAction(value);
    cached.clear();
    const status = ACTION_STATUS[code];
    if (!status) throw new RequestError(500, 'action-failed');
    sendJson(res, status, envelope);
  }

  async function getStory(req, res) {
    const id = storyIdFrom(req.url);
    if (id === null) throw new RequestError(400, 'invalid-id');
    const detail = await sources.readStory(id, await stateFor(req));
    if (!detail) throw new RequestError(404, 'not-found');
    sendJson(res, 200, detail);
  }

  const API = {
    'GET /api/state': async (req, res) =>
      sendJson(res, 200, await stateFor(req)),
    'GET /api/story': getStory,
    'GET /api/connections': async (_req, res) =>
      sendJson(res, 200, await sources.readConnections()),
    'POST /api/action': postAction,
    'POST /api/launch-options': postLaunchOptions,
  };

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET') throw new RequestError(405, 'method-not-allowed');
    if (pathname === '/') {
      const html = fs.readFileSync(path.join(uiDir, 'board.html'), 'utf8');
      send(
        res,
        200,
        'text/html; charset=utf-8',
        html.replace(TOKEN_PLACEHOLDER, token),
      );
      return;
    }
    const type = STATIC_FILES[pathname];
    if (!type) throw new RequestError(404, 'not-found');
    send(res, 200, type, fs.readFileSync(path.join(uiDir, pathname.slice(1))));
  }

  async function route(req, res, port) {
    if (!isAllowedHost(req.headers.host, port)) {
      throw new RequestError(403, 'forbidden');
    }
    const { pathname } = new URL(req.url, 'http://localhost');
    if (!pathname.startsWith('/api/')) {
      serveStatic(req, res, pathname);
      return;
    }
    if (!tokenMatches(req.headers['x-mandrel-token'], token)) {
      throw new RequestError(403, 'forbidden');
    }
    const handler = API[`${req.method} ${pathname}`];
    if (!handler) throw new RequestError(404, 'not-found');
    await handler(req, res);
  }

  const server = http.createServer((req, res) => {
    route(req, res, server.address().port).catch((err) => {
      const status = err instanceof RequestError ? err.status : 500;
      const code = err instanceof RequestError ? err.code : 'internal';
      sendJson(res, status, { error: code });
    });
  });
  return server;
}
