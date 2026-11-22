// mend: one patch tool for every AI edit format.
//
// Applies an edit that a model wrote to a tree of text files. The edit can be
// a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, a V4A
// patch, or JSON text-editor tool calls. Lines are found at the first of three
// matching tiers (exact, trailing whitespace ignored, both ends ignored), and
// either every file changes or none does. SPEC.md is the whole contract.
//
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

interface Move {
  from: string;
  to: string;
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const stripTrailingWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** One file's text as lines: its line break, its lines, whether it ends with a break. */
interface Doc {
  br: string;
  lines: string[];
  final: boolean;
}
function parseDoc(text: string): Doc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}
function renderDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => Move | null;

/** Line equality at one matching tier. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailingWs(a) === stripTrailingWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

/** Every position at or after `from` where O matches `lines` at `tier`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length - from) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs (at or after `from`; only occurrences ending at the file's last line when `eofOnly`). */
function findTier(
  lines: string[],
  o: string[],
  from: number,
  strict: boolean,
  eofOnly: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let occ = occurrences(lines, o, t, from);
    if (eofOnly) occ = occ.filter((i) => i + o.length === lines.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** A line of N: `oIndex` is its index in O when it is a context line, null when it is added. */
interface NewLine {
  text: string;
  oIndex: number | null;
}

/** Build N's lines for a match at `pos`: context lines come from the file; other lines are re-indented at tier 2. */
function buildReplacement(n: NewLine[], o: string[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  const f = pos < fileLines.length ? leadingWs(fileLines[pos]!) : '';
  for (const nl of n) {
    if (nl.oIndex !== null) {
      out.push(fileLines[pos + nl.oIndex]!);
      continue;
    }
    if (tier === 2) {
      const t = nl.text;
      if (t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
      return null;
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      return null;
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const doc = parseDoc(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      doc.lines.splice(line, 0, ...add);
      tree.now.set(p, renderDoc(doc));
      return null;
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
  startLine: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:[ \t].*)?$/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

const isBodyLine = (line: string): boolean =>
  line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\');

function parseBodyLine(line: string): BodyLine {
  if (line === '') return { kind: ' ', text: '' };
  const c = line[0]!;
  if (c === ' ') return { kind: ' ', text: line.slice(1) };
  if (c === '-') return { kind: '-', text: line.slice(1) };
  if (c === '+') return { kind: '+', text: line.slice(1) };
  return { kind: '\\', text: line.slice(1) };
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, trimmed; /dev/null is no file; a leading a/ or b/ is removed. */
function parseDiffPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** A hunk's O and N, and whether a `\` line follows its last context-or-`+` line / its last `+` line. */
function hunkLines(h: Hunk): {
  o: string[];
  n: NewLine[];
  backslashAfterLastCP: boolean;
  backslashAfterLastPlus: boolean;
} {
  const o: string[] = [];
  const n: NewLine[] = [];
  let lastCP = -1;
  let lastPlus = -1;
  h.body.forEach((b, i) => {
    if (b.kind === ' ' || b.kind === '+') lastCP = i;
    if (b.kind === '+') lastPlus = i;
  });
  for (const b of h.body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, oIndex: o.length - 1 });
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      n.push({ text: b.text, oIndex: null });
    }
  }
  return {
    o,
    n,
    backslashAfterLastCP: lastCP >= 0 && lastCP + 1 < h.body.length && h.body[lastCP + 1]!.kind === '\\',
    backslashAfterLastPlus: lastPlus >= 0 && lastPlus + 1 < h.body.length && h.body[lastPlus + 1]!.kind === '\\',
  };
}

/** Apply one hunk to `doc`; returns the new cumulative length delta d for the section. */
function applyHunk(doc: Doc, h: Hunk, d: number, strict: boolean, path: string): number {
  const { o, n, backslashAfterLastCP } = hunkLines(h);
  if (o.length === 0) {
    const idx = Math.min(h.a + d, doc.lines.length);
    const atEnd = idx === doc.lines.length;
    const built = n.map((x) => x.text);
    doc.lines.splice(idx, 0, ...built);
    if (atEnd) doc.final = !backslashAfterLastCP;
    return d + n.length;
  }
  const found = findTier(doc.lines, o, 0, strict, false);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let pos = found.occ[0]!;
  let best = Math.abs(pos - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      pos = p;
      best = dist;
    }
  }
  const atEnd = pos + o.length === doc.lines.length;
  const built = buildReplacement(n, o, doc.lines, pos, found.tier);
  doc.lines.splice(pos, o.length, ...built);
  if (atEnd) doc.final = !backslashAfterLastCP;
  return d + (n.length - o.length);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let curHunk: Hunk | null = null;
  let inHeader = false;

  const endBody = (): void => {
    if (curHunk !== null) {
      while (curHunk.body.length > 0) {
        const last = curHunk.body[curHunk.body.length - 1]!;
        if (last.kind === ' ' && last.text.trim() === '') curHunk.body.pop();
        else break;
      }
      curHunk = null;
    }
  };
  const startDiffSection = (i: number): void => {
    const m = DIFF_RE.exec(lines[i]!);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    cur = {
      pairOld: undefined,
      pairNew: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      diffOld: m[1]!,
      diffNew: m[2]!,
      newFile: false,
      delFile: false,
      hunks: [],
      startLine: i + 1,
    };
    sections.push(cur);
    curHunk = null;
    inHeader = true;
  };
  const startPairSection = (i: number): void => {
    cur = {
      pairOld: undefined,
      pairNew: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      diffOld: undefined,
      diffNew: undefined,
      newFile: false,
      delFile: false,
      hunks: [],
      startLine: i + 1,
    };
    sections.push(cur);
    curHunk = null;
    inHeader = true;
  };
  const handlePair = (i: number): void => {
    cur!.pairOld = parseDiffPath(lines[i]!);
    cur!.pairNew = parseDiffPath(lines[i + 1]!);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = i + 1 < lines.length ? lines[i + 1]! : undefined;
    if (curHunk !== null) {
      if (line.startsWith('diff --git ')) {
        endBody();
        startDiffSection(i);
        continue;
      }
      if (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
        endBody();
        startPairSection(i);
        handlePair(i);
        i++;
        continue;
      }
      if (isBodyLine(line)) {
        curHunk.body.push(parseBodyLine(line));
        continue;
      }
      endBody();
    }
    if (line.startsWith('diff --git ')) {
      startDiffSection(i);
      continue;
    }
    if (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
      if (cur === null || !inHeader) startPairSection(i);
      handlePair(i);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(curHunk);
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.pairNew = parseDiffPath(line);
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice(12).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice(10).trim();
        continue;
      }
      if (/^new file mode( |$)/.test(line)) {
        cur.newFile = true;
        continue;
      }
      if (/^deleted file mode( |$)/.test(line)) {
        cur.delFile = true;
        continue;
      }
      continue;
    }
  }
  endBody();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
  const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
  if (oldP === undefined || newP === undefined) throw new Exit2(`error: parse ${sec.startLine}`);
  const isCreate = oldP === null || sec.newFile;
  const isDelete = !isCreate && (newP === null || sec.delFile);
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  return (tree) => {
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plusLines: string[] = [];
      let finalBreak = true;
      let hasPlus = false;
      for (const h of sec.hunks) {
        const hl = hunkLines(h);
        const thisPlus = hl.n.filter((x) => x.oIndex === null).map((x) => x.text);
        if (thisPlus.length > 0) {
          hasPlus = true;
          finalBreak = !hl.backslashAfterLastPlus;
          plusLines.push(...thisPlus);
        }
      }
      tree.now.set(newP, hasPlus ? plusLines.join('\n') + (finalBreak ? '\n' : '') : '');
      return null;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('unsafe', '');
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return null;
    }
    const op = oldP!;
    if (!safe(op)) throw new Fail('unsafe', op);
    if (isMove) {
      const np = newP!;
      if (!safe(np)) throw new Fail('unsafe', np);
    }
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const doc = parseDoc(cur);
    let d = 0;
    for (const h of sec.hunks) {
      d = applyHunk(doc, h, d, strict, op);
    }
    const content = renderDoc(doc);
    if (isMove) {
      tree.now.set(op, null);
      tree.now.set(newP!, content);
      return { from: op, to: newP! };
    }
    tree.now.set(op, content);
    return null;
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevEnd = -1;
  for (;;) {
    let s = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s === -1) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (blocks.length === 0) throw new Exit2(`error: parse ${s + 1}`);
      path = blocks[blocks.length - 1]!.path;
    }
    let sep = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep === -1) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, sep), newLines: lines.slice(sep + 1, rep) });
    prevEnd = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return null;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const doc = parseDoc(cur);
    const found = findTier(doc.lines, b.oldLines, 0, strict, false);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    const built = buildReplacement(
      b.newLines.map((t) => ({ text: t, oIndex: null })),
      b.oldLines,
      doc.lines,
      pos,
      found.tier,
    );
    doc.lines.splice(pos, b.oldLines.length, ...built);
    tree.now.set(b.path, renderDoc(doc));
    return null;
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: { kind: ' ' | '-' | '+'; text: string }[];
}
interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4AChunk[];
  line: number;
}

