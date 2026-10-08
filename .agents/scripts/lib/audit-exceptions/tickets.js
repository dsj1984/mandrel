/**
 * Resolve the tickets exceptions cite to `open` / `closed`, so an exception
 * whose every ticket is closed reads as orphaned. Unique refs only, capped;
 * a missing or unauthenticated `gh` degrades the run instead of failing it.
 *
 * @module lib/audit-exceptions/tickets
 */

import {
  gh as defaultGh,
  GhAuthError,
  GhNotFoundError,
  GhNotInstalledError,
} from '../gh-exec.js';
import { gitSpawn } from '../git-utils.js';

export const DEFAULT_TICKET_LIMIT = 50;

/**
 * `owner/repo` of the analysed checkout's `origin`, or `null`.
 *
 * @param {string} root
 * @returns {string|null}
 */
function originSlug(root) {
  const res = gitSpawn(root, 'remote', 'get-url', 'origin');
  if (res.status !== 0) return null;
  return (
    /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(
      res.stdout.trim(),
    )?.[1] ?? null
  );
}

function qualify(ref, slug) {
  const [repo, num] = ref.split('#');
  const owner = repo || slug;
  return owner ? { owner, num } : null;
}

async function fetchState(ghFacade, target) {
  const res = await ghFacade.api({
    endpoint: `repos/${target.owner}/issues/${target.num}`,
    fields: ['state'],
  });
  return String(res?.stdout ?? res ?? '').trim();
}

/**
 * @param {string[]} refs
 * @param {object} opts
 * @param {string} opts.root
 * @param {number} [opts.limit]
 * @param {object} [opts.gh] - `createGh()` facade (test seam).
 * @returns {Promise<{ states: Map<string, string>, degradations: object[] }>}
 */
export async function resolveTicketStates(
  refs,
  { root, limit = DEFAULT_TICKET_LIMIT, gh = defaultGh },
) {
  const states = new Map();
  const degradations = [];
  const unique = [...new Set(refs)];
  if (unique.length === 0) return { states, degradations };
  if (unique.length > limit) {
    degradations.push({
      input: 'ticket-limit',
      reason: `only the first ${limit} of ${unique.length} cited tickets were resolved`,
      detail: '',
    });
  }
  const slug = originSlug(root);
  if (!slug && unique.some((ref) => ref.startsWith('#'))) {
    degradations.push({
      input: 'origin',
      reason: 'no GitHub origin remote; same-repo #N refs were not resolved',
      detail: '',
    });
  }
  for (const ref of unique.slice(0, limit)) {
    const target = qualify(ref, slug);
    if (!target) continue;
    try {
      states.set(ref, await fetchState(gh, target));
    } catch (err) {
      if (err instanceof GhNotFoundError) continue;
      const fatal =
        err instanceof GhNotInstalledError || err instanceof GhAuthError;
      degradations.push({
        input: 'gh',
        reason: 'ticket states unavailable',
        detail: err?.message ?? String(err),
      });
      if (fatal) break;
    }
  }
  return { states, degradations };
}
