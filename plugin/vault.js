const fs = require("fs");
const path = require("path");

const MAX_READ_BYTES = 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;

class ToolError extends Error {}

// Only vaults the user enabled for this plugin in Ignis -> Core plugins are reachable.
function resolveVault(ctx, vaultId) {
  const enabled = ctx.getEnabledVaults();

  if (!vaultId) {
    if (enabled.length === 1) {
      vaultId = enabled[0];
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

// Lexical check first, then the nearest existing ancestor's realpath, so symlinks can't lead outside the vault.
function resolveInVault(vault, relPath = "") {
  const cleaned = String(relPath).replace(/\\/g, "/").replace(/^\/+/, "");
  const target = path.resolve(vault.root, cleaned);

  if (!isInside(vault.root, target)) {
    throw new ToolError(`Path escapes the vault: ${relPath}`);
  }

  let existing = target;

  while (!fs.existsSync(existing)) {
    existing = path.dirname(existing);
  }

  if (!isInside(vault.root, fs.realpathSync(existing))) {
    throw new ToolError(`Path escapes the vault: ${relPath}`);
  }

  return { abs: target, rel: toPosix(path.relative(vault.root, target)) };
}

async function* walk(dir, root) {
  let entries;

  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const abs = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      yield* walk(abs, root);
    } else if (entry.isFile()) {
      yield { abs, rel: toPosix(path.relative(root, abs)) };
    }
  }
}

async function listNotes(vault, { folder, extensions, limit }) {
  const base = resolveInVault(vault, folder);
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

    const stat = await fs.promises.stat(file.abs);
    notes.push({
      path: file.rel,
      size: stat.size,
      modified: stat.mtime.toISOString(),
    });
  }

  return { notes, truncated };
}

async function readNote(vault, relPath) {
  const file = resolveInVault(vault, relPath);
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
    await handle.read(buf, 0, length, 0);

    return {
      path: file.rel,
      content: buf.toString("utf-8"),
      truncated: stat.size > MAX_READ_BYTES,
      modified: stat.mtime.toISOString(),
    };
  } finally {
    await handle.close();
  }
}

function buildMatcher(query, { regex, caseSensitive }) {
  if (regex) {
    let re;

    try {
      re = new RegExp(query, caseSensitive ? "" : "i");
    } catch (e) {
      throw new ToolError(`Invalid regex: ${e.message}`);
    }

    return (text) => re.test(text);
  }

  const needle = caseSensitive ? query : query.toLowerCase();
  return (text) =>
    (caseSensitive ? text : text.toLowerCase()).includes(needle);
}

async function searchNotes(vault, opts) {
  const base = resolveInVault(vault, opts.folder);
  const exts = normalizeExtensions(opts.extensions) || [".md"];
  const matches = buildMatcher(opts.query, opts);
  const results = [];
  let truncated = false;

  outer: for await (const file of walk(base.abs, vault.root)) {
    if (!exts.includes(path.extname(file.rel).toLowerCase())) {
      continue;
    }

    if (matches(file.rel)) {
      if (results.length >= opts.limit) {
        truncated = true;
        break;
      }

      results.push({ path: file.rel, line: 0, text: "(file name match)" });
    }

    const stat = await fs.promises.stat(file.abs);

    if (stat.size > MAX_SEARCH_FILE_BYTES) {
      continue;
    }

    const lines = (await fs.promises.readFile(file.abs, "utf-8")).split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      if (!matches(lines[i])) {
        continue;
      }

      if (results.length >= opts.limit) {
        truncated = true;
        break outer;
      }

      results.push({ path: file.rel, line: i + 1, text: lines[i].trim().slice(0, 300) });
    }
  }

  return { results, truncated };
}

// Inserting at the very top would break a note's YAML frontmatter, so prepend goes right after it.
function insertAfterFrontmatter(existing, content) {
  const m = existing.match(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/);

  if (!m) {
    return content + existing;
  }

  return existing.slice(0, m[0].length) + content + existing.slice(m[0].length);
}

async function writeNote(vault, relPath, content, mode) {
  if (!path.extname(String(relPath))) {
    relPath = `${relPath}.md`;
  }

  const file = resolveInVault(vault, relPath);

  if (!file.rel || isHiddenPath(file.rel)) {
    throw new ToolError(`Refusing to write to hidden or config path: ${file.rel || "/"}`);
  }

  let existing = null;

  try {
    existing = await fs.promises.readFile(file.abs, "utf-8");
  } catch (e) {
    if (e.code !== "ENOENT") {
      throw e;
    }
  }

  if (mode === "create" && existing !== null) {
    throw new ToolError(`Note already exists: ${file.rel}`);
  }

  let next = content;

  if (existing !== null && mode === "append") {
    next = existing + (existing === "" || existing.endsWith("\n") ? "" : "\n") + content;
  } else if (existing !== null && mode === "prepend") {
    next = insertAfterFrontmatter(existing, content.endsWith("\n") ? content : `${content}\n`);
  }

  await fs.promises.mkdir(path.dirname(file.abs), { recursive: true });
  await fs.promises.writeFile(file.abs, next, "utf-8");

  return { path: file.rel, created: existing === null, bytes: Buffer.byteLength(next) };
}

function normalizeExtensions(exts) {
  if (!exts || exts.length === 0) {
    return null;
  }

  return exts.map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase());
}

module.exports = {
  ToolError,
  resolveVault,
  listNotes,
  readNote,
  searchNotes,
  writeNote,
};
