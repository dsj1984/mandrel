/**
 * gh-pr-rest.js — the `gh pr` facade over repo-scoped REST, for a session
 * whose GitHub proxy refuses GraphQL (which every `gh pr` subcommand needs).
 *
 * Same signatures as `createGh().pr`, and rows in `gh`'s camelCase `--json`
 * shape for exactly the fields current callers request. Only the flags those
 * callers pass are parsed: any other flag or field throws, so a new caller
 * cannot silently lose one. Every request is `repos/{owner}/{repo}/…` — `gh
 * api` fills the placeholders from the current checkout — so the REST path
 * never touches `graphql`, `search/*`, or a user/org endpoint.
 *
 * Takes its `api` and error class by injection so `gh-exec.js` can build it
 * without an import cycle.
 */

/** Arm outcome when the CCR auto-merge route refuses: the merge wait merges on green. */
export const REST_MERGE_ON_GREEN = 'rest-merge-on-green';

const REPO = 'repos/{owner}/{repo}';

/** Flag grammar per subcommand: `value` takes the next argv entry, `bool` does not. */
const FLAG_SPECS = Object.freeze({
  list: {
    '--head': 'value',
    '--state': 'value',
    '--base': 'value',
    '--limit': 'value',
  },
  create: {
    '--base': 'value',
    '--head': 'value',
    '--title': 'value',
    '--body': 'value',
    '--draft': 'bool',
  },
  edit: { '--title': 'value', '--body': 'value' },
  merge: {
    '--auto': 'bool',
    '--squash': 'bool',
    '--delete-branch': 'bool',
    '--disable-auto': 'bool',
    '--match-head-commit': 'value',
  },
  'update-branch': {},
});

function upper(value, fallback = '') {
  return typeof value === 'string' && value ? value.toUpperCase() : fallback;
}

function mapAutoMerge(autoMerge) {
  if (!autoMerge) return null;
  return {
    enabledAt: null,
    mergeMethod: upper(autoMerge.merge_method),
    enabledBy: { login: autoMerge.enabled_by?.login ?? null },
  };
}

/** Field → reader over a REST pull object; `statusCheckRollup` is read separately. */
const PULL_FIELDS = Object.freeze({
  number: (p) => p.number,
  url: (p) => p.html_url,
  title: (p) => p.title,
  state: (p) => (p.merged === true || p.merged_at ? 'MERGED' : upper(p.state)),
  mergedAt: (p) => p.merged_at ?? null,
  createdAt: (p) => p.created_at ?? null,
  id: (p) => p.node_id,
  headRefOid: (p) => p.head?.sha ?? null,
  headRefName: (p) => p.head?.ref ?? null,
  baseRefName: (p) => p.base?.ref ?? null,
  isDraft: (p) => p.draft === true,
  mergeStateStatus: (p) => upper(p.mergeable_state, 'UNKNOWN'),
  autoMergeRequest: (p) => mapAutoMerge(p.auto_merge),
  // REST has no review rollup, and nothing on the close path gates on it.
  reviewDecision: () => null,
});

/** Fields a list row lacks (the list endpoint omits `mergeable_state`). */
const DETAIL_ONLY_FIELDS = new Set(['mergeStateStatus']);

const ROLLUP_FIELD = 'statusCheckRollup';

/**
 * @param {{ api: Function, GhExecError: typeof Error }} deps
 */
