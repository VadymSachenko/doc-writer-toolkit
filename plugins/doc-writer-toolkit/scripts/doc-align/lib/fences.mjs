// The two parts of a fenced code block in a translation (context/doc-rules/project-rules/code-blocks.md): the reader
// text, which is translated (diagram labels, comments, the descriptions of a folder tree), and the code part, which
// stays byte for byte (everything else: code, data, ids, keywords, arrows, whitespace, the number of lines). One
// implementation for doc-align (Check 6, Check 9) and locale-sync (`check`, the verbatim decision, `terms --usage`).
// No imports, so either script can load it.

export const CYRILLIC = /\p{Script=Cyrillic}/u;

// Stands in the code part for a piece of reader text that has letters or digits, so a label or a comment emptied in
// the translation is a difference.
const TEXT = '…';
const LETTERS = /[\p{L}\p{N}]/u;
const hole = (text) => (LETTERS.test(text) || text.includes(TEXT) ? TEXT : '');
// Records a piece of reader text on line `line` and returns its stand-in. Text that is only stand-ins already made
// (the outer shape of a nested one) is not recorded again.
const recorder = (texts, line) => (s) => {
  if (LETTERS.test(s.split(TEXT).join(''))) texts.push({ line, text: s.trim() });
  return hole(s);
};

// ---------------------------------------------------------------- languages

// Comment syntax per fence language. `line`: openers of a comment that runs to the end of the line. `hash`: `#` opens
// one at the start of a word (line start or after whitespace), as in shells and YAML. `block`: [open, close] pairs that
// may span lines. `quotes`: the string delimiters inside which nothing is a comment. `multiline`: delimiters whose
// strings may span lines. `noEscapeIn`: delimiters whose strings take no backslash escapes (shell single quotes).
const C_LIKE = { line: ['//'], block: [['/*', '*/']], quotes: `"'` };
const HASH = { hash: true, quotes: `"'` };
const SHELL = { hash: true, quotes: `"'`, noEscapeIn: `'` };
const MARKUP = { block: [['<!--', '-->']], quotes: '' };
const SQL = { line: ['--'], block: [['/*', '*/']], quotes: `"'` };
const LANGS = new Map(
  Object.entries({
    'js javascript mjs cjs jsx ts typescript tsx': { ...C_LIKE, quotes: "\"'`", multiline: '`' },
    'go golang': { ...C_LIKE, quotes: "\"'`", multiline: '`', noEscapeIn: '`' },
    'java kotlin kt swift scala rust rs c h cpp c++ cs csharp dart groovy gradle objectivec objc proto protobuf': C_LIKE,
    'jsonc json5': C_LIKE,
    php: { ...C_LIKE, hash: true },
    css: { block: [['/*', '*/']], quotes: `"'` },
    'scss sass less': C_LIKE,
    'bash sh shell zsh console shellsession': SHELL,
    'powershell ps1 pwsh': { ...HASH, block: [['<#', '#>']] },
    'python py ruby rb perl pl r yaml yml toml dockerfile docker makefile make properties env dotenv nginx conf graphql gql': HASH,
    'ini cfg': { ...HASH, line: [';'] },
    'sql plsql psql pgsql postgresql postgres mysql tsql': SQL,
    'lua haskell hs': { line: ['--'], quotes: `"'` },
    'html xml svg xhtml vue md markdown mdx': MARKUP,
  }).flatMap(([names, syntax]) => names.split(' ').map((n) => [n, syntax])),
);
// Plain-text fences, where the reader text is the description after ` — ` on a line (a folder tree).
const PLAIN = new Set(['', 'text', 'txt', 'plaintext', 'plain']);

