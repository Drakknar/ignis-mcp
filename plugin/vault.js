const fs = require("fs");
const path = require("path");
const vm = require("vm");

const MAX_READ_BYTES = 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
// A regex search may spend at most this long matching, summed over all files. A pattern that backtracks
// catastrophically (e.g. "(a+)+$") would otherwise block the whole Ignis server, not just this call.
const REGEX_BUDGET_MS = 3000;
// Every keyword is looked up in every line, so a huge query (thousands of words) would block the server for many
// seconds per note. Far more than "a few short keywords".
const MAX_QUERY_CHARS = 1000;

class ToolError extends Error {}

// MCP_DEFAULT_VAULT: used when a tool call names no vault and more than one is enabled.
function defaultVault(env = process.env) {
  return (env.MCP_DEFAULT_VAULT || "").trim() || null;
}

// Splits on commas outside {...}, so "Agents/{Inbox,Facts}, Notes" is two entries, not four.
function splitEntries(raw) {
  const out = [];
  let depth = 0;
  let cur = "";

  for (const ch of raw) {
    if (ch === "{") {
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
    } else if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }

    cur += ch;
  }

  out.push(cur);
  return out;
}

// "Agents/{Inbox,Facts}" -> ["Agents/Inbox", "Agents/Facts"]; several or nested groups expand too. An unbalanced
// brace stays literal, so it matches no real folder (fails closed).
function expandBraces(entry) {
  const open = entry.indexOf("{");

  if (open < 0) {
    return [entry];
  }

  let depth = 0;
  let close = -1;
  const commas = [];

  for (let i = open; i < entry.length && close < 0; i++) {
    if (entry[i] === "{") {
      depth++;
    } else if (entry[i] === "}") {
      depth--;

      if (depth === 0) {
        close = i;
      }
    } else if (entry[i] === "," && depth === 1) {
      commas.push(i);
    }
  }

  if (close < 0) {
    return [entry];
  }

  const bounds = [open, ...commas, close];
  const head = entry.slice(0, open);
  const tail = entry.slice(close + 1);
  const out = [];

  for (let i = 0; i < bounds.length - 1; i++) {
    out.push(...expandBraces(head + entry.slice(bounds[i] + 1, bounds[i + 1]) + tail));
  }

  return out;
}

// "Vault/./Inbox/" -> "Vault/Inbox", so harmless spellings in the setting still match. An entry with ".." is
// dropped (fails closed) rather than resolved, so "Agents/../Other" never grants another vault.
function normalizeEntry(entry) {
  const p = entry.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

  if (p === "*" || !p) {
    return p;
  }

  if (p.split("/").includes("..")) {
    return "";
  }

  return path.posix.normalize(p).replace(/\/+$/, "");
}

// MCP_WRITE_PATHS: comma-separated "Vault" or "Vault/folder" entries that agents may change; "*" = anywhere (null).
// "Vault/{A,B}" stands for "Vault/A, Vault/B".
// Unset = anywhere only while the endpoint is open; with MCP_TOKEN set it means nothing, so a lost setting fails closed.
function writePaths(env = process.env) {
  const raw = (env.MCP_WRITE_PATHS || "").trim();

  if (!raw) {
    return (env.MCP_TOKEN || "").trim() ? [] : null;
  }

  const entries = splitEntries(raw)
    .flatMap((e) => expandBraces(e.trim()))
    .map(normalizeEntry)
    .filter((e) => e && e !== ".");

  return entries.includes("*") ? null : [...new Set(entries)];
}

function isWritable(vaultId, rel, allowed = writePaths()) {
  if (!allowed) {
    return true;
  }

  return allowed.some((entry) => {
    const [v, ...rest] = entry.split("/");
    const folder = rest.join("/");
    return v === vaultId && (!folder || rel === folder || rel.startsWith(`${folder}/`));
  });
}

