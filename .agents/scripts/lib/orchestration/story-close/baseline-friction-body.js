/**
 * baseline-friction-body.js — render the friction-comment body for
 * non-attributable baseline drift surfaced by the close-validation chain.
 *
 * Story #1124 (Tech Spec #902, "s-baseline-refresh-discipline"). When
 * `classifyBaselineDrift` reports rows on paths the running Story never
 * touched, story-close upserts a `friction`-typed structured comment on
 * the Story so the operator can route the refresh back to the sibling
 * Story whose merge introduced the drift. The body shape is stable so
 * the `diagnose-friction` analyzer can pattern-match the section.
 *
 * Output contract (markdown):
 *
 *     ### Baseline drift not attributable to this Story
 *
 *     The close-validation chain flagged the following file(s) as breaching
 *     a committed baseline, but none of the paths intersect this Story's
 *     diff vs `epic/<epicId>`. Refreshing them here would silently absorb a
 *     sibling Story's debt onto this Story's PR, so the close is blocked
 *     until an operator routes the refresh to the suspect Story below.
 *
 *     | Path | Suspect Story | Suspect Commit |
 *     | --- | --- | --- |
 *     | lib/foo.js | #777 | `deadbee1` |
 *     | lib/orphan.js | _unknown_ | `beef0001` |
 *
 *     <triage instructions>
 *
 * The renderer is pure — no IO, no provider calls — so unit tests can pin
 * the exact body string against fixed inputs.
 */

/**
 * Format a single suspect cell: `#<num>` when present, italic `_unknown_`
 * otherwise. Italic so a Markdown-aware reader can scan the column for
 * holes without parsing the table semantics.
 */
function formatSuspectStory(num) {
  return typeof num === 'number' && Number.isFinite(num) && num > 0
    ? `#${num}`
    : '_unknown_';
}

/**
 * Format the suspect-commit cell as an inline-code SHA, or em-dash when
 * the lookup yielded nothing (the row was non-attributable but git log
 * returned no commit on `epicRef` for the path — typically a renamed
 * file or a stale baseline against an empty path).
 */
function formatSuspectSha(sha) {
  return typeof sha === 'string' && sha.length > 0 ? `\`${sha}\`` : '—';
}

/**
 * Render the friction-comment body. The caller passes the result to
 * `upsertStructuredComment(provider, ticketId, 'friction', body)` which
 * applies the canonical structured-comment marker.
 *
 * @param {object} input
 * @param {Array<{
 *   path: string,
 *   suspectStoryNumber: number|null,
 *   suspectSha: string|null,
 * }>} input.rows
 *   The `nonAttributable` slice from `classifyBaselineDrift`. Empty input
 *   yields a defensive "no rows" body so a misuse never produces a
 *   blank comment — that comment shape is asserted by the unit test.
 * @param {number|string} input.epicId
 * @param {number|string} input.storyId
 * @returns {string} markdown body (no trailing newline)
 */
export function renderBaselineFrictionBody({ rows, epicId, storyId } = {}) {
  const tableRows = Array.isArray(rows) ? rows : [];
  const heading = `### Baseline drift not attributable to Story #${storyId}`;
  const intro =
    `The close-validation chain flagged the file(s) below as breaching a ` +
    `committed baseline, but none of the paths intersect this Story's diff vs ` +
    `\`epic/${epicId}\`. Auto-refreshing them on Story #${storyId} would silently ` +
    `absorb a sibling Story's debt onto this Story's PR, so the close is ` +
    `blocked until an operator routes the refresh to the suspect Story below.`;

  if (tableRows.length === 0) {
    return [
      heading,
      '',
      intro,
      '',
      '_No non-attributable rows were supplied — this comment was emitted defensively._',
    ].join('\n');
  }

  const tableHeader = [
    '| Path | Suspect Story | Suspect Commit |',
    '| --- | --- | --- |',
  ];
  const tableBody = tableRows.map(
    (r) =>
      `| \`${r.path}\` | ${formatSuspectStory(r.suspectStoryNumber)} | ${formatSuspectSha(r.suspectSha)} |`,
  );
  const triage = [
    '**Triage:**',
    `1. Open each suspect Story above and run \`npm run maintainability:update\` (or \`npm run crap:update\`) on **its** branch, then commit with a \`baseline-refresh:\` subject and re-close it.`,
    `2. Re-run \`/deliver ${storyId}\` once the suspect Story's refresh has merged into \`epic/${epicId}\`.`,
    `3. If the suspect column reads \`_unknown_\`, the path has no commit on \`epic/${epicId}\` — investigate the baseline file directly before refreshing.`,
  ];

  return [
    heading,
    '',
    intro,
    '',
    ...tableHeader,
    ...tableBody,
    '',
    ...triage,
  ].join('\n');
}
