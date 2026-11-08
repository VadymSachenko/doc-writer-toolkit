// A command line as a shell reads it, for lib/role-hook.mjs: quotes and backslashes removed, chains and pipes split,
// redirects set apart. It runs nothing and expands nothing. A form whose words can't be known without running it (a
// substitution, a variable, a brace list, a subshell, a heredoc) is an `error`, never a guess, and the hook refuses it.
// It covers both shells a session's Bash tool may be: bash and zsh (`=cmd`, `$=x`, `>!`, glob qualifiers in parentheses).
// One pass over the text with no backtracking, so a long or hostile command can't stall it.

export const MAX_COMMAND = 100_000;

const SPACE = new Set([' ', '\t']);
const GLOB = new Set(['*', '?', '[']);
const fail = (error) => ({ error });

// `$` stands for itself only with nothing a shell would read after it.
const literalDollar = (next, inDouble) => next === undefined || next === ' ' || next === '\t' || next === '\n' || '/.,:%'.includes(next) || (inDouble && next === '"');

// A word: `value` as the program would get it; `glob` when an unquoted `*`, `?` or `[` makes the shell expand it, with
// `pattern` holding the value with its quoted glob characters escaped.
const newWord = () => ({ value: '', pattern: '', glob: false, quoted: false, openBrace: false });