// Only vaults the user enabled for this plugin in Ignis -> Core plugins are reachable.
function resolveVault(ctx, vaultId) {
  const enabled = ctx.getEnabledVaults();

  if (!vaultId) {
    const fallback = defaultVault();

    if (enabled.length === 1) {
      vaultId = enabled[0];
    } else if (fallback && enabled.includes(fallback)) {
      vaultId = fallback;
    } else {
      throw new ToolError(
        `Specify a vault. Available: ${enabled.join(", ") || "(none enabled)"}`,
      );
    }
  }

  if (!enabled.includes(vaultId)) {
    throw new ToolError(
      `Vault "${vaultId}" is not enabled for MCP. Available: ${enabled.join(", ") || "(none)"}`,
    );
  }

  const root = ctx.config.getVaultPath(vaultId);

  if (!root) {
    throw new ToolError(`Vault "${vaultId}" not found on disk`);
  }

  return { id: vaultId, root: fs.realpathSync(root) };
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function isHiddenPath(rel) {
  return toPosix(rel)
    .split("/")
    .some((seg) => seg.startsWith("."));
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function lexists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// Lexical check first, then where the path really leads: the nearest existing ancestor (a symlink counts, even a
// broken one) is resolved and the rest appended. abs/realRel are that real location, so symlinks can't lead outside
// the vault, and writes are checked against the folder they would really land in.
function resolveInVault(vault, relPath = "") {
  const cleaned = String(relPath).replace(/\\/g, "/").replace(/^\/+/, "");
  const target = path.resolve(vault.root, cleaned);

  if (!isInside(vault.root, target)) {
    throw new ToolError(`Path escapes the vault: ${relPath}`);
  }

  let existing = target;
  const rest = [];

  while (!lexists(existing)) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }

  let real;

  try {
    real = path.join(fs.realpathSync(existing), ...rest);
  } catch {
    throw new ToolError(`Path leads through a broken symlink: ${relPath}`);
  }

  if (!isInside(vault.root, real)) {
    throw new ToolError(`Path escapes the vault: ${relPath}`);
  }

  return {
    abs: real,
    rel: toPosix(path.relative(vault.root, target)),
    realRel: toPosix(path.relative(vault.root, real)),
  };
}

// For reading, listing and searching: hidden paths (.obsidian holds plugin settings, often with API keys) are off
// limits, also when a symlink leads there. The vault root itself ("") is fine.
function resolveReadable(vault, relPath = "") {
  const file = resolveInVault(vault, relPath);

  for (const rel of [file.rel, file.realRel]) {
    if (rel && isHiddenPath(rel)) {
      throw new ToolError(`Hidden and config paths can't be read: ${file.rel}`);
    }
  }

  return file;
}

// A file that disappears between listing and reading (renamed or synced away) is skipped, not an error.
async function statIfExists(abs) {
  try {
    return await fs.promises.stat(abs);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") {
      return null;
    }

    throw e;
  }
}

// errors, when given, collects the folders (relative to root, "" = root) that couldn't be read, so a caller can
// tell "gone" from "unreadable right now".
async function* walk(dir, root, errors) {
  let entries;

  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    errors?.push(toPosix(path.relative(root, dir)));
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const abs = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      yield* walk(abs, root, errors);
    } else if (entry.isFile()) {
      yield { abs, rel: toPosix(path.relative(root, abs)) };
    }
  }
}

async function listNotes(vault, { folder, extensions, limit }) {
  const base = resolveReadable(vault, folder);
  const exts = normalizeExtensions(extensions);
  const notes = [];
  let truncated = false;

  for await (const file of walk(base.abs, vault.root)) {
    if (exts && !exts.includes(path.extname(file.rel).toLowerCase())) {
      continue;
    }

    if (notes.length >= limit) {
      truncated = true;
      break;
    }

    const stat = await statIfExists(file.abs);

    if (!stat) {
      continue;
    }

    notes.push({
      path: file.rel,
      size: stat.size,
      modified: stat.mtime.toISOString(),
    });
  }

  return { notes, truncated };
}

// Where to cut buf[0..len) so it doesn't end inside a multi-byte UTF-8 character: if the last character is
// incomplete, the cut moves back to its first byte.
function utf8CutPoint(buf, len) {
  let i = len - 1;

  while (i >= 0 && i > len - 4 && (buf[i] & 0xc0) === 0x80) {
    i--;
  }

  if (i < 0 || buf[i] < 0xc0) {
    return len;
  }

  const size = buf[i] >= 0xf0 ? 4 : buf[i] >= 0xe0 ? 3 : 2;
  return i + size > len ? i : len;
}

