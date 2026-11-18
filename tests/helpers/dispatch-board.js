/**
 * An in-memory board for `runDispatch` tests: a fake provider over a ticket
 * map plus recording launch/stop/record seams, so no test touches GitHub,
 * the filesystem or a real process.
 */

const STATES = [
  'agent::review-spec',
  'agent::ready',
  'agent::executing',
  'agent::closing',
  'agent::blocked',
  'agent::done',
];

/**
 * @param {Array<{ id: number, labels: string[], body?: string,
 *   assignees?: string[], state?: string, children?: number[] }>} tickets
 * @param {{ launchError?: Error }} [opts]
 */
export function makeDispatchBoard(tickets, { launchError } = {}) {
  const store = new Map(
    tickets.map((t) => [
      t.id,
      {
        title: `Story ${t.id}`,
        body: '',
        assignees: [],
        state: 'open',
        ...t,
        labels: [...t.labels],
      },
    ]),
  );
  const writes = [];
  const launches = [];
  const kills = [];
  const records = new Map();

  const copy = (t) => ({
    ...t,
    labels: [...t.labels],
    assignees: [...t.assignees],
  });

  const provider = {
    async getTicket(id) {
      const t = store.get(id);
      if (!t) throw new Error(`no ticket #${id}`);
      return copy(t);
    },
    async getSubTickets(id) {
      return (store.get(id).children ?? []).map((c) => ({ id: c }));
    },
    async listTicketsByLabel({ state = 'open', labels } = {}) {
      return [...store.values()]
        .filter((t) => state === 'all' || t.state === state)
        .filter((t) => !labels || t.labels.includes(labels))
        .map(copy);
    },
    async ensureLabels(defs) {
      writes.push({ ensureLabels: defs.map((d) => d.name) });
      return { created: [], skipped: [] };
    },
    async updateTicket(id, mutation) {
      writes.push({ id, mutation });
      const t = store.get(id);
      if (mutation.labels) {
        const remove = new Set(mutation.labels.remove ?? []);
        t.labels = t.labels.filter((l) => !remove.has(l));
        for (const l of mutation.labels.add ?? []) {
          if (!t.labels.includes(l)) t.labels.push(l);
        }
      }
      if (mutation.assignees) t.assignees = [...mutation.assignees];
      if (mutation.addAssignees) t.assignees.push(...mutation.addAssignees);
    },
  };

  const deps = {
    config: { github: { operatorHandle: '@me' } },
    provider,
    cwd: 'project-root',
    write: () => {},
    launchImpl: async ({ storyId, environment }) => {
      launches.push({
        storyId,
        environment: environment.name,
        argv: environment.command,
      });
      if (launchError) throw launchError;
      return {
        storyId,
        environment: environment.name,
        pid: 900 + storyId,
        startedAt: 'now',
        logPath: `log-${storyId}`,
        argv: environment.command.map((p) =>
          p.replaceAll('{id}', String(storyId)),
        ),
      };
    },
    stopImpl: (pid) => kills.push(pid),
    writeRecordImpl: (record) => records.set(record.storyId, record),
    readRecordImpl: (id) => records.get(id) ?? null,
    removeRecordImpl: (id) => records.delete(id),
    transitionImpl: async (_p, id, state) => {
      writes.push({ id, transition: state });
      const t = store.get(id);
      t.labels = t.labels.filter((l) => !STATES.includes(l)).concat(state);
    },
    fetchBoardImpl: async () => ({
      openTickets: [...store.values()]
        .filter((t) => t.state === 'open')
        .map(copy),
      closedStories: [...store.values()]
        .filter((t) => t.state === 'closed')
        .map(copy),
      prs: [],
    }),
  };

  /** A runDispatch deps object that captures stdout. */
  function capture() {
    const out = [];
    return { out, deps: { ...deps, write: (s) => out.push(s) } };
  }

  return { store, writes, launches, kills, records, deps, capture };
}
