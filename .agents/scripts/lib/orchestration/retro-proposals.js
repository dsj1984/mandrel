/**
 * lib/orchestration/retro-proposals.js — pure composer that turns
 * aggregated source-tagged friction signals into four routed proposal
 * sections (framework, consumer, memory, discarded).
 *
 * Epic #2547 / Story #2558 / Tech Spec #2550. Consumes per-Story signals
 * already source-tagged by `signals-writer.appendSignal` (Story #2553) and
 * yields a four-way split that the retro composer renders above the
 * `<!-- retro-complete: ... -->` marker.
 *
 * Heuristic:
 *   - **Actionable** (renders as a pre-drafted `gh issue create` shell
 *     command): a friction `category` with **≥ 2** occurrences across the
 *     Epic, OR an `agent::blocked` event whose root cause was not
 *     resolved by Epic close (the caller supplies these as
 *     `unresolvedBlockedEvents`).
 *   - **Memorable** (renders as a plain bulleted instruction line under
 *     "update your memory with the following insights"): a pattern
 *     observed in retro signals supplied via `memorablePatterns`. We do
 *     **not** emit memory frontmatter — the section is a free-text
 *     instruction block.
 *   - **Discarded**: a friction category with exactly 1 occurrence and
 *     no follow-on signal (no companion `agent::blocked`, not in
 *     `memorablePatterns`).
 *
 * Routing:
 *   - Each actionable item is routed to `framework` or `consumer` based
 *     on the dominant `source` tag for that category. "Dominant" means
 *     the source with the higher count; ties resolve to whichever source
 *     contributed the first occurrence so the ordering is deterministic.
 *
 * Determinism:
 *   - Output arrays are sorted by `category` ASC so a given input always
 *     yields byte-identical markdown (Story #2558 AC).
 *
 * The module is pure: no I/O, no provider calls, no time-dependent state.
 *
 * @typedef {Object} FrictionSignal
 * @property {string} category   Free-form bucket (e.g. `"lint-loop"`).
 * @property {"framework"|"consumer"} source
 *
 * @typedef {Object} BlockedEvent
 * @property {number} ticketId
 * @property {"framework"|"consumer"} source
 * @property {string} [category]
 * @property {string} [summary]
 *
 * @typedef {Object} MemorablePattern
 * @property {string} category
 * @property {string} insight   The instruction line text (rendered as a bullet).
 *
 * @typedef {Object} RoutedProposalsInput
 * @property {number}                epicId
 * @property {string}                frameworkRepo   `"<owner>/<repo>"`.
 * @property {string}                consumerRepo    `"<owner>/<repo>"`.
 * @property {FrictionSignal[]}      [signals]
 * @property {BlockedEvent[]}        [unresolvedBlockedEvents]
 * @property {MemorablePattern[]}    [memorablePatterns]
 *
 * @typedef {Object} RoutedItem
 * @property {string} category
 * @property {number} occurrences
 * @property {"framework"|"consumer"} source
 * @property {string} title
 * @property {string} body
 * @property {string} command       The pre-drafted `gh issue create` line.
 *
 * @typedef {Object} MemoryItem
 * @property {string} category
 * @property {string} insight
 *
 * @typedef {Object} DiscardedItem
 * @property {string} category
 * @property {number} occurrences
 * @property {"framework"|"consumer"} source
 *
 * @typedef {Object} RoutedProposals
 * @property {RoutedItem[]}     framework
 * @property {RoutedItem[]}     consumer
 * @property {MemoryItem[]}     memory
 * @property {DiscardedItem[]}  discarded
 */

/**
 * Empty result helper — returned for zero-input callers so the consumer
 * never needs to defensively spread undefineds.
 *
 * @returns {RoutedProposals}
 */
function emptyResult() {
  return { framework: [], consumer: [], memory: [], discarded: [] };
}

/**
 * Normalise a stringy input to a trimmed string, or empty.
 *
 * @param {unknown} value
 * @returns {string}
 */
function asString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

/**
 * Aggregate friction signals by `category`, tracking per-source counts and
 * arrival order so we can pick a dominant source deterministically.
 *
 * Records with a missing/invalid `category` are skipped (no silent
 * "" bucket). Records with an unknown `source` default to `"consumer"`
 * — that matches the source-classifier's safe default.
 *
 * @param {FrictionSignal[]} signals
 * @returns {Map<string, {
 *   category: string,
 *   total: number,
 *   bySource: { framework: number, consumer: number },
 *   firstSource: "framework"|"consumer",
 * }>}
 */