async function readNote(vault, relPath) {
  const file = resolveReadable(vault, relPath);
  let stat;

  try {
    stat = await fs.promises.stat(file.abs);
  } catch {
    throw new ToolError(`Note not found: ${file.rel}`);
  }

  if (!stat.isFile()) {
    throw new ToolError(`Not a file: ${file.rel}`);
  }

  const handle = await fs.promises.open(file.abs, "r");

  try {
    const length = Math.min(stat.size, MAX_READ_BYTES);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    const truncated = stat.size > MAX_READ_BYTES;
    const end = truncated ? utf8CutPoint(buf, bytesRead) : bytesRead;

    return {
      path: file.rel,
      content: buf.toString("utf-8", 0, end),
      truncated,
      modified: stat.mtime.toISOString(),
    };
  } finally {
    await handle.close();
  }
}

const MAX_LINES_PER_NOTE = 5;

// Quoted phrases stay whole; other words are split on anything that isn't a letter or digit.
function parseTerms(query, caseSensitive) {
  const terms = [];

  for (const m of query.matchAll(/"([^"]+)"|[\p{L}\p{N}]+/gu)) {
    const term = (m[1] || m[0]).trim();

    if (term.length >= 2) {
      terms.push(caseSensitive ? term : term.toLowerCase());
    }
  }

  return [...new Set(terms)];
}

// Matching runs in a vm context with a timeout: V8 interrupts a running regex there, so a pathological pattern
// costs at most REGEX_BUDGET_MS per search instead of hanging the server.
const REGEX_SCAN = new vm.Script(
  "out = []; for (let i = 0; i < texts.length; i++) { if (re.test(texts[i])) out.push(i); }",
);

function regexMatcher(query, caseSensitive, budgetMs = REGEX_BUDGET_MS) {
  let re;

  try {
    re = new RegExp(query, caseSensitive ? "" : "i");
  } catch (e) {
    throw new ToolError(`Invalid regex: ${e.message}`);
  }

  const sandbox = vm.createContext({ re, texts: [], out: [] });
  // Only time spent matching counts: reading the notes between calls (slow on a network share) must not use it up.
  let leftMs = budgetMs;

  // findAll(texts) -> for each text, [0] when it matches, [] otherwise.
  const findAll = (texts) => {
    sandbox.texts = texts;
    const start = Date.now();

    try {
      REGEX_SCAN.runInContext(sandbox, { timeout: Math.max(1, leftMs) });
    } catch (e) {
      if (e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
        throw new ToolError(
          "The regular expression took too long to match (it may backtrack heavily, e.g. nested quantifiers like (a+)+). Simplify it, narrow the folder, or search with keywords instead.",
        );
      }

      throw e;
    } finally {
      leftMs -= Date.now() - start;
      sandbox.texts = [];
    }

    const hits = new Set(sandbox.out);
    return texts.map((_, i) => (hits.has(i) ? [0] : []));
  };

  return { terms: [query], findAll };
}

// Returns the parsed terms and a findAll(texts) giving, for each text, the indexes of the terms present in it.
function buildMatcher(query, { regex, caseSensitive }) {
  if (query.length > MAX_QUERY_CHARS) {
    throw new ToolError(`The query is too long (${query.length} characters, at most ${MAX_QUERY_CHARS}). Use a few short keywords.`);
  }

  if (regex) {
    return regexMatcher(query, caseSensitive);
  }

  const terms = parseTerms(query, caseSensitive);

  if (terms.length === 0) {
    throw new ToolError("The query has no searchable words");
  }

  const find = (text) => {
    const hay = caseSensitive ? text : text.toLowerCase();
    const found = [];

    terms.forEach((t, i) => {
      if (hay.includes(t)) {
        found.push(i);
      }
    });

    return found;
  };

  return { terms, findAll: (texts) => texts.map(find) };
}