// The fence language: the first word of the info string, lower case (```json title="…"``` → `json`).
export const fenceLang = (info = '') => (info.trim().match(/^[^\s{]*/)?.[0] ?? '').toLowerCase();

// ---------------------------------------------------------------- comments

// Splits the lines of a fence in a language with comments. Strings are skipped first, so `"https://…"` and a value in
// quotes are never a comment.
function splitComments(syntax, lines) {
  const code = [];
  const texts = [];
  let block = null; // the close string of an open block comment
  let quote = null; // the delimiter of an open string
  lines.forEach((line, n) => {
    const t = recorder(texts, n);
    let out = '';
    let text = '';
    const flush = () => {
      if (text) out += t(text);
      text = '';
    };
    let i = 0;
    while (i < line.length) {
      if (block) {
        if (line.startsWith(block, i)) {
          flush();
          out += block;
          i += block.length;
          block = null;
        } else text += line[i++];
        continue;
      }
      const ch = line[i];
      if (quote) {
        out += ch;
        i++;
        if (ch === '\\' && !syntax.noEscapeIn?.includes(quote) && i < line.length) out += line[i++];
        else if (ch === quote) quote = null;
        continue;
      }
      if (syntax.quotes.includes(ch)) {
        quote = ch;
        out += ch;
        i++;
        continue;
      }
      const open = syntax.block?.find(([o]) => line.startsWith(o, i));
      if (open) {
        out += open[0];
        i += open[0].length;
        block = open[1];
        continue;
      }
      const lineOpen = syntax.line?.find((o) => line.startsWith(o, i));
      // `#` starts a comment at the start of a word; a `#!` that opens the block is a shebang, which is code.
      const hash = syntax.hash && ch === '#' && (i === 0 || /\s/.test(line[i - 1])) && !(n === 0 && i === 0 && line[1] === '!');
      if (lineOpen || hash) {
        const opener = lineOpen ?? '#';
        out += opener;
        text = line.slice(i + opener.length);
        flush();
        break;
      }
      out += ch;
      i++;
    }
    flush();
    if (quote && !syntax.multiline?.includes(quote)) quote = null;
    code.push(out);
  });
  return { code, texts };
}

// ---------------------------------------------------------------- folder trees in plain text

function splitPlain(lines) {
  const code = [];
  const texts = [];
  lines.forEach((line, n) => {
    const m = line.match(/^(.*?\s—\s*)(\S.*)$/);
    code.push(m ? m[1] + recorder(texts, n)(m[2]) : line);
  });
  return { code, texts };
}

// ---------------------------------------------------------------- mermaid

// Lines a diagram keeps whole, in every diagram type: styling, classes, links, interaction and configuration.
const KEEP = /^\s*(classDef|class|style|linkStyle|click|link|links|properties|details|direction|autonumber|activate|deactivate|destroy|end|dateFormat|axisFormat|tickInterval|todayMarker|excludes|includes|weekday|displayMode|showData)\b/;

// A line split into code and text by a list of [pattern, replace] steps. Each replace gets the `t` recorder first, then
// the match and its groups.
function stepLine(line, steps, t) {
  for (const [re, fn] of steps) line = line.replace(re, (...m) => fn(t, ...m));
  return line;
}

// In every diagram type, a `"…"` is text the diagram shows.
const QUOTED = [/"([^"\n]*)"/g, (t, m, s) => `"${t(s)}"`];

// Flowchart labels: edge labels `|…|` and `-- … -->`, then node shapes, innermost first.
const FLOW = [
  QUOTED,
  [/\|([^|\n]*)\|/g, (t, m, s) => `|${t(s)}|`],
  [/(?<![-=.])(<?(?:--|==|-\.))(\s+)(\S[^\n]*?)(\s+)(-{2,}[->xo]?|={2,}[=>xo]?|\.-+>?)/g, (t, m, open, s1, s, s2, close) => `${open}${s1}${t(s)}${s2}${close}`],
  [/(?<=[\p{L}\p{N}_])>([^\]\n]*)\]/gu, (t, m, s) => `>${t(s)}]`],
  [/\[([^\]\n]*)\]/g, (t, m, s) => `[${t(s)}]`],
  [/\(([^()\n]*)\)/g, (t, m, s) => `(${t(s)})`],
  [/\(([^()\n]*)\)/g, (t, m, s) => `(${t(s)})`],
  [/\{([^{}\n]*)\}/g, (t, m, s) => `{${t(s)}}`],
  [/\{([^{}\n]*)\}/g, (t, m, s) => `{${t(s)}}`],
];
// A colon and what follows it is text: a message, a note, a transition or relation label.
const AFTER_COLON = [/^([^:]*:)(.*)$/, (t, m, head, s) => `${head}${t(s)}`];
// What comes before the first colon is text: a gantt task or a journey step.
const BEFORE_COLON = [/^(\s*)([^:]*?)(\s*:.*)$/, (t, m, ind, s, tail) => `${ind}${t(s)}${tail}`];
const KEYWORD_REST = (words) => [new RegExp(`^(\\s*(?:${words})\\b\\s*)(.*)$`), (t, m, kw, s) => `${kw}${t(s)}`];
const SEQUENCE_BLOCKS = 'loop|alt|else|opt|par|par_over|and|critical|option|break|box';

// The diagram's frontmatter (a `---` block that opens it; its `title:` is text) and the line that names its type,
// past `%%` comments and `%%{init}%%` directives.
function diagramHead(lines) {
  const skip = (i) => {
    while (i < lines.length && (!lines[i].trim() || /^\s*%%/.test(lines[i]))) i++;
    return i;
  };
  let i = skip(0);
  let fm = null;
  if (lines[i]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > i && l.trim() === '---');
    if (end > i) {
      fm = [i, end];
      i = skip(end + 1);
    }
  }
  return { fm, at: i, type: lines[i]?.trim().split(/\s+/)[0] ?? '' };
}

