// A small, line-based Markdown/MDX block parser. It does not render anything: it finds the units that
// `context/changed-blocks.md` talks about (sections, paragraphs, list items, table rows, code, admonitions,
// MDX component bodies) and the inline facts the checks compare (bold spans, links, images, tags, markers).

const isBlank = (l) => l.trim() === '';
const indentOf = (l) => l.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
const trimEnd = (l) => l.replace(/\s+$/, '');
const spaces = (l) => ' '.repeat(l.length);

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const LIST_MARKER = /^( {0,3})([-*+]|\d{1,9}[.)])(?: +|$)/;
const TABLE_ROW = /^\|/;
const TABLE_SEP = /^\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const ADMON_OPEN = /^:{3,}\s*[A-Za-z]/;
const ADMON_CLOSE = /^:{3,}\s*$/;
const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'link', 'meta', 'source', 'col', 'wbr']);
const HTML_TAGS = new Set(['img', 'br', 'hr', 'a', 'b', 'i', 'em', 'strong', 'kbd', 'sub', 'sup', 'span', 'div', 'details', 'summary', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'ul', 'ol', 'li', 'p', 'video', 'source', 'iframe', 'center', 'figure', 'figcaption', 'u', 's', 'mark', 'code', 'pre', 'blockquote']);
// Attribute values that are prose and get translated. Every other attribute value must stay byte-identical.
export const PROSE_ATTRS = new Set(['title', 'alt', 'label', 'description', 'caption', 'placeholder', 'aria-label', 'summary']);
// Frontmatter keys whose values are prose. Every other key's value must stay identical (except `last_update`).
export const PROSE_FM_KEYS = new Set(['title', 'description', 'sidebar_label', 'pagination_label', 'tags', 'keywords']);

// ---------------------------------------------------------------- fences, inline code

// Returns the new fence state after `line`: null (outside) or { ch, len } (inside).
export function fenceStep(state, line) {
  const m = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (!state) {
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) return { ch: m[1][0], len: m[1].length };
    return null;
  }
  if (m && m[1][0] === state.ch && m[1].length >= state.len && m[2].trim() === '') return null;
  return state;
}

const INLINE_CODE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

