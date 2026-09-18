/**
 * comment-policy.js — the scanner and rules behind `check-comment-policy.js`.
 *
 * The policy (docs/contributing/comment-policy.md): a comment states what the
 * code cannot — a contract, an invariant, a non-obvious reason — once, at the
 * narrowest scope that owns it, and never narrates history. Two ratchets hold
 * it: comment bytes may not exceed {@link COMMENT_RATIO_CEILING} of the
 * payload's script bytes, and no comment may cite a ticket, pull request or
 * decision-record number.
 *
 * The scanner is hand-rolled and dependency-free. It understands string,
 * template (including nested `${}` expressions) and regular-expression
 * literals, so a `//` inside a URL or a `/*` inside a regex is never mistaken
 * for a comment. Regex-versus-division is decided by the previous significant
 * token, the same heuristic every JavaScript highlighter uses.
 */

/**
 * The landed ceiling on comment bytes as a fraction of script bytes. It may
 * only be lowered.
 */
export const COMMENT_RATIO_CEILING = 0.3;

/** Directories whose comments the provenance lint reads. */
export const PROVENANCE_ROOTS = ['.agents/scripts', 'bin', 'lib'];

/** The directory whose comment ratio the ceiling bounds. */
export const RATIO_ROOT = '.agents/scripts';

/**
 * A comment citing a ticket, pull request or decision record: `Story #N`,
 * `PR #N`, `Epic #N`, `ADR <date-id>`, or a bare `#NN…` issue reference.
 */
const PROVENANCE_PATTERN =
  /\b(?:Story|Stories|PR|PRs|Epic|Epics|Issue|Issues)\s*#\d+|\bADR[ -]?\d{6,}|(?<![\w&/#])#\d{2,}\b/;

/** JSDoc tags that form the type surface and must survive a trim. */
const TYPE_TAGS = ['param', 'returns', 'typedef', 'throws'];

const KEYWORDS_BEFORE_EXPRESSION = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * True when a script file belongs to the scanned surface: JavaScript, not a
 * test, not generated.
 *
 * @param {string} file repo-relative path with forward slashes
 * @returns {boolean}
 */
export function isScannedSource(file) {
  return (
    /\.[cm]?js$/.test(file) &&
    !/(^|\/)__tests__\//.test(file) &&
    !/\.test\.[cm]?js$/.test(file) &&
    !/(^|\/)lib\/generated\//.test(file)
  );
}

/**
 * Whether a `/` at the current position opens a regex literal, judged from the
 * code emitted so far.
 *
 * @param {string} code code-only text preceding the slash
 * @returns {boolean}
 */
function slashOpensRegex(code) {
  const trimmed = code.trimEnd();
  if (trimmed === '') return true;
  const last = trimmed[trimmed.length - 1];
  if (/[\w$]/.test(last)) {
    const word = /[\w$]+$/.exec(trimmed)[0];
    return KEYWORDS_BEFORE_EXPRESSION.has(word);
  }
  return !/[)\].'"`]/.test(last);
}

/**
 * Index just past a quoted string opening at `start`.
 *
 * @param {string} s
 * @param {number} start
 * @returns {number}
 */
function endOfString(s, start) {
  const quote = s[start];
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === '\\') i += 2;
    else if (s[i] === quote || s[i] === '\n') return i + 1;
    else i += 1;
  }
  return s.length;
}

/**
 * Index just past a regex literal opening at `start`.
 *
 * @param {string} s
 * @param {number} start
 * @returns {number}
 */
function endOfRegex(s, start) {
  let i = start + 1;
  let inClass = false;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') i += 2;
    else if (ch === '\n') return i;
    else {
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        i += 1;
        while (i < s.length && /[a-z]/i.test(s[i])) i += 1;
        return i;
      }
      i += 1;
    }
  }
  return s.length;
}

/**
 * Index just past the comment opening at `i`, or -1 when none opens there.
 *
 * @param {string} s
 * @param {number} i
 * @returns {number}
 */