function chunkLines(ch: V4AChunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of ch.body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, oIndex: o.length - 1 });
    } else if (b.kind === '-') {
      o.push(b.text);
    } else {
      n.push({ text: b.text, oIndex: null });
    }
  }
  return { o, n };
}

/** The first line at or after `cursor` equal to the anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let j = cursor; j < lines.length; j++) {
      if (lineEq(lines[j]!, anchor, t)) return j;
    }
  }
  return null;
}

function buildV4aSection(
  kind: 'add' | 'delete' | 'update',
  path: string,
  rawLines: { text: string; num: number }[],
  sectionLine: number,
): V4ASection {
  if (kind === 'add') {
    const addLines: string[] = [];
    for (const r of rawLines) {
      if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
      else if (r.text === '') addLines.push('');
      else throw new Exit2(`error: parse ${r.num}`);
    }
    return { kind, path, moveTo: null, addLines, chunks: [], line: sectionLine };
  }
  if (kind === 'delete') {
    if (rawLines.length > 0) throw new Exit2(`error: parse ${rawLines[0]!.num}`);
    return { kind, path, moveTo: null, addLines: [], chunks: [], line: sectionLine };
  }
  let moveTo: string | null = null;
  let rest = rawLines;
  if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
    moveTo = rest[0]!.text.slice(13).trim();
    rest = rest.slice(1);
  }
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  const pushCur = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (const r of rest) {
    const l = r.text;
    if (l.startsWith('@@')) {
      pushCur();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      continue;
    }
    if (l.trimEnd() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.num}`);
      cur.eof = true;
      pushCur();
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${r.num}`);
        cur = { anchor: null, eof: false, body: [] };
      }
      const k = l === '' ? ' ' : (l[0] as ' ' | '-' | '+');
      cur.body.push({ kind: k, text: l === '' ? '' : l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${r.num}`);
  }
  pushCur();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
  return { kind, path, moveTo, addLines: [], chunks, line: sectionLine };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sectionLine = i + 1;
    i++;
    const rawLines: { text: string; num: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      rawLines.push({ text: l, num: i + 1 });
      i++;
    }
    while (rawLines.length > 0 && blank(rawLines[rawLines.length - 1]!.text)) rawLines.pop();
    sections.push(buildV4aSection(kind, path, rawLines, sectionLine));
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: V4ASection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
      return null;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return null;
    }
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const doc = parseDoc(cur);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(doc.lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      const { o, n } = chunkLines(ch);
      if (o.length === 0) {
        const idx = ch.eof ? doc.lines.length : cursor;
        const built = n.map((x) => x.text);
        doc.lines.splice(idx, 0, ...built);
        cursor = idx + built.length;
      } else {
        const found = findTier(doc.lines, o, cursor, strict, ch.eof);
        if (found === null) throw new Fail('no-match', s.path);
        const pos = found.occ[0]!;
        const built = buildReplacement(n, o, doc.lines, pos, found.tier);
        doc.lines.splice(pos, o.length, ...built);
        cursor = pos + built.length;
      }
    }
    const content = renderDoc(doc);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, content);
      return { from: s.path, to: s.moveTo };
    }
    tree.now.set(s.path, content);
    return null;
  };
}

/* ------------------------------------------------------------------ */
/* Command line (SPEC.md sections 1, 2 and 10)                         */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Move[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      const m = edit(tree);
      if (m !== null) moves.push(m);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const byPath = new Map<string, Row>();
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const row: Row = { key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` };
    rows.push(row);
    byPath.set(p, row);
  }
  for (const m of moves) {
    if (tree.original(m.from) === null || tree.original(m.to) !== null) continue;
    if (tree.get(m.from) !== null || tree.get(m.to) === null) continue;
    const dRow = byPath.get(m.from);
    const aRow = byPath.get(m.to);
    if (dRow === undefined || aRow === undefined) continue;
    if (!dRow.text.startsWith('D ') || !aRow.text.startsWith('A ')) continue;
    rows.splice(rows.indexOf(dRow), 1);
    rows.splice(rows.indexOf(aRow), 1);
    byPath.delete(m.from);
    byPath.delete(m.to);
    rows.push({ key: m.to, text: `R ${m.from} -> ${m.to}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