function splitMermaid(lines) {
  const texts = [];
  const code = [];
  const { fm, at, type } = diagramHead(lines);
  const flow = /^(flowchart|graph)$/.test(type);
  const keep = type === 'classDiagram' ? new RegExp(KEEP.source.replace('|class|', '|')) : KEEP;
  let note = false; // inside a multi-line state-diagram note
  lines.forEach((line, n) => {
    const t = recorder(texts, n);
    const one = (steps) => code.push(stepLine(line, steps, t));
    const rest = (re) => one([[re, (tt, m, kw, s) => `${kw}${tt(s)}`]]);
    if (fm && n >= fm[0] && n <= fm[1]) return n > fm[0] && n < fm[1] ? rest(/^(\s*title\s*:\s*)(.*)$/) : code.push(line);
    if (/^\s*%%\{/.test(line) || !line.trim()) return code.push(line);
    if (/^\s*%%/.test(line)) return rest(/^(\s*%%)(.*)$/);
    if (n === at) return rest(/^(\s*pie\s+title\s+)(.*)$/);
    if (n < at) return code.push(line);
    if (/^\s*(accTitle|accDescr)\s*:/.test(line)) return one([AFTER_COLON]);
    if (/^\s*title\s/.test(line)) return one([KEYWORD_REST('title')]);
    if (note) {
      if (/^\s*end\s+note\b/.test(line)) {
        note = false;
        return code.push(line);
      }
      return rest(/^(\s*)(.*)$/);
    }
    if (keep.test(line)) return code.push(line);

    if (flow) {
      const sub = line.match(/^\s*subgraph\s+(.*)$/);
      // `subgraph id [title]`, `subgraph id["title"]` or `subgraph id`: the id stays. `subgraph Some title`: the words are the title.
      if (sub && !/[[\]"]/.test(sub[1]) && !/^[A-Za-z_][\w-]*\s*$/.test(sub[1])) return rest(/^(\s*subgraph\s+)(.*?)\s*$/);
      return one(FLOW);
    }
    if (type === 'sequenceDiagram') {
      if (/^\s*(?:create\s+)?(participant|actor)\b/.test(line)) return one([QUOTED, [/^(\s*(?:create\s+)?(?:participant|actor)\s+\S+\s+as\s+)(.*)$/, (tt, m, kw, s) => `${kw}${tt(s)}`]]);
      if (/^\s*rect\b/.test(line)) return code.push(line);
      if (new RegExp(`^\\s*(${SEQUENCE_BLOCKS})\\b`).test(line)) return one([KEYWORD_REST(SEQUENCE_BLOCKS)]);
      return line.includes(':') ? one([AFTER_COLON]) : code.push(line);
    }
    if (/^stateDiagram/.test(type)) {
      if (/^\s*note\s+(left|right)\s+of\s+[^:]+$/.test(line)) {
        note = true;
        return code.push(line);
      }
      return one(!/^\s*state\s/.test(line) && line.includes(':') ? [QUOTED, AFTER_COLON] : [QUOTED]);
    }
    if (type === 'erDiagram') return one(line.includes(':') ? [QUOTED, AFTER_COLON] : [QUOTED]);
    if (type === 'classDiagram') return one(/--|\.\./.test(line) && line.includes(':') ? [QUOTED, AFTER_COLON] : [QUOTED]);
    if (type === 'gantt' || type === 'journey') {
      if (/^\s*section\s/.test(line)) return one([KEYWORD_REST('section')]);
      return line.includes(':') ? one([BEFORE_COLON]) : code.push(line);
    }
    if (type === 'pie') return one([QUOTED]);
    // Any other diagram type: each line keeps its indentation, and the rest of it is read as text.
    return rest(/^(\s*)(.*)$/);
  });
  return { code, texts };
}

// ---------------------------------------------------------------- the two parts

// `info`: the fence's info string. `lines`: its contents, without the fence lines. Returns `kind` (`diagram`,
// `comments`, `plain` or `code`), `code` (the code part, one string per line: each piece of reader text replaced by a
// stand-in, so the number of lines is kept) and `texts` (the reader text: `{ line, text }`, `line` 0-based in `lines`).
export function fenceParts(info, lines) {
  const lang = fenceLang(info);
  if (lang === 'mermaid') return { kind: 'diagram', lang, ...splitMermaid(lines) };
  const syntax = LANGS.get(lang);
  if (syntax) return { kind: 'comments', lang, ...splitComments(syntax, lines) };
  if (PLAIN.has(lang)) return { kind: 'plain', lang, ...splitPlain(lines) };
  return { kind: 'code', lang, code: [...lines], texts: [] };
}

// The first line (0-based) where the code parts of two versions of one fence ({ info, lines }) differ, or -1 when they
// match. A different number of lines differs at the first line one of them lacks.
export function codeDiff(a, b) {
  const [x, y] = [fenceParts(a.info, a.lines).code, fenceParts(b.info, b.lines).code];
  let k = 0;
  while (k < x.length && k < y.length && x[k] === y[k]) k++;
  return k === x.length && k === y.length ? -1 : k;
}

// The pieces of a fence's reader text that hold Cyrillic letters.
export const cyrillicText = (info, lines) => fenceParts(info, lines).texts.filter((t) => CYRILLIC.test(t.text));

// A whole fenced block as written (its opening line, its contents and its closing line, if any) → { info, lines }.
export function fenceBlock(blockLines) {
  const m = (blockLines[0] ?? '').match(/^\s*(`{3,}|~{3,})(.*)$/);
  const lines = blockLines.slice(1);
  const c = lines.at(-1)?.match(/^\s*(`{3,}|~{3,})\s*$/);
  if (m && c && c[1][0] === m[1][0] && c[1].length >= m[1].length) lines.pop();
  return { info: m ? m[2].trim() : '', lines };
}