export function parseShell(src) {
  if (typeof src !== 'string') return fail('the command is not text');
  if (src.length > MAX_COMMAND) return fail(`the command is over ${MAX_COMMAND} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(src)) return fail('the command holds control characters');
  const commands = [];
  let cmd = { words: [], redirects: [] };
  let word = null;
  let pending = null; // a redirect waiting for its target
  const n = src.length;
  let i = 0;

  const start = () => (word ??= newWord());
  const add = (c, { literal = true } = {}) => {
    start();
    word.value += c;
    word.pattern += literal && (GLOB.has(c) || c === '\\') ? `\\${c}` : c;
  };
  const endWord = () => {
    if (!word) return;
    const w = { value: word.value, pattern: word.pattern, glob: word.glob, quoted: word.quoted };
    word = null;
    if (pending) {
      pending.target = w;
      cmd.redirects.push(pending);
      pending = null;
    } else cmd.words.push(w);
  };
  const endCommand = () => {
    endWord();
    if (pending) return false;
    if (cmd.words.length || cmd.redirects.length) commands.push(cmd);
    cmd = { words: [], redirects: [] };
    return true;
  };
  const dollar = (next, inDouble) => {
    if (literalDollar(next, inDouble)) return null;
    return next === "'" || next === '"' ? 'a $-quoted word' : next === '(' ? 'a command substitution' : 'a variable';
  };

  while (i < n) {
    const c = src[i];
    if (SPACE.has(c)) {
      endWord();
      i += 1;
      continue;
    }
    if (c === '\n' || c === '\r' || c === ';') {
      if (src[i + 1] === ';') return fail('a case clause');
      if (!endCommand()) return fail('a redirect with no target');
      i += 1;
      continue;
    }
    if (c === '|') {
      if (!endCommand()) return fail('a redirect with no target');
      i += src[i + 1] === '|' || src[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === '&' && src[i + 1] !== '>') {
      if (!endCommand()) return fail('a redirect with no target');
      i += src[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === '(' || c === ')') return fail('a subshell, a process substitution or a glob qualifier');
    if (c === '`') return fail('a command substitution');
    if (c === '<' || c === '>' || c === '&') {
      if (pending) return fail('a redirect with no target');
      // A word of digits right before it is the file descriptor, not an argument.
      const fd = word && !word.quoted && /^\d+$/.test(word.value) ? word.value : null;
      if (fd !== null) word = null;
      else endWord();
      let op = c;
      let j = i + 1;
      if (c === '&') op += src[j++]; // &>
      if (src[j] === '(') return fail('a process substitution');
      if (op === '<' && src[j] === '<') return fail('a heredoc or a here-string');
      if (op === '<' && (src[j] === '>' || src[j] === '&')) op += src[j++];
      else if (op.endsWith('>')) {
        if (src[j] === '>') op += src[j++];
        if (src[j] === '&' && op === '>') op += src[j++];
        else if (src[j] === '|' || src[j] === '!') op += src[j++];
      }
      if (src[j] === '(') return fail('a process substitution');
      pending = { op, fd, target: null };
      i = j;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return fail('an unterminated quote');
      start();
      word.quoted = true;
      for (let k = i + 1; k < end; k++) add(src[k]);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      start();
      word.quoted = true;
      i += 1;
      let closed = false;
      while (i < n) {
        const d = src[i];
        if (d === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (d === '`') return fail('a command substitution');
        if (d === '$') {
          const why = dollar(src[i + 1], true);
          if (why) return fail(why);
        }
        if (d === '\\') {
          const e = src[i + 1];
          if (e === undefined) return fail('a backslash at the end');
          if (e === '\n') {
            i += 2;
            continue;
          }
          if ('$`"\\'.includes(e)) {
            add(e);
            i += 2;
            continue;
          }
        }
        add(d);
        i += 1;
      }
      if (!closed) return fail('an unterminated quote');
      continue;
    }
    if (c === '\\') {
      const e = src[i + 1];
      if (e === undefined) return fail('a backslash at the end');
      if (e !== '\n') {
        start();
        word.quoted = true;
        add(e);
      }
      i += 2;
      continue;
    }
    if (c === '$') {
      const why = dollar(src[i + 1], false);
      if (why) return fail(why);
    }
    // An unquoted character of a word.
    if (c === '=' && !word && src[i + 1] !== undefined && !SPACE.has(src[i + 1]) && src[i + 1] !== '\n') return fail('a word starting with =, which zsh expands');
    start();
    if (c === '{') word.openBrace = true;
    else if (c === '}') word.openBrace = false;
    else if (word.openBrace && (c === ',' || (c === '.' && src[i + 1] === '.'))) return fail('a brace expansion');
    if (GLOB.has(c)) word.glob = true;
    add(c, { literal: false });
    i += 1;
  }
  if (!endCommand()) return fail('a redirect with no target');
  return { commands };
}

// Whether a glob pattern (one path segment, `\x` for a literal x) matches a name, a leading dot included: a host's shell
// may have `dotglob` set, so the check takes the wider reading. `*` and `?` by themselves; a `[...]` set as a set. One
// row per character of the name: no backtracking, whatever the pattern.
export function segmentMatches(pattern, name) {
  const items = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) items.push({ lit: pattern[++i] });
    else if (c === '*') items.push({ star: true });
    else if (c === '?') items.push({ any: true });
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end < 0) items.push({ lit: c });
      else {
        let body = pattern.slice(i + 1, end);
        const negated = body[0] === '!' || body[0] === '^';
        if (negated) body = body.slice(1);
        items.push({ set: body, negated });
        i = end;
      }
    } else items.push({ lit: c });
  }
  const one = (it, ch) => {
    if (it.any) return true;
    if (it.lit !== undefined) return it.lit.toLowerCase() === ch.toLowerCase();
    let hit = false;
    for (let k = 0; k < it.set.length; k++) {
      if (it.set[k + 1] === '-' && k + 2 < it.set.length) {
        if (ch >= it.set[k] && ch <= it.set[k + 2]) hit = true;
        k += 2;
      } else if (it.set[k].toLowerCase() === ch.toLowerCase()) hit = true;
    }
    return hit !== it.negated;
  };
  const size = items.length;
  let row = new Array(size + 1).fill(false);
  row[0] = true;
  for (let k = 0; k < size && items[k].star; k++) row[k + 1] = true;
  for (const ch of name) {
    const next = new Array(size + 1).fill(false);
    for (let k = 0; k < size; k++) {
      if (items[k].star) next[k + 1] = next[k] || row[k + 1];
      else if (row[k] && one(items[k], ch)) next[k + 1] = true;
    }
    row = next;
  }
  return row[size];
}