export function createRestPr({ api, GhExecError }) {
  function refuse(message, args) {
    return new GhExecError(`gh-pr-rest: ${message}`, { args });
  }

  async function call(method, endpoint, body) {
    const result = await api({ method, endpoint, body });
    return parseApiJson(result);
  }

  function parseFlags(sub, flags) {
    const spec = FLAG_SPECS[sub];
    const out = {};
    const list = Array.isArray(flags) ? flags : [];
    for (let i = 0; i < list.length; i += 1) {
      const flag = list[i];
      const kind = Object.hasOwn(spec, flag) ? spec[flag] : null;
      if (!kind) {
        throw refuse(`\`gh pr ${sub}\` flag ${flag} has no REST mapping`, [
          'pr',
          sub,
          ...list,
        ]);
      }
      if (kind === 'bool') {
        out[flag] = true;
      } else {
        i += 1;
        out[flag] = list[i];
      }
    }
    return out;
  }

  function prNumberOf(id, sub) {
    const text = String(id ?? '');
    const match = /^(\d+)$/.exec(text) ?? /\/pull\/(\d+)/.exec(text);
    if (!match) {
      throw refuse(`\`gh pr ${sub}\` needs a PR number or URL, got "${text}"`, [
        'pr',
        sub,
        text,
      ]);
    }
    return Number(match[1]);
  }

  function assertFields(sub, fields) {
    if (!Array.isArray(fields) || fields.length === 0) {
      throw refuse(`\`gh pr ${sub}\` needs --json fields over REST`, [
        'pr',
        sub,
      ]);
    }
    for (const field of fields) {
      if (field !== ROLLUP_FIELD && !Object.hasOwn(PULL_FIELDS, field)) {
        throw refuse(
          `\`gh pr ${sub}\` --json field ${field} has no REST mapping`,
          ['pr', sub, '--json', fields.join(',')],
        );
      }
    }
  }

  const getPull = (n) => call('GET', `${REPO}/pulls/${n}`);

  async function readRollup(sha) {
    if (!sha) return [];
    const [runs, status] = await Promise.all([
      call('GET', `${REPO}/commits/${sha}/check-runs?per_page=100`),
      call('GET', `${REPO}/commits/${sha}/status`),
    ]);
    return [
      ...(runs?.check_runs ?? []).map(toCheckRunNode),
      ...(status?.statuses ?? []).map(toStatusContextNode),
    ];
  }

  async function project(pull, fields) {
    const row = {};
    for (const field of fields) {
      if (field === ROLLUP_FIELD) {
        row[field] = await readRollup(pull.head?.sha);
      } else {
        row[field] = PULL_FIELDS[field](pull);
      }
    }
    return row;
  }

  async function view(id, fields) {
    const n = prNumberOf(id, 'view');
    assertFields('view', fields);
    return project(await getPull(n), fields);
  }

  async function list(flags = [], fields) {
    const opts = parseFlags('list', flags);
    assertFields('list', fields);
    const rows = await call('GET', listEndpoint(opts));
    const wanted = (Array.isArray(rows) ? rows : []).filter(
      (p) => opts['--state'] !== 'merged' || p.merged_at,
    );
    const needsDetail = fields.some((f) => DETAIL_ONLY_FIELDS.has(f));
    const out = [];
    for (const row of wanted) {
      out.push(
        await project(needsDetail ? await getPull(row.number) : row, fields),
      );
    }
    return out;
  }

  async function create(flags = []) {
    const opts = parseFlags('create', flags);
    const pull = await call('POST', `${REPO}/pulls`, {
      title: opts['--title'],
      head: opts['--head'],
      base: opts['--base'],
      body: opts['--body'] ?? '',
      ...(opts['--draft'] ? { draft: true } : {}),
    });
    return envelope(`${pull?.html_url ?? ''}\n`);
  }

  async function edit(id, flags = []) {
    const n = prNumberOf(id, 'edit');
    const opts = parseFlags('edit', flags);
    const patch = {};
    if (opts['--title'] !== undefined) patch.title = opts['--title'];
    if (opts['--body'] !== undefined) patch.body = opts['--body'];
    const pull = await call('PATCH', `${REPO}/pulls/${n}`, patch);
    return envelope(`${pull?.html_url ?? ''}\n`);
  }

  /**
   * `--auto` arms through the CCR route; its refusal resolves (not throws)
   * with `mergeOnGreen`, since the wait then owns the merge.
   */
  async function armAuto(n) {
    try {
      await call('PUT', `${REPO}/pulls/${n}/ccr/auto_merge`, {
        merge_method: 'squash',
      });
      return envelope('');
    } catch (err) {
      return { ...envelope(''), mergeOnGreen: true, detail: describe(err) };
    }
  }

  /** Squash-merge pinned to the head SHA, then reap the head ref (best-effort). */
  async function squashMerge(n, opts) {
    const pull = await getPull(n);
    const sha = opts['--match-head-commit'] ?? pull.head?.sha;
    const merged = await call('PUT', `${REPO}/pulls/${n}/merge`, {
      merge_method: 'squash',
      ...(sha ? { sha } : {}),
    });
    if (opts['--delete-branch'] && sameRepo(pull)) {
      await call(
        'DELETE',
        `${REPO}/git/refs/heads/${encodeRef(pull.head.ref)}`,
      ).catch(() => null);
    }
    return {
      ...envelope(''),
      merged: merged?.merged === true,
      sha: merged?.sha ?? null,
    };
  }

  async function merge(id, flags = []) {
    const n = prNumberOf(id, 'merge');
    const opts = parseFlags('merge', flags);
    if (opts['--disable-auto']) {
      await call('DELETE', `${REPO}/pulls/${n}/ccr/auto_merge`);
      return envelope('');
    }
    if (opts['--auto']) return armAuto(n);
    if (!opts['--squash']) {
      throw refuse('a REST merge supports --squash only', [
        'pr',
        'merge',
        ...flags,
      ]);
    }
    return squashMerge(n, opts);
  }

  async function updateBranch(id, flags = []) {
    const n = prNumberOf(id, 'update-branch');
    parseFlags('update-branch', flags);
    await call('PUT', `${REPO}/pulls/${n}/update-branch`, {});
    return envelope('');
  }

  return { view, list, create, edit, merge, updateBranch };
}