function endOfComment(s, i) {
  if (s[i] !== '/') return -1;
  if (s[i + 1] === '/') {
    const nl = s.indexOf('\n', i);
    return nl === -1 ? s.length : nl;
  }
  if (s[i + 1] === '*') {
    const close = s.indexOf('*/', i + 2);
    return close === -1 ? s.length : close + 2;
  }
  return -1;
}

/**
 * A single-pass scanner. `templateStack` holds the brace depth at which each
 * open template `${` expression began, so its closing `}` resumes the template.
 */
class CommentScanner {
  /** @param {string} s */
  constructor(s) {
    this.s = s;
    /** @type {Array<{ kind: 'code' | 'comment' | 'literal', text: string }>} */
    this.parts = [];
    this.code = '';
    this.tail = '';
    this.templateStack = [];
    this.braceDepth = 0;
  }

  /** @param {string} text */
  remember(text) {
    this.tail = (this.tail + text).slice(-64);
  }

  /** @param {string} ch */
  pushCode(ch) {
    this.code += ch;
    this.remember(ch);
  }

  /**
   * @param {'comment' | 'literal'} kind
   * @param {number} start
   * @param {number} end
   * @returns {number}
   */
  pushOther(kind, start, end) {
    if (this.code) this.parts.push({ kind: 'code', text: this.code });
    this.code = '';
    const text = this.s.slice(start, end);
    this.parts.push({ kind, text });
    if (kind === 'literal') this.remember(text);
    return end;
  }

  /**
   * Scan template text from `start` to the closing backtick or the next `${`.
   *
   * @param {number} start
   * @returns {number}
   */
  endOfTemplate(start) {
    const s = this.s;
    let j = start;
    while (j < s.length) {
      if (s[j] === '\\') j += 2;
      else if (s[j] === '`') return j + 1;
      else if (s[j] === '$' && s[j + 1] === '{') {
        this.templateStack.push(this.braceDepth);
        this.braceDepth += 1;
        return j + 2;
      } else j += 1;
    }
    return s.length;
  }

  /**
   * End of the literal opening at `i`, or -1 when none opens there.
   *
   * @param {number} i
   * @returns {number}
   */
  endOfLiteral(i) {
    const ch = this.s[i];
    if (ch === "'" || ch === '"') return endOfString(this.s, i);
    if (ch === '`') return this.endOfTemplate(i + 1);
    if (ch === '/' && slashOpensRegex(this.tail)) return endOfRegex(this.s, i);
    return -1;
  }

  /**
   * Consume a brace at `i`; a `}` closing a template expression resumes the
   * template as a literal.
   *
   * @param {number} i
   * @returns {number}
   */
  brace(i) {
    const ch = this.s[i];
    if (ch === '{') this.braceDepth += 1;
    else {
      this.braceDepth -= 1;
      const top = this.templateStack[this.templateStack.length - 1];
      if (this.templateStack.length > 0 && top === this.braceDepth) {
        this.templateStack.pop();
        return this.pushOther('literal', i, this.endOfTemplate(i + 1));
      }
    }
    this.pushCode(ch);
    return i + 1;
  }

  /**
   * Consume one token at `i`.
   *
   * @param {number} i
   * @returns {number}
   */
  step(i) {
    const commentEnd = endOfComment(this.s, i);
    if (commentEnd !== -1) return this.pushOther('comment', i, commentEnd);
    const literalEnd = this.endOfLiteral(i);
    if (literalEnd !== -1) return this.pushOther('literal', i, literalEnd);
    if (this.s[i] === '{' || this.s[i] === '}') return this.brace(i);
    this.pushCode(this.s[i]);
    return i + 1;
  }
}

/**
 * Split JavaScript source into code, comment and literal segments.
 *
 * @param {string} source
 * @returns {Array<{ kind: 'code' | 'comment' | 'literal', text: string }>}
 */
function tokenizeComments(source) {
  const scanner = new CommentScanner(String(source ?? ''));
  let i = 0;
  while (i < scanner.s.length) i = scanner.step(i);
  if (scanner.code) scanner.parts.push({ kind: 'code', text: scanner.code });
  return scanner.parts;
}

/**
 * The comments in `source`, in order.
 *
 * @param {string} source
 * @returns {string[]}
 */