// Keyword search over whole notes: every word must appear somewhere in the note (file name
// included), in any order. When no note has them all, notes with the most (and rarest) words win.
async function searchNotes(vault, opts) {
  const base = resolveReadable(vault, opts.folder);
  const exts = normalizeExtensions(opts.extensions) || [".md"];
  const { terms, findAll } = buildMatcher(opts.query, opts);
  const notes = [];

  for await (const file of walk(base.abs, vault.root)) {
    if (!exts.includes(path.extname(file.rel).toLowerCase())) {
      continue;
    }

    const stat = await statIfExists(file.abs);

    if (!stat) {
      continue;
    }

    const present = new Set(findAll([file.rel])[0]);
    const lines = present.size ? [{ line: 0, text: "(file name match)", hits: present.size }] : [];
    // A note that can't be read (permissions, I/O error) is left out of the results instead of failing the search.
    const text = stat.size <= MAX_SEARCH_FILE_BYTES ? await readIfExists(file.abs).catch(() => null) : null;

    if (text !== null) {
      const content = text.split(/\r?\n/);
      const foundPerLine = findAll(content);

      for (let i = 0; i < content.length; i++) {
        const found = foundPerLine[i];

        if (found.length) {
          found.forEach((t) => present.add(t));
          lines.push({ line: i + 1, text: content[i].trim().slice(0, 300), hits: found.length });
        }
      }
    }

    if (present.size) {
      notes.push({ path: file.rel, present, lines });
    }
  }

  // Rarer words weigh more, so "to" or "the" can't outrank "Wohnung".
  const docFreq = terms.map((_, i) => notes.filter((n) => n.present.has(i)).length);
  const weight = docFreq.map((df) => Math.log(1 + (notes.length + 1) / (df || 1)));

  let matched = "all";
  let hits = notes.filter((n) => n.present.size === terms.length);

  if (hits.length === 0 && terms.length > 1) {
    matched = "any";
    hits = notes;
  }

  const scored = hits.map((n) => ({
    ...n,
    score: [...n.present].reduce((sum, t) => sum + weight[t], 0),
  }));
  scored.sort((a, b) => b.score - a.score || b.lines.length - a.lines.length);

  const results = scored.slice(0, opts.limit).map((n) => ({
    path: n.path,
    matchedTerms: [...n.present].sort((a, b) => a - b).map((t) => terms[t]),
    matchingLines: n.lines.length,
    lines: [...n.lines]
      .sort((a, b) => b.hits - a.hits || a.line - b.line)
      .slice(0, MAX_LINES_PER_NOTE)
      .sort((a, b) => a.line - b.line)
      .map(({ line, text }) => ({ line, text })),
  }));

  const result = { terms, matched, results, truncated: scored.length > opts.limit };

  if (results.length === 0) {
    result.hint = "Nothing matched. Try fewer or different keywords, synonyms, or the language the notes are written in.";
  } else if (matched === "any") {
    result.hint = "No note contains every term; these contain some of them, best first.";
  }

  return result;
}

// A note's YAML frontmatter block, after an optional byte-order mark (Windows editors add one); group 1 is its body
// (undefined when the block is empty).
const FRONTMATTER = /^\uFEFF?---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/;

// Inserting at the very top would break a note's YAML frontmatter, so prepend goes right after it.
function insertAfterFrontmatter(existing, content) {
  const m = existing.match(FRONTMATTER);

  if (!m) {
    return content + existing;
  }

  return existing.slice(0, m[0].length) + content + existing.slice(m[0].length);
}

// "Inbox/Idea" and "Inbox/Idea." -> "Inbox/Idea.md"; "Inbox/v1.2 notes" -> "Inbox/v1.2 notes.md"; "x.canvas" stays.
function notePath(relPath) {
  const p = String(relPath).replace(/\\/g, "/").replace(/[.\s]+$/, "");
  return /\.[A-Za-z0-9]{1,10}$/.test(p.split("/").pop()) ? p : `${p}.md`;
}

// Every write goes through here: adds ".md" when there is no extension, refuses hidden paths and anything
// outside the caller's writable paths, checking both the path as given and where it really leads.
function resolveWritable(vault, relPath, allowed) {
  const file = resolveInVault(vault, notePath(relPath));

  for (const rel of [file.rel, file.realRel]) {
    if (!rel || isHiddenPath(rel)) {
      throw new ToolError(`Refusing to write to hidden or config path: ${file.rel || "/"}`);
    }

    if (!isWritable(vault.id, rel, allowed)) {
      throw new ToolError(
        `Writing to ${vault.id}/${file.rel} is not allowed. Writable: ${allowed.join(", ") || "(nothing)"}`,
      );
    }
  }

  return file;
}

// Per-file queue: read-modify-write calls on the same note run one after another, so none loses another's change.
const locks = new Map();

async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => (release = resolve));
  const tail = prev.then(() => mine);
  locks.set(key, tail);
  await prev;

  try {
    return await fn();
  } finally {
    release();

    if (locks.get(key) === tail) {
      locks.delete(key);
    }
  }
}