function aggregateByCategory(signals) {
  const out = new Map();
  for (const sig of signals) {
    if (sig === null || typeof sig !== 'object') continue;
    const category = asString(sig.category);
    if (category.length === 0) continue;
    const source = sig.source === 'framework' ? 'framework' : 'consumer';
    let entry = out.get(category);
    if (!entry) {
      entry = {
        category,
        total: 0,
        bySource: { framework: 0, consumer: 0 },
        firstSource: source,
      };
      out.set(category, entry);
    }
    entry.total += 1;
    entry.bySource[source] += 1;
  }
  return out;
}

/**
 * Resolve the dominant source for an aggregated category. Ties resolve to
 * `firstSource` so byte-identical inputs always produce byte-identical
 * routing.
 *
 * @param {{ bySource: { framework: number, consumer: number }, firstSource: "framework"|"consumer" }} entry
 * @returns {"framework"|"consumer"}
 */
function dominantSource(entry) {
  const { framework, consumer } = entry.bySource;
  if (framework > consumer) return 'framework';
  if (consumer > framework) return 'consumer';
  return entry.firstSource;
}

/**
 * Render the issue body. Plain text — no markdown headings — so the
 * pre-drafted `gh issue create --body-file` heredoc remains a faithful
 * representation of what the operator would paste.
 *
 * @param {{ epicId: number, category: string, occurrences: number, source: "framework"|"consumer" }} args
 * @returns {string}
 */
function renderIssueBody({ epicId, category, occurrences, source }) {
  return [
    `Recurring friction category "${category}" surfaced ${occurrences} times during Epic #${epicId}.`,
    '',
    `Source classification: ${source}.`,
    '',
    'Captured by the routed-retro composer (Story #2558). Triage and either:',
    `- File a follow-on Story to address the underlying ${source} gap, or`,
    '- Close with "wont-fix" and document the rationale in the Epic retro thread.',
  ].join('\n');
}

/**
 * Compose the pre-drafted `gh issue create` shell command for an actionable
 * item. The command is rendered verbatim — operators copy-paste it as-is.
 *
 * The body is supplied via `--body-file -` and a trailing heredoc so the
 * multi-line content survives shell quoting on every platform.
 *
 * @param {{
 *   repo: string,
 *   title: string,
 *   metaLabel: "framework-gap"|"consumer-improvement",
 *   category: string,
 *   body: string,
 * }} args
 * @returns {string}
 */
function renderIssueCommand({ repo, title, metaLabel, category, body }) {
  const labels = `meta::${metaLabel},friction::${category}`;
  // Heredoc form keeps multi-line bodies safe under POSIX shells; agents
  // running on PowerShell convert it to a `--body` flag if needed.
  return [
    `gh issue create --repo ${repo} --title "${title}" --label "${labels}" --body-file - <<EOF`,
    body,
    'EOF',
  ].join('\n');
}

/**
 * Build an actionable RoutedItem for a category.
 *
 * @param {{
 *   epicId: number,
 *   category: string,
 *   occurrences: number,
 *   source: "framework"|"consumer",
 *   frameworkRepo: string,
 *   consumerRepo: string,
 * }} args
 * @returns {RoutedItem}
 */
function buildRoutedItem({
  epicId,
  category,
  occurrences,
  source,
  frameworkRepo,
  consumerRepo,
}) {
  const title = `Friction: ${category} recurred ${occurrences} times in Epic #${epicId}`;
  const body = renderIssueBody({ epicId, category, occurrences, source });
  const repo = source === 'framework' ? frameworkRepo : consumerRepo;
  const metaLabel =
    source === 'framework' ? 'framework-gap' : 'consumer-improvement';
  const command = renderIssueCommand({
    repo,
    title,
    metaLabel,
    category,
    body,
  });
  return { category, occurrences, source, title, body, command };
}

/**
 * Validate that the input shape is sane and extract typed arrays. Returns
 * `null` when input is unusable (caller short-circuits to `emptyResult`).
 *
 * @param {unknown} input
 * @returns {{
 *   epicId: number,
 *   frameworkRepo: string,
 *   consumerRepo: string,
 *   signals: FrictionSignal[],
 *   unresolvedBlockedEvents: BlockedEvent[],
 *   memorablePatterns: MemorablePattern[],
 * } | null}
 */
