// .agents/scripts/lib/command-header.js
/**
 * Pure helper for projecting workflow `.md` files into slash commands:
 * injects the AUTO-GENERATED provenance header without disturbing YAML
 * frontmatter placement.
 *
 * Kept as its own module (rather than inline in `sync-claude-commands.js`,
 * which runs its sync at import time via top-level await) so it can be unit
 * tested directly.
 */

/**
 * Inject `header` into a workflow's `content`. When the source begins with a
 * YAML frontmatter block, the header is inserted **after** the closing `---`
 * so the frontmatter stays on line 1; sources without frontmatter keep the
 * header prepended verbatim.
 *
 * Claude Code only parses a command's frontmatter (its `description`) when the
 * `---` block is the very first thing in the file. Prepending the HTML comment
 * above it made `claude plugin validate` report "No frontmatter block found"
 * for every command and silently dropped all descriptions.
 *
 * @param {string} content - Raw workflow `.md` content.
 * @param {string} header - Provenance header to inject (typically ends `\n\n`).
 * @returns {string}
 */
export function applyHeader(content, header) {
  const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!frontmatter) return header + content;
  const block = frontmatter[0];
  const body = content.slice(block.length).replace(/^\r?\n/, '');
  return `${block}\n${header}${body}`;
}

/**
 * True when a workflow opts out of slash-command projection via a
 * `command: false` key in its YAML frontmatter (#4482). Used for dual-use
 * lens files (e.g. `audit-security.md`) that stay in
 * the payload as `/deliver` audit-suite prompts but must NOT surface as
 * standalone slash commands because the host ships a native equivalent.
 *
 * Both `sync-claude-commands.js` (projection + orphan-reap) and the
 * `commands-in-sync` doctor check (parity expectation) consult this flag so
 * an excluded workflow never reads as "not synced".
 *
 * @param {string} content - Raw workflow `.md` content.
 * @returns {boolean}
 */
export function isCommandExcluded(content) {
  const frontmatter = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!frontmatter) return false;
  return /^command:\s*false\s*$/m.test(frontmatter[1]);
}