function extractComments(source) {
  return tokenizeComments(source)
    .filter((p) => p.kind === 'comment')
    .map((p) => p.text);
}

/**
 * Comment-free, formatting-free code text: comments removed, whitespace
 * outside literals dropped except where it separates two word characters,
 * and trailing commas dropped — so deleting a comment, and the reflow a
 * formatter applies afterwards, leave the result unchanged. Directive
 * comments (`biome-ignore`, `eslint-`, `@ts-`, `node:coverage`, `c8`,
 * `istanbul`) are kept, because deleting one changes tool behaviour.
 *
 * @param {string} source
 * @returns {string}
 */
export function normalizedCode(source) {
  /** @type {Array<{ literal: boolean, text: string }>} */
  const pieces = [];
  const add = (literal, text) => {
    const last = pieces[pieces.length - 1];
    if (!literal && last && !last.literal) last.text += text;
    else pieces.push({ literal, text });
  };
  for (const part of tokenizeComments(source)) {
    if (part.kind === 'literal') add(true, part.text);
    else if (part.kind === 'code') add(false, part.text);
    else if (isDirectiveComment(part.text)) add(true, part.text.trim());
    else add(false, ' ');
  }
  return pieces
    .map((p) => (p.literal ? p.text : squeeze(p.text)))
    .join('\u0001');
}

/**
 * True for a comment a tool reads: a lint or coverage directive, a type
 * directive, or a license header.
 *
 * @param {string} comment
 * @returns {boolean}
 */
function isDirectiveComment(comment) {
  return /^\/[/*]\s*(?:biome-ignore|eslint-|@ts-|node:coverage|c8 |istanbul |cli-opt-out|test-temp-allow|@license|@preserve)/.test(
    comment,
  );
}

/**
 * Collapse whitespace in a code run: drop it except between two word
 * characters, and drop trailing commas, so a formatter's reflow after a
 * comment deletion leaves the result unchanged.
 *
 * @param {string} code
 * @returns {string}
 */
function squeeze(code) {
  return code
    .replace(/\s+/g, ' ')
    .replace(/([^\w$]) | (?=[^\w$])/g, '$1')
    .replace(/,([)\]}])/g, '$1')
    .trim();
}

/**
 * Comment and total byte counts for one source.
 *
 * @param {string} source
 * @returns {{ total: number, comment: number }}
 */
export function commentBytes(source) {
  const comments = extractComments(source);
  return {
    total: Buffer.byteLength(source),
    comment: comments.reduce((n, c) => n + Buffer.byteLength(c), 0),
  };
}

/**
 * Provenance citations in `source`'s comments.
 *
 * @param {string} source
 * @returns {Array<{ line: number, match: string }>}
 */
export function findProvenance(source) {
  const hits = [];
  let offset = 0;
  for (const part of tokenizeComments(source)) {
    if (part.kind === 'comment') {
      const lines = part.text.split('\n');
      lines.forEach((text, k) => {
        const m = PROVENANCE_PATTERN.exec(text);
        if (m) {
          const line = source.slice(0, offset).split('\n').length + k;
          hits.push({ line, match: m[0] });
        }
      });
    }
    offset += part.text.length;
  }
  return hits;
}

/**
 * The JSDoc type-surface tags in `source`, as a sorted multiset of
 * `@tag name` keys (the name only for `@param` and `@typedef`).
 *
 * @param {string} source
 * @returns {string[]}
 */
export function typeTags(source) {
  const keys = [];
  const tagRe = new RegExp(
    `@(${TYPE_TAGS.join('|')})\\b\\s*(?:\\{[^}]*\\}\\s*)?(\\[?[\\w$.]+)?`,
    'g',
  );
  for (const comment of extractComments(source)) {
    if (!comment.startsWith('/**')) continue;
    for (const m of comment.matchAll(tagRe)) {
      const named = m[1] === 'param' || m[1] === 'typedef';
      keys.push(named ? `@${m[1]} ${m[2] ?? ''}` : `@${m[1]}`);
    }
  }
  return keys.sort();
}
