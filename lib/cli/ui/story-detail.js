// lib/cli/ui/story-detail.js
/**
 * The `GET /api/story` detail: the id check, a Story's latest published
 * stage, and the response built from a board row, its dispatch record, its
 * stage record and its log tail. The record is copied field by field, so
 * its `logPath` never leaves the server.
 *
 * @module cli/ui/story-detail
 */

import path from 'node:path';

import { dispatchLogPath } from '../../../.agents/scripts/lib/config/temp-paths.js';
import { parseDeliveryStage } from '../../../.agents/scripts/lib/orchestration/story-stage-publish.js';
import { structuredCommentMarker } from '../../../.agents/scripts/lib/orchestration/ticketing/reads.js';
import { readLogTail } from './log-tail.js';

const STORY_ID_RE = /^[1-9][0-9]{0,9}$/;

/**
 * The `id` query parameter as a number, or `null` when malformed.
 *
 * @param {string} url The request URL, path and query.
 * @returns {number|null}
 */
export function storyIdFrom(url) {
  const id = new URL(url, 'http://localhost').searchParams.get('id');
  return id !== null && STORY_ID_RE.test(id) ? Number(id) : null;
}

const FRICTION_MARKER = structuredCommentMarker('friction');
const HEADING_RE = /^#{1,6}\s+(.+?)\s*#*\s*$/m;

/** A Story's comments, oldest first; a read failure is no comments. */
async function commentsOf(provider, storyId) {
  try {
    return (await provider.getTicketComments(storyId)) ?? [];
  } catch {
    // Advisory only: a Story whose comments cannot be read shows no stage.
    return [];
  }
}

/** The latest comment `parse` returns a value for, or `null`. */
function latest(comments, parse) {
  for (const comment of [...comments].reverse()) {
    const value = parse(comment);
    if (value) return value;
  }
  return null;
}

/** The latest published stage record in `comments`, or `null`. */
const stageFromComments = (comments) =>
  latest(comments, (c) => parseDeliveryStage(c.body));

/** A friction comment's first heading as `{ text, url }`, else `null`. */
function frictionHeading(comment) {
  const body = String(comment.body ?? '');
  if (!body.includes(FRICTION_MARKER)) return null;
  const heading = body.match(HEADING_RE);
  return heading
    ? { text: heading[1], url: comment.html_url ?? comment.url ?? null }
    : null;
}

/** Why the Story is blocked: the latest friction comment's heading, or `null`. */
const blockerFromComments = (comments) => latest(comments, frictionHeading);

/**
 * An in-flight Story's stage, stage time and blocker, from one comments read.
 *
 * @returns {Promise<{ stage: string|null, stageUpdatedAt: string|null,
 *   blocker: { text: string, url: string|null }|null }>}
 */
export async function commentFacts(provider, storyId) {
  const comments = await commentsOf(provider, storyId);
  const stage = stageFromComments(comments);
  return {
    stage: stage?.stage ?? null,
    stageUpdatedAt: stage?.updatedAt ?? null,
    blocker: blockerFromComments(comments),
  };
}

/** The latest published stage record on a Story, or `null`; a read failure is `null`. */
async function stageOf(provider, storyId) {
  return stageFromComments(await commentsOf(provider, storyId));
}

function recordFields(record) {
  if (!record) return null;
  return {
    pid: record.pid ?? null,
    startedAt: record.startedAt ?? null,
    argv: Array.isArray(record.argv) ? record.argv : null,
    sessionId: record.sessionId ?? null,
    sessionUrl: record.sessionUrl ?? null,
  };
}

/** `claude --resume <id>` for a local session; a routine-fired cloud session has none. */
function resumeCommandOf(record) {
  const sessionId = record?.sessionUrl ? null : record?.sessionId;
  return sessionId ? `claude --resume ${sessionId}` : null;
}

/** The row's ticket metadata the detail shows, each with its default. */
const META = Object.entries({
  projectStatus: null,
  labels: [],
  assignees: [],
  epic: null,
  dependsOn: [],
  blocker: null,
});

const ticketMeta = (row) =>
  Object.fromEntries(META.map(([key, empty]) => [key, row[key] ?? empty]));

/** `{ model, effort }` (each `{ value, source }`), or `{ invalid }` naming a bad override. */
const launchOptionsView = ({ ok, detail, ...options }) =>
  ok ? options : { invalid: detail };

/**
 * @param {{ row: object, record: object|null, liveness: object,
 *   provider: object, config: object, repository: string|null,
 *   launchOptions: object }} parts `launchOptions` as `resolveLaunchOptions` returns it.
 */
export async function readStoryDetail({
  row,
  record,
  liveness,
  provider,
  config,
  repository,
  launchOptions,
}) {
  const stage = await stageOf(provider, row.id);
  const dir = path.dirname(dispatchLogPath(row.id, config));
  return {
    id: row.id,
    title: row.title ?? '',
    column: row.column,
    environment: row.environment ?? null,
    launchOptions: launchOptionsView(launchOptions),
    ...ticketMeta(row),
    issueUrl: repository
      ? `https://github.com/${repository}/issues/${row.id}`
      : null,
    pr: row.pr ?? null,
    stage: stage?.stage ?? null,
    history: stage?.history ?? [],
    process: liveness,
    record: recordFields(record),
    resumeCommand: resumeCommandOf(record),
    logTail: readLogTail(record?.logPath, { dir }),
  };
}