// Splits a page into "prose" (fenced code and inline code replaced by spaces, same line count and lengths),
// the fenced blocks, and the inline code spans.
export function splitCode(text) {
  const lines = text.split('\n');
  const prose = [];
  const fences = [];
  const inline = [];
  let state = null;
  let cur = null;
  lines.forEach((line, idx) => {
    const next = fenceStep(state, line);
    if (!state && next) {
      cur = { info: line.replace(/^\s*(`{3,}|~{3,})/, '').trim(), startLine: idx, lines: [] };
      state = next;
      prose.push(spaces(line));
    } else if (state && !next) {
      cur.endLine = idx;
      fences.push(cur);
      cur = null;
      state = null;
      prose.push(spaces(line));
    } else if (state) {
      cur.lines.push(line);
      prose.push(spaces(line));
    } else {
      for (const m of line.matchAll(INLINE_CODE)) inline.push(m[2]);
      prose.push(line.replace(INLINE_CODE, (m) => spaces(m)));
    }
  });
  if (cur) {
    cur.endLine = lines.length - 1;
    fences.push(cur);
  }
  return { lines, prose, fences, inline };
}

// ---------------------------------------------------------------- JSX-ish tags

function skipBraces(text, i) {
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const e = text.indexOf(c, i + 1);
      if (e < 0) return -1;
      i = e;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

// Parses the tag that starts at text[pos] === '<'. Returns null when it is not a tag (autolinks, `a < b`).
export function scanTag(text, pos) {
  let i = pos + 1;
  let closing = false;
  if (text[i] === '/') {
    closing = true;
    i++;
  }
  const nm = /^[A-Za-z][\w.-]*/.exec(text.slice(i, i + 80));
  if (!nm) return null;
  const name = nm[0];
  i += name.length;
  if (i < text.length && !/[\s/>]/.test(text[i])) return null;
  if (closing) {
    const m = /^\s*>/.exec(text.slice(i, i + 40));
    return m ? { name, closing: true, selfClosing: false, attrs: [], end: i + m[0].length, raw: text.slice(pos, i + m[0].length) } : null;
  }
  const attrs = [];
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) return null;
    if (text[i] === '/' && text[i + 1] === '>') return { name, closing: false, selfClosing: true, attrs, end: i + 2, raw: text.slice(pos, i + 2) };
    if (text[i] === '>') return { name, closing: false, selfClosing: false, attrs, end: i + 1, raw: text.slice(pos, i + 1) };
    if (text[i] === '{') {
      const e = skipBraces(text, i);
      if (e < 0) return null;
      attrs.push({ name: null, value: text.slice(i, e) });
      i = e;
      continue;
    }
    const an = /^[^\s=/>{"']+/.exec(text.slice(i, i + 160));
    if (!an) return null;
    i += an[0].length;
    let j = i;
    while (j < text.length && /\s/.test(text[j])) j++;
    let value = null;
    if (text[j] === '=') {
      j++;
      while (j < text.length && /\s/.test(text[j])) j++;
      const q = text[j];
      if (q === '"' || q === "'") {
        const e = text.indexOf(q, j + 1);
        if (e < 0) return null;
        value = text.slice(j, e + 1);
        i = e + 1;
      } else if (q === '{') {
        const e = skipBraces(text, j);
        if (e < 0) return null;
        value = text.slice(j, e);
        i = e;
      } else {
        const bm = /^[^\s>]+/.exec(text.slice(j));
        value = bm ? bm[0] : '';
        i = j + value.length;
      }
    }
    attrs.push({ name: an[0], value });
  }
}

// One canonical string per tag: names, attribute names and non-prose attribute values, prose values elided.
function canonTag(tag) {
  if (tag.closing) return `</${tag.name}>`;
  const attrs = tag.attrs
    .map((a) => (a.name === null ? a.value : a.value == null ? a.name : PROSE_ATTRS.has(a.name) ? `${a.name}=…` : `${a.name}=${a.value}`))
    .sort();
  return `<${tag.name}${attrs.length ? ' ' : ''}${attrs.join(' ')}${tag.selfClosing ? ' /' : ''}>`;
}

// All MDX/HTML tags in the prose view (code already masked), as canonical strings in document order.
export function canonicalTags(proseText) {
  const out = [];
  for (let i = proseText.indexOf('<'); i >= 0; i = proseText.indexOf('<', i + 1)) {
    const tag = scanTag(proseText, i);
    if (!tag) continue;
    if (!(/^[A-Z]/.test(tag.name) || HTML_TAGS.has(tag.name))) continue;
    out.push(canonTag(tag));
    i = tag.end - 1;
  }
  return out;
}

// ---------------------------------------------------------------- inline facts

const BOLD = /\*\*(?=\S)(.+?)(?<=\S)\*\*/g;
export function boldSpans(proseLines) {
  const seen = new Set();
  for (const line of proseLines) for (const m of line.matchAll(BOLD)) seen.add(m[1]);
  return [...seen];
}

const LINK_DEST = /\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const BARE_URL = /\bhttps?:\/\/[^\s)<>"'\]]+/g;

export function linkTargets(proseLines) {
  const out = [];
  for (const line of proseLines) {
    for (const m of line.matchAll(/(?<!!)\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) out.push(m[1]);
    for (const m of line.matchAll(BARE_URL)) out.push(m[0]);
    const def = line.match(/^\s*\[[^\]]+\]:\s*(\S+)/);
    if (def) out.push(def[1]);
  }
  return out;
}

const isRelativeRef = (r) => !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(r);

// Relative image / asset references as written: markdown images, plus quoted `.assets/…` paths (<img src={require('./.assets/x.png')}>).
export function assetRefs(proseLines) {
  const out = [];
  for (const line of proseLines) {
    for (const m of line.matchAll(/!\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) if (isRelativeRef(m[1])) out.push(m[1]);
    for (const m of line.matchAll(/["']((?:\.{1,2}\/)*(?:[^"'\s)]*\/)?\.assets\/[^"'\s)]+)["']/g)) out.push(m[1]);
  }
  return [...new Set(out)];
}

export const cleanRef = (ref) => {
  let r = ref.replace(/[?#].*$/, '');
  try {
    r = decodeURI(r);
  } catch {
    /* keep as written */
  }
  return r;
};

export const markerCount = (proseText) => (proseText.match(/\{\/\*\s*(?:todo|needs confirmation)/gi) ?? []).length;

// `{/* … */}` comments that are neither heading anchors nor ToDo / NEEDS CONFIRMATION markers.
export function otherCommentCount(proseText) {
  let n = 0;
  for (const m of proseText.matchAll(/\{\/\*([\s\S]*?)\*\/\}/g)) {
    const body = m[1].trim();
    if (/^#\S+$/.test(body) || /^(todo|needs confirmation)/i.test(body)) continue;
    n++;
  }
  return n;
}

export const wordCount = (proseText) => proseText.split(/\s+/).filter(Boolean).length;

// ---------------------------------------------------------------- frontmatter

const unquote = (v) => v.replace(/^(["'])(.*)\1$/, '$2');

export function parseFrontmatter(lines) {
  if (!lines.length || trimEnd(lines[0]) !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (trimEnd(lines[i]) === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const entries = [];
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*)\s*:(.*)$/);
    if (m) entries.push({ key: m[1], start: i, end: i, first: m[2].trim() });
    else if (entries.length && !isBlank(lines[i])) entries.at(-1).end = i;
  }
  for (const e of entries) {
    e.raw = lines.slice(e.start, e.end + 1).join('\n');
    e.value = [e.first, ...lines.slice(e.start + 1, e.end + 1).map((l) => l.trim())].filter(Boolean).join('\n');
    e.scalar = unquote(e.first);
  }
  return { start: 0, end, entries };
}

// ---------------------------------------------------------------- block tree

function splitAnchor(text) {
  const m = text.match(/^(.*?)\s*\{\/\*\s*#([^\s*]+)\s*\*\/\}\s*$/);
  return m ? { title: m[1], anchor: m[2] } : { title: text, anchor: null };
}

const startsBlock = (l) =>
  HEADING.test(l) || /^ {0,3}(`{3,}|~{3,})/.test(l) || ADMON_OPEN.test(l) || ADMON_CLOSE.test(l) || LIST_MARKER.test(l) || TABLE_ROW.test(l) || /^\{\/\*/.test(l);

function lineOf(offs, pos) {
  let lo = 0;
  let hi = offs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offs[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function readFence(lines, i) {
  let state = fenceStep(null, lines[i]);
  let j = i + 1;
  for (; j < lines.length; j++) {
    state = fenceStep(state, lines[j]);
    if (!state) break;
  }
  return { type: 'code', start: i, end: Math.min(j, lines.length - 1) };
}

function readAdmonition(lines, i) {
  let depth = 1;
  let fence = null;
  for (let j = i + 1; j < lines.length; j++) {
    const next = fenceStep(fence, lines[j]);
    const inside = fence || next;
    fence = next;
    if (inside) continue;
    if (ADMON_OPEN.test(lines[j])) depth++;
    else if (ADMON_CLOSE.test(lines[j]) && --depth === 0) return { type: 'admonition', start: i, end: j };
  }
  return null;
}

function readComponent(ctx, i) {
  const { lines, text, masked, offs } = ctx;
  const tag = scanTag(text, offs[i]);
  if (!tag || tag.closing || tag.selfClosing || VOID_TAGS.has(tag.name)) return null;
  const open = new RegExp(`<(/?)${tag.name.replace(/[.]/g, '\\.')}(?=[\\s/>])`, 'g');
  open.lastIndex = tag.end;
  let depth = 1;
  for (let m = open.exec(masked); m; m = open.exec(masked)) {
    const t = scanTag(masked, m.index);
    if (!t) continue;
    if (m[1] === '/') {
      if (--depth === 0) {
        const end = lineOf(offs, m.index);
        return end > i ? { type: 'component', name: tag.name, start: i, end } : null;
      }
    } else if (!t.selfClosing) depth++;
  }
  return null;
}

function readTable(lines, i) {
  let j = i;
  while (j + 1 < lines.length && TABLE_ROW.test(lines[j + 1])) j++;
  const headerEnd = j > i && TABLE_SEP.test(lines[i + 1]) ? i + 1 : i;
  const rows = [];
  for (let r = headerEnd + 1; r <= j; r++) rows.push({ type: 'row', start: r, end: r });
  return { type: 'table', start: i, end: j, headerEnd, children: rows };
}

function readComment(lines, i) {
  let j = i;
  while (j < lines.length && !lines[j].includes('*/}')) j++;
  if (j >= lines.length) return null;
  if (j === i && !/\*\/\}\s*$/.test(lines[i])) return null; // text follows the comment: part of a paragraph
  return { type: 'comment', start: i, end: j };
}

function readItem(lines, i) {
  let fence = fenceStep(null, lines[i]);
  let last = i;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (fence) {
      fence = fenceStep(fence, l);
      last = j;
      continue;
    }
    if (isBlank(l)) {
      let k = j + 1;
      while (k < lines.length && isBlank(lines[k])) k++;
      if (k >= lines.length || indentOf(lines[k]) < 2) break;
      j = k - 1;
      continue;
    }
    if (indentOf(l) >= 2) {
      last = j;
      fence = fenceStep(null, l);
      continue;
    }
    if (!isBlank(lines[j - 1]) && !startsBlock(l)) {
      last = j; // lazy continuation
      continue;
    }
    break;
  }
  return { type: 'item', start: i, end: last };
}

function readParagraph(lines, i) {
  let last = i;
  for (let j = i + 1; j < lines.length; j++) {
    if (isBlank(lines[j]) || startsBlock(lines[j])) break;
    last = j;
  }
  return { type: 'paragraph', start: i, end: last };
}

function readLeaf(ctx, i) {
  const { lines } = ctx;
  const l = lines[i];
  if (/^ {0,3}(`{3,}|~{3,})/.test(l) && fenceStep(null, l)) return readFence(lines, i);
  if (ADMON_OPEN.test(l)) return readAdmonition(lines, i) ?? readParagraph(lines, i);
  if (/^<[A-Za-z]/.test(l)) {
    const c = readComponent(ctx, i);
    if (c) return c;
  }
  if (TABLE_ROW.test(l)) return readTable(lines, i);
  if (/^(import|export)\s/.test(l)) return { type: 'import', start: i, end: i };
  if (/^\{\/\*/.test(l)) {
    const c = readComment(lines, i);
    if (c) return c;
  }
  if (LIST_MARKER.test(l)) return readItem(lines, i);
  return readParagraph(lines, i);
}

function finalize(node, lines) {
  if (node.type === 'section') {
    for (const c of node.children) finalize(c, lines);
    node.end = node.children.length ? node.children.at(-1).end : node.start;
    node.headEnd ??= node.start;
  }
  node.sig = node.type === 'section' ? (node.level ? trimEnd(lines[node.start]) : '') : lines.slice(node.start, node.end + 1).map(trimEnd).join('\n');
  if (node.type === 'table') {
    node.headerSig = lines.slice(node.start, node.headerEnd + 1).map(trimEnd).join('\n');
    for (const r of node.children) {
      r.parent = node;
      r.sig = trimEnd(lines[r.start]);
    }
  }
}

export function parsePage(text) {
  const lines = text.split('\n');
  const fm = parseFrontmatter(lines);
  const from = fm ? fm.end + 1 : 0;
  const body = lines.join('\n');
  const offs = [];
  let acc = 0;
  for (const l of lines) {
    offs.push(acc);
    acc += l.length + 1;
  }
  const masked = splitCode(body).prose.join('\n');
  const ctx = { lines, text: body, masked, offs };

  const root = { type: 'section', level: 0, title: null, anchor: null, start: from, children: [], parent: null };
  const stack = [root];
  let i = from;
  while (i < lines.length) {
    const l = lines[i];
    if (isBlank(l)) {
      i++;
      continue;
    }
    const h = l.match(HEADING);
    if (h) {
      const level = h[1].length;
      while (stack.length > 1 && stack.at(-1).level >= level) stack.pop();
      const { title, anchor } = splitAnchor(h[2]);
      const sec = { type: 'section', level, title, anchor, start: i, headEnd: i, children: [], parent: stack.at(-1) };
      stack.at(-1).children.push(sec);
      stack.push(sec);
      i++;
      continue;
    }
    const node = readLeaf(ctx, i);
    node.parent = stack.at(-1);
    stack.at(-1).children.push(node);
    i = node.end + 1;
  }
  finalize(root, lines);
  if (!root.children.length) root.end = from - 1;
  return { lines, fm, root };
}

export const isLeaf = (n) => n.type !== 'section';

// Titles from the top section down to the node's own section (a section includes itself).
export function sectionPath(node) {
  const titles = [];
  for (let n = node.type === 'section' ? node : node.parent; n; n = n.parent) {
    while (n && n.type !== 'section') n = n.parent;
    if (!n) break;
    if (n.level) titles.unshift(n.title);
  }
  return titles;
}

export function anchorPath(node) {
  const anchors = [];
  for (let n = node.type === 'section' ? node : node.parent; n; n = n.parent) {
    while (n && n.type !== 'section') n = n.parent;
    if (!n) break;
    if (n.level) anchors.unshift(n.anchor);
  }
  return anchors;
}

export const nodeText = (page, startLine, endLine) => page.lines.slice(startLine, endLine + 1).join('\n');

// All sections below `root` in document order.
export function* sections(root) {
  for (const c of root.children) {
    if (c.type === 'section') {
      yield c;
      yield* sections(c);
    }
  }
}