function normaliseInput(input) {
  if (input === null || typeof input !== 'object') return null;
  const record = /** @type {RoutedProposalsInput} */ (input);
  const epicId = Number(record.epicId);
  if (!Number.isInteger(epicId) || epicId <= 0) return null;
  const frameworkRepo = asString(record.frameworkRepo);
  const consumerRepo = asString(record.consumerRepo);
  if (frameworkRepo.length === 0 || consumerRepo.length === 0) return null;
  return {
    epicId,
    frameworkRepo,
    consumerRepo,
    signals: Array.isArray(record.signals) ? record.signals : [],
    unresolvedBlockedEvents: Array.isArray(record.unresolvedBlockedEvents)
      ? record.unresolvedBlockedEvents
      : [],
    memorablePatterns: Array.isArray(record.memorablePatterns)
      ? record.memorablePatterns
      : [],
  };
}

/**
 * Compose the four routed proposal sections from aggregated source-tagged
 * signals.
 *
 * Pure — no I/O, no time-dependent state, no provider calls. Returns an
 * object with four arrays:
 *   - `framework`: actionable items routed to the framework repo.
 *   - `consumer`: actionable items routed to the consumer repo.
 *   - `memory`: bulleted instruction lines for the operator's memory
 *     surface (NOT memory frontmatter).
 *   - `discarded`: single-occurrence friction with no follow-on signal.
 *
 * @param {RoutedProposalsInput} input
 * @returns {RoutedProposals}
 */
export function composeRoutedProposals(input) {
  const normalised = normaliseInput(input);
  if (normalised === null) return emptyResult();
  const {
    epicId,
    frameworkRepo,
    consumerRepo,
    signals,
    unresolvedBlockedEvents,
    memorablePatterns,
  } = normalised;

  const byCategory = aggregateByCategory(signals);

  // Memory: every supplied pattern with a non-empty insight, sorted by
  // category. Memorable categories are *also* tracked so a 1-occurrence
  // friction that's memorable is NOT discarded — it's already covered by
  // the memory section.
  const memorableCategories = new Set();
  /** @type {MemoryItem[]} */
  const memory = [];
  for (const m of memorablePatterns) {
    if (m === null || typeof m !== 'object') continue;
    const category = asString(m.category);
    const insight = asString(m.insight);
    if (category.length === 0 || insight.length === 0) continue;
    memorableCategories.add(category);
    memory.push({ category, insight });
  }
  memory.sort((a, b) => a.category.localeCompare(b.category));

  // Unresolved agent::blocked events always promote their category to
  // actionable — even if the friction count is < 2. The event itself
  // doesn't count as a friction occurrence; we treat it as a force-flag.
  /** @type {Map<string, { source: "framework"|"consumer" }>} */
  const blockedForceActionable = new Map();
  for (const evt of unresolvedBlockedEvents) {
    if (evt === null || typeof evt !== 'object') continue;
    const category = asString(evt.category);
    if (category.length === 0) continue;
    const source = evt.source === 'framework' ? 'framework' : 'consumer';
    if (!blockedForceActionable.has(category)) {
      blockedForceActionable.set(category, { source });
    }
  }

  /** @type {RoutedItem[]} */
  const framework = [];
  /** @type {RoutedItem[]} */
  const consumer = [];
  /** @type {DiscardedItem[]} */
  const discarded = [];

  // Walk categories present in friction signals first.
  for (const entry of byCategory.values()) {
    const { category, total } = entry;
    const force = blockedForceActionable.get(category);
    const source = force ? force.source : dominantSource(entry);
    const actionable = total >= 2 || Boolean(force);
    if (actionable) {
      const item = buildRoutedItem({
        epicId,
        category,
        occurrences: total,
        source,
        frameworkRepo,
        consumerRepo,
      });
      if (source === 'framework') framework.push(item);
      else consumer.push(item);
      continue;
    }
    // total === 1 AND no force flag.
    if (memorableCategories.has(category)) {
      // Memorable single-occurrence frictions are covered by the memory
      // section; do not also discard them.
      continue;
    }
    discarded.push({ category, occurrences: total, source });
  }

  // Walk blocked-force categories that had NO friction signal at all —
  // these still need an issue proposal (the blocker is the trigger).
  for (const [category, info] of blockedForceActionable) {
    if (byCategory.has(category)) continue;
    const item = buildRoutedItem({
      epicId,
      category,
      occurrences: 0,
      source: info.source,
      frameworkRepo,
      consumerRepo,
    });
    if (info.source === 'framework') framework.push(item);
    else consumer.push(item);
  }

  framework.sort((a, b) => a.category.localeCompare(b.category));
  consumer.sort((a, b) => a.category.localeCompare(b.category));
  discarded.sort((a, b) => a.category.localeCompare(b.category));

  return { framework, consumer, memory, discarded };
}
