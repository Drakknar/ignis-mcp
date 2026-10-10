const { z } = require("zod");
const {
  ToolError,
  resolveVault,
  listNotes,
  readNote,
  searchNotes,
  writeNote,
} = require("./vault");

const vaultArg = z
  .string()
  .optional()
  .describe("Vault name. Optional when only one vault is enabled for MCP.");

const folderArg = z
  .string()
  .optional()
  .describe("Folder inside the vault, e.g. \"Projects/2026\". Defaults to the vault root.");

const extensionsArg = z
  .array(z.string())
  .optional()
  .describe("File extensions to include, e.g. [\"md\", \"canvas\"].");

function ok(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

// Expected failures (bad path, unknown vault) go back to the model as tool errors it can correct; anything else is logged too.
function wrap(ctx, name, fn) {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      if (!(e instanceof ToolError)) {
        ctx.log(`${name} failed: ${e.stack || e.message}`);
      }

      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  };
}

function registerTools(server, ctx) {
  server.registerTool(
    "list_vaults",
    {
      title: "List vaults",
      description: "List the Obsidian vaults exposed over MCP.",
      annotations: { readOnlyHint: true },
    },
    wrap(ctx, "list_vaults", async () => ({ vaults: ctx.getEnabledVaults() })),
  );

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description:
        "List files in a vault or folder, recursively, with size and last-modified time. Hidden folders such as .obsidian and .trash are skipped.",
      inputSchema: {
        vault: vaultArg,
        folder: folderArg,
        extensions: extensionsArg,
        limit: z.number().int().min(1).max(5000).default(500),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(ctx, "list_notes", async ({ vault, ...opts }) =>
      listNotes(resolveVault(ctx, vault), opts),
    ),
  );

  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description: "Read a note's full text (up to 1 MB) by its path inside the vault.",
      inputSchema: {
        vault: vaultArg,
        path: z.string().describe("Path inside the vault, e.g. \"Daily/2026-10-10.md\"."),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(ctx, "read_note", async ({ vault, path }) =>
      readNote(resolveVault(ctx, vault), path),
    ),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Search note file names and contents. Returns matching lines with their path and line number (line 0 = file name match).",
      inputSchema: {
        vault: vaultArg,
        query: z.string().min(1).describe("Text to find, or a regular expression when regex is true."),
        regex: z.boolean().default(false),
        caseSensitive: z.boolean().default(false),
        folder: folderArg,
        extensions: extensionsArg.describe("File extensions to search. Defaults to [\"md\"]."),
        limit: z.number().int().min(1).max(500).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(ctx, "search_notes", async ({ vault, ...opts }) =>
      searchNotes(resolveVault(ctx, vault), opts),
    ),
  );

  server.registerTool(
    "write_note",
    {
      title: "Write note",
      description:
        "Create or change a note. Missing folders are created and \".md\" is added when the path has no extension. Modes: create (fails if it exists), overwrite, append (to the end), prepend (after the YAML frontmatter). Hidden paths such as .obsidian are refused. Open Obsidian tabs pick up the change.",
      inputSchema: {
        vault: vaultArg,
        path: z.string().describe("Path inside the vault, e.g. \"Inbox/Idea.md\"."),
        content: z.string(),
        mode: z.enum(["create", "overwrite", "append", "prepend"]).default("create"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrap(ctx, "write_note", async ({ vault, path, content, mode }) =>
      writeNote(resolveVault(ctx, vault), path, content, mode),
    ),
  );
}

module.exports = { registerTools };
