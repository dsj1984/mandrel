/**
 * WaveObserver — emits `wave-start` and `wave-end` structured comments on
 * the Epic issue at each wave boundary.
 *
 * Each comment type uses a wave-indexed HTML marker so subsequent runs can
 * upsert without duplicating history from prior waves. The comment body is
 * a compact markdown report plus a fenced JSON block with the raw manifest
 * and story outcomes — the same shape consumed by the retro tooling.
 */

import {
  structuredCommentMarker,
  upsertStructuredComment,
} from '../ticketing.js';
import { COMMIT_ASSERTION_ZERO_DELTA_DETAIL } from './commit-assertion.js';

const WAVE_START_TYPE = (index) => `wave-${index}-start`;
const WAVE_END_TYPE = (index) => `wave-${index}-end`;

export class WaveObserver {
  /**
   * @param {{
   *   provider: import('../../ITicketingProvider.js').ITicketingProvider,
   *   epicId: number,
   *   logger?: { warn: Function },
   * }} opts
   */
  constructor(opts = {}) {
    const ctx = opts.ctx;
    const provider = opts.provider ?? ctx?.provider;
    const epicId = opts.epicId ?? ctx?.epicId;
    if (!provider) throw new TypeError('WaveObserver requires a provider');
    if (!Number.isInteger(epicId)) {
      throw new TypeError('WaveObserver requires a numeric epicId');
    }
    this.provider = provider;
    this.epicId = epicId;
    this.logger = opts.logger ?? ctx?.logger ?? console;
    this.commitAssertion = opts.commitAssertion ?? ctx?.commitAssertion ?? null;
  }

  /**
   * @param {{ index: number, totalWaves: number, stories: Array<{ id: number, title?: string }> }} wave
   */
  async waveStart(wave) {
    const startedAt = new Date().toISOString();
    const body = [
      `### 🚀 Wave ${wave.index + 1}/${wave.totalWaves} starting`,
      '',
      `Started: \`${startedAt}\``,
      `Stories: ${wave.stories.length}`,
      '',
      ...wave.stories.map((s) => `- #${s.id}${s.title ? ` — ${s.title}` : ''}`),
      '',
      '```json',
      JSON.stringify(
        {
          kind: 'wave-start',
          index: wave.index,
          totalWaves: wave.totalWaves,
          startedAt,
          stories: wave.stories.map((s) => ({ id: s.id, title: s.title })),
        },
        null,
        2,
      ),
      '```',
    ].join('\n');
    await this.#upsert(WAVE_START_TYPE(wave.index), body);
    return { startedAt };
  }

  /**
   * @param {{
   *   index: number,
   *   totalWaves: number,
   *   startedAt?: string,
   *   stories: Array<{ storyId: number, status: string, detail?: string }>,
   * }} wave
   */
  async waveEnd(wave) {
    const completedAt = new Date().toISOString();
    const durationMs = wave.startedAt
      ? new Date(completedAt).getTime() - new Date(wave.startedAt).getTime()
      : null;
    const stories = await this.#applyCommitAssertion(wave.stories);
    const ok = stories.filter((s) => s.status === 'done').length;
    const bad = stories.length - ok;
    const body = [
      `### 🏁 Wave ${wave.index + 1}/${wave.totalWaves} ${bad === 0 ? 'completed' : 'halted'}`,
      '',
      `Completed: \`${completedAt}\`${durationMs != null ? ` (${formatDuration(durationMs)})` : ''}`,
      `Outcomes: ${ok} done · ${bad} failed/blocked`,
      '',
      ...stories.map((s) => {
        const icon = s.status === 'done' ? '✅' : '❌';
        const suffix = s.detail ? ` — ${s.detail}` : '';
        return `- ${icon} #${s.storyId} \`${s.status}\`${suffix}`;
      }),
      '',
      '```json',
      JSON.stringify(
        {
          kind: 'wave-end',
          index: wave.index,
          totalWaves: wave.totalWaves,
          startedAt: wave.startedAt,
          completedAt,
          durationMs,
          stories,
        },
        null,
        2,
      ),
      '```',
    ].join('\n');
    await this.#upsert(WAVE_END_TYPE(wave.index), body);
    return { completedAt, durationMs, stories };
  }

  /**
   * Consult the injected `CommitAssertion` (if any) and reclassify `done`
   * stories with zero new commits on their story branch as `failed`.
   * Returns a new array — the caller's input is not mutated.
   */
  async #applyCommitAssertion(rows) {
    if (!this.commitAssertion) return [...rows];
    const doneIds = rows
      .filter((s) => s.status === 'done')
      .map((s) => s.storyId);
    if (doneIds.length === 0) return [...rows];
    let deltas;
    try {
      deltas = await this.commitAssertion.check(doneIds, {
        epicId: this.epicId,
      });
    } catch (err) {
      this.logger.warn?.(
        `[WaveObserver] commit-assertion check failed: ${err?.message ?? err}`,
      );
      return [...rows];
    }
    const byId = new Map(deltas.map((d) => [d.storyId, d]));
    return rows.map((row) => {
      if (row.status !== 'done') return { ...row };
      const delta = byId.get(row.storyId);
      if (!delta || delta.newCommitCount !== 0) return { ...row };
      return {
        ...row,
        status: 'failed',
        detail: COMMIT_ASSERTION_ZERO_DELTA_DETAIL,
        newCommitCount: 0,
      };
    });
  }

  async #upsert(type, body) {
    try {
      await upsertStructuredComment(this.provider, this.epicId, type, body);
    } catch (err) {
      this.logger.warn?.(
        `[WaveObserver] failed to upsert ${type}: ${err?.message ?? err}`,
      );
    }
  }
}

export function waveStartMarker(index) {
  return structuredCommentMarker(WAVE_START_TYPE(index));
}

export function waveEndMarker(index) {
  return structuredCommentMarker(WAVE_END_TYPE(index));
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m${rem > 0 ? ` ${rem}s` : ''}`;
}
