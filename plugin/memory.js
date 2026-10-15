// remember / forget: memory notes with consistent frontmatter, so a small model only has to supply the text.
// A memory is a note in the memory vault's inbox (MCP_MEMORY_VAULT, default MCP_DEFAULT_VAULT; MCP_MEMORY_INBOX,
// default "Inbox"), with frontmatter type / source / date / status. Writes go through writeNote, so the caller's
// writable paths still apply.
const { ToolError, defaultVault, readNote, writeNote } = require("./vault");

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

// A usable file name: no path or Obsidian link characters, no leading dots, at most 80 characters.
function noteTitle(title, text) {
  const source = (title || "").trim() || text.trim().split(/\s+/).slice(0, 8).join(" ");

  return source
    .replace(/[\\/:*?"<>|#^[\]\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.,;!]+$/g, "")
    .slice(0, 80)
    .trim();
}

function yamlString(s) {
  return JSON.stringify(String(s));
}

// Sets top-level keys in a note's YAML frontmatter, adding the block when there is none. Other keys stay as they are.
function setFrontmatter(text, fields) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  const body = m ? m[1].split(/\r?\n/) : [];

  for (const [k, v] of Object.entries(fields)) {
    const i = body.findIndex((l) => l.startsWith(`${k}:`));

    if (i >= 0) {
      body[i] = `${k}: ${v}`;
    } else {
      body.push(`${k}: ${v}`);
    }
  }

  return `---\n${body.join("\n")}\n---\n${m ? text.slice(m[0].length) : text}`;
}

async function remember(vault, { text, title, type, source }, allowed) {
  const date = today();
  let name = noteTitle(title, text) || `Memory ${date}`;

  if (type === "episode" && !name.startsWith(date)) {
    name = `${date} ${name}`;
  }

  const rel = `${memoryConfig().inbox}/${name}.md`;
  const body = text.trim();

  try {
    const result = await writeNote(
      vault,
      rel,
      `${setFrontmatter("", { type, source: yamlString(source || "assistant"), date, status: "inbox" })}# ${name}\n\n${body}\n`,
      "create",
      allowed,
    );
    return { ...result, vault: vault.id };
  } catch (e) {
    if (!(e instanceof ToolError) || !e.message.startsWith("Note already exists")) {
      throw e;
    }
  }

  // Same title: add to the existing memory instead of making a near-duplicate.
  const result = await writeNote(vault, rel, `\n## Update ${date}\n\n${body}\n`, "append", allowed);
  return { ...result, vault: vault.id, updated: true };
}

async function forget(vault, { path, reason }, allowed) {
  const note = await readNote(vault, path);

  if (note.truncated) {
    throw new ToolError(`${note.path} is too large to update safely.`);
  }

  const next = setFrontmatter(note.content, {
    status: "outdated",
    outdated_on: today(),
    outdated_reason: yamlString(reason),
  });
  const result = await writeNote(vault, note.path, next, "overwrite", allowed);
  return { ...result, vault: vault.id, status: "outdated" };
}

module.exports = { MEMORY_TYPES, memoryConfig, noteTitle, setFrontmatter, today, remember, forget };
