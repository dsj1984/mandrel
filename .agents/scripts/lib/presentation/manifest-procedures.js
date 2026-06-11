/**
 * manifest-procedures.js
 *
 * Renders the bottom collapsed `<details>` block that carries the agent
 * operating procedures and the full symbol legend for a dispatch
 * manifest. Split out of `manifest-formatter.js` (Story #1849 Task #1871)
 * so the parent collapses to the dispatch-manifest wiring facade.
 *
 * Re-exported from `manifest-formatter.js` so existing call-sites and
 * tests that import from there keep working without a path change.
 */

/**
 * Render the bottom collapsed `<details>` block carrying the operating
 * procedures and the full symbol legend (Story #1194 Task #1214). This is
 * the only HTML the manifest emits by AC — every other section is plain
 * Markdown.
 *
 * @param {number|string} epicId  the Epic id used to substitute `/deliver` examples.
 * @returns {string}
 */
export function renderProceduresAndLegendDetails(epicId) {
  const lines = [];
  lines.push(
    '<details><summary>🤖 Agent Operating Procedures &amp; symbol reference</summary>',
  );
  lines.push('');
  lines.push('### Operating Procedures');
  lines.push('');
  lines.push(
    `1. **Deliver**: Run \`/deliver ${epicId}\`. The runner iterates waves in order, fans Stories out in parallel via \`/deliver\`, and only pauses when the Epic flips to \`agent::blocked\`.`,
  );
  lines.push(
    '2. **Resume (granular, optional)**: Re-running `/deliver` resumes from the checkpointed wave. To re-drive a single Story, run `/deliver <storyId>`. Re-runs are checkpoint-idempotent.',
  );
  lines.push(
    `3. **Close**: \`/deliver ${epicId}\` runs close-validation, code-review, retro, and PR-create in its tail. Operators merge the PR via the GitHub UI.`,
  );
  lines.push('');
  lines.push('### Symbol legend');
  lines.push('');
  lines.push('| Symbol | Meaning |');
  lines.push('| :--- | :--- |');
  lines.push('| ⬜ | Pending — no Tasks started |');
  lines.push('| 🔄 | In-flight — at least one Task done or executing |');
  lines.push('| ✅ | Done — every Task complete |');
  lines.push('| 🚧 | Blocked — at least one Task is `agent::blocked` |');
  lines.push('| 🚀 Ready | Wave is unblocked and ready to dispatch |');
  lines.push('| ⏳ Blocked | Wave is gated on a prior wave still completing |');
  lines.push('| `█` / `░` | Progress bar: filled / remaining cells |');
  lines.push('| `*(after #N)*` | Task callout: depends on in-Story Task #N |');
  lines.push('');
  lines.push('</details>');
  return lines.join('\n');
}
