// remember / forget: memory notes with consistent frontmatter, so a small model only has to supply the text.
// A memory is a note in the memory vault's inbox (MCP_MEMORY_VAULT, default MCP_DEFAULT_VAULT; MCP_MEMORY_INBOX,
// default "Inbox"), with frontmatter type / source / date / status. Writes go through updateNote, so the caller's
// writable paths still apply.
const { FRONTMATTER, ToolError, defaultVault, updateNote } = require("./vault");

const MEMORY_TYPES = ["fact", "preference", "episode", "procedure"];

function memoryConfig(env = process.env) {
  return {
    vault: (env.MCP_MEMORY_VAULT || "").trim() || defaultVault(env),
    inbox: ((env.MCP_MEMORY_INBOX || "").trim() || "Inbox").replace(/^\/+|\/+$/g, ""),
  };
}

// Local date, so an evening memory isn't dated tomorrow in UTC.
function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// A usable file name: no path (either slash: paths treat "\" as "/") or Obsidian link characters, no leading dots,
// at most 80 characters.
function noteTitle(title, text) {
  const source = (title || "").trim() || text.trim().split(/\s+/).slice(0, 8).join(" ");

  return source
    .replace(/[\/\\:*?"<>|#^[\]\r\n\t\0]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.,;!]+$/g, "")
    .slice(0, 80)
    .trim();
}

function yamlString(s) {
  return JSON.stringify(String(s));
}

// A top-level "key:" line. The lines after it that aren't one (indented, "- item", blank) belong to that key.
const KEY_LINE = /^([^\s#:-][^:]*):(?:\s|$)/;

// Sets top-level keys in a note's YAML frontmatter (null removes one), adding the block when there is none.
// A key is replaced with all its lines and duplicates are dropped; other keys stay as they are.
function setFrontmatter(text, fields) {
  const m = text.match(FRONTMATTER);
  let entries = [];

  for (const line of m && m[1] ? m[1].split(/\r?\n/) : []) {
    const key = KEY_LINE.exec(line);

    if (key || entries.length === 0) {
      entries.push({ key: key ? key[1].trim() : null, lines: [line] });
    } else {
      entries[entries.length - 1].lines.push(line);
    }
  }

  for (const [k, v] of Object.entries(fields)) {
    const first = entries.findIndex((e) => e.key === k);

    if (v !== null && first >= 0) {
      entries[first] = { key: k, lines: [`${k}: ${v}`], keep: true };
    }

    entries = entries.filter((e) => e.key !== k || e.keep).map(({ keep, ...e }) => e);

    if (v !== null && first < 0) {
      entries.push({ key: k, lines: [`${k}: ${v}`] });
    }
  }

  const body = entries.flatMap((e) => e.lines);
  return `---\n${body.join("\n")}${body.length ? "\n" : ""}---\n${m ? text.slice(m[0].length) : text}`;
}

async function remember(vault, { text, title, type, source }, allowed) {
  const date = today();
  let name = noteTitle(title, text) || `Memory ${date}`;

  if (type === "episode" && !name.startsWith(date)) {
    name = `${date} ${name}`;
  }

  const body = text.trim();

  // Same title: add to the existing memory instead of making a near-duplicate. New information makes it current
  // again and puts it back up for review, even if it had been forgotten.
  const result = await updateNote(vault, `${memoryConfig().inbox}/${name}.md`, allowed, (existing) => {
    if (existing === null) {
      return `${setFrontmatter("", { type, source: yamlString(source || "assistant"), date, status: "inbox" })}# ${name}\n\n${body}\n`;
    }

    const current = setFrontmatter(existing, { date, status: "inbox", outdated_on: null, outdated_reason: null });
    return `${current}${current.endsWith("\n") ? "" : "\n"}\n## Update ${date}\n\n${body}\n`;
  });

  return { ...result, vault: vault.id, ...(result.created ? {} : { updated: true }) };
}

async function forget(vault, { path, reason }, allowed) {
  const result = await updateNote(vault, path, allowed, (existing, file) => {
    if (existing === null) {
      throw new ToolError(`Note not found: ${file.rel}`);
    }

    return setFrontmatter(existing, { status: "outdated", outdated_on: today(), outdated_reason: yamlString(reason) });
  });

  return { ...result, vault: vault.id, status: "outdated" };
}

module.exports = { MEMORY_TYPES, memoryConfig, noteTitle, setFrontmatter, today, remember, forget };