function envelope(stdout) {
  return { stdout, stderr: '', code: 0 };
}

function describe(err) {
  const stderr = String(err?.stderr ?? '').trim();
  const message = String(err?.message ?? err);
  return stderr ? `${message}: ${stderr.split('\n').at(-1)}` : message;
}

function sameRepo(pull) {
  const head = pull?.head?.repo?.full_name;
  const base = pull?.base?.repo?.full_name;
  return Boolean(pull?.head?.ref) && (!head || !base || head === base);
}

function encodeRef(ref) {
  return String(ref).split('/').map(encodeURIComponent).join('/');
}

function listEndpoint(opts) {
  const params = [];
  if (opts['--head'])
    params.push(`head={owner}:${encodeURIComponent(opts['--head'])}`);
  if (opts['--base']) params.push(`base=${encodeURIComponent(opts['--base'])}`);
  const state = opts['--state'] ?? 'open';
  params.push(`state=${state === 'merged' ? 'closed' : state}`);
  if (opts['--limit']) params.push(`per_page=${Number(opts['--limit']) || 30}`);
  return `${REPO}/pulls?${params.join('&')}`;
}

/** A REST check run as the `CheckRun` node `gh`'s rollup carries. */
function toCheckRunNode(run) {
  return {
    __typename: 'CheckRun',
    name: run?.name ?? '',
    status: upper(run?.status),
    conclusion: upper(run?.conclusion),
    startedAt: run?.started_at ?? '',
    completedAt: run?.completed_at ?? '',
    detailsUrl: run?.details_url ?? run?.html_url ?? '',
  };
}

/** A REST commit status as the `StatusContext` node `gh`'s rollup carries. */
function toStatusContextNode(status) {
  return {
    __typename: 'StatusContext',
    context: status?.context ?? '',
    state: upper(status?.state),
    targetUrl: status?.target_url ?? '',
    startedAt: status?.created_at ?? '',
  };
}

/**
 * `gh api` output (`{ stdout }`, a string, or an already-parsed value) as JSON.
 * An empty body (a 204) reads as `null`.
 *
 * @param {unknown} result
 * @returns {unknown}
 */
export function parseApiJson(result) {
  if (result && typeof result === 'object' && !('stdout' in result))
    return result;
  const text = typeof result === 'string' ? result : result?.stdout;
  const trimmed = String(text ?? '').trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

/**
 * The active rulesets on `base` (`GET …/rules/branches/{base}`).
 *
 * @param {{ api: Function, base: string, timeoutMs?: number }} args
 * @returns {Promise<Array<{ type?: string, parameters?: object }>>}
 */
export async function readBranchRules({ api, base, timeoutMs }) {
  const rules = parseApiJson(
    await api({
      method: 'GET',
      endpoint: `${REPO}/rules/branches/${encodeRef(base)}`,
      ...(timeoutMs ? { execOpts: { timeoutMs } } : {}),
    }),
  );
  return Array.isArray(rules) ? rules : [];
}