async function readIfExists(abs) {
  try {
    return await fs.promises.readFile(abs, "utf-8");
  } catch (e) {
    if (e.code === "ENOENT") {
      return null;
    }

    throw e;
  }
}

// The path was checked before the lock was taken; a folder on the way could have been swapped for a symlink since
// (directly on the share, not via MCP). Checked again once the folders exist, just before writing, and the note
// itself is opened without following a symlink. Best effort: this narrows the window, it can't close it.
function recheckWritable(vault, relPath, allowed, file) {
  if (resolveWritable(vault, relPath, allowed).abs !== file.abs) {
    throw new ToolError(`The path changed while writing (a folder was moved or replaced): ${file.rel}`);
  }
}

// The one way notes are changed: checks the path, then, under the note's lock, reads it (null = missing), lets
// change(existing) return the new text and writes it. A new note is created exclusively, never over a file that
// appeared in the meantime.
async function updateNote(vault, relPath, allowed, change) {
  const file = resolveWritable(vault, relPath, allowed);

  return withLock(file.abs, async () => {
    try {
      const existing = await readIfExists(file.abs);
      const next = await change(existing, file);

      await fs.promises.mkdir(path.dirname(file.abs), { recursive: true });
      recheckWritable(vault, relPath, allowed, file);

      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | (existing === null ? fs.constants.O_EXCL : fs.constants.O_TRUNC);
      const handle = await fs.promises.open(file.abs, flags | (fs.constants.O_NOFOLLOW || 0), 0o666);

      try {
        await handle.writeFile(next, "utf-8");
      } finally {
        await handle.close();
      }

      return { path: file.rel, created: existing === null, bytes: Buffer.byteLength(next) };
    } catch (e) {
      if (e.code === "EEXIST") {
        throw new ToolError(`Note already exists: ${file.rel}`);
      }

      if (e.code === "EISDIR" || e.code === "ENOTDIR") {
        throw new ToolError(`Not a note: ${file.rel}`);
      }

      if (e.code === "ELOOP") {
        throw new ToolError(`The note was replaced by a symlink while writing: ${file.rel}`);
      }

      throw e;
    }
  });
}

async function writeNote(vault, relPath, content, mode, allowed = writePaths()) {
  return updateNote(vault, relPath, allowed, (existing, file) => {
    if (existing === null) {
      return content;
    }

    if (mode === "create") {
      throw new ToolError(`Note already exists: ${file.rel}`);
    }

    if (mode === "append") {
      return existing + (existing === "" || existing.endsWith("\n") ? "" : "\n") + content;
    }

    if (mode === "prepend") {
      return insertAfterFrontmatter(existing, content.endsWith("\n") ? content : `${content}\n`);
    }

    return content;
  });
}

// Replaces one exact passage, so a model can change a line without rewriting (and maybe losing) the rest.
async function editNote(vault, relPath, oldText, newText, allowed = writePaths()) {
  const result = await updateNote(vault, relPath, allowed, (existing, file) => {
    if (existing === null) {
      throw new ToolError(`Note not found: ${file.rel}`);
    }

    const count = existing.split(oldText).length - 1;

    if (count === 0) {
      throw new ToolError(`old_text not found in ${file.rel}. Call read_note and copy the passage exactly.`);
    }

    if (count > 1) {
      throw new ToolError(`old_text appears ${count} times in ${file.rel}. Include more surrounding text so it is unique.`);
    }

    const i = existing.indexOf(oldText);
    return existing.slice(0, i) + newText + existing.slice(i + oldText.length);
  });

  return { path: result.path, replaced: 1, bytes: result.bytes };
}

function normalizeExtensions(exts) {
  if (!exts || exts.length === 0) {
    return null;
  }

  return exts.map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase());
}

module.exports = {
  MAX_SEARCH_FILE_BYTES,
  MAX_QUERY_CHARS,
  regexMatcher,
  FRONTMATTER,
  ToolError,
  defaultVault,
  writePaths,
  resolveVault,
  resolveInVault,
  resolveReadable,
  statIfExists,
  walk,
  listNotes,
  readNote,
  utf8CutPoint,
  searchNotes,
  updateNote,
  writeNote,
  editNote,
};
