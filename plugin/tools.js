const { z } = require("zod");
const {
  ToolError,
  defaultVault,
  writePaths,
  resolveVault,
  listNotes,
  readNote,
  searchNotes,
  writeNote,
} = require("./vault");
const { embedConfig, noteChanged, semanticSearch } = require("./semantic");

const vaultArg = z
  .string()
  .optional()
  .describe("Vault name. Optional when only one vault is enabled or a default vault is set (see list_vaults).");

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

// access.writable: where this caller may write (null = anywhere), decided by its token in index.js.
function registerTools(server, ctx, access = { writable: writePaths() }) {
  server.registerTool(
    "list_vaults",
    {
      title: "List vaults",
      description:
        "List the Obsidian vaults exposed over MCP, the default vault used when a call names none, and where write_note may write (null = anywhere).",
      annotations: { readOnlyHint: true },
    },
    wrap(ctx, "list_vaults", async () => ({
      vaults: ctx.getEnabledVaults(),
      defaultVault: defaultVault(),
      writable: access.writable,
    })),
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
        "Keyword search across note names and contents. Pass a few short keywords, not a whole question: for \"What do I need to buy a flat in Berlin?\" search \"flat Berlin buy\". A note matches when it contains every keyword anywhere, in any order (\"Wohnung\" also matches \"Wohnungskauf\"); put a phrase in double quotes to keep it together. If no note has them all, the notes with the most keywords come back instead (matched: \"any\"). Results are notes, best first, each with its most relevant lines (line 0 = file name match). Search again with synonyms or another language if nothing useful comes back, then call read_note on the best paths before answering.",
      inputSchema: {
        vault: vaultArg,
        query: z.string().min(1).describe("Keywords, e.g. \"flat Berlin\" or \"\\\"notary appointment\\\" Wohnung\". A regular expression when regex is true."),
        regex: z.boolean().default(false).describe("Treat query as one regular expression matched line by line."),
        caseSensitive: z.boolean().default(false),
        folder: folderArg,
        extensions: extensionsArg.describe("File extensions to search. Defaults to [\"md\"]."),
        limit: z.number().int().min(1).max(200).default(20).describe("Maximum number of notes to return."),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(ctx, "search_notes", async ({ vault, ...opts }) =>
      searchNotes(resolveVault(ctx, vault), opts),
    ),
  );

  // Only offered when an embedding server is configured (MCP_EMBED_URL).
  if (embedConfig()) {
    server.registerTool(
      "semantic_search",
      {
        title: "Search notes by meaning",
        description:
          "Search notes by meaning instead of exact words: finds notes about the same thing even when they use other words or another language (\"when was the heating last checked?\" finds a note titled \"Boiler service\"). Pass a natural question or description. Results are notes, best first, with their most relevant passages and a similarity score (0-1; above about 0.5 is usually relevant). Use it for vague questions or when search_notes finds nothing; use search_notes for exact names, numbers or phrases. Call read_note on the best paths before answering.",
        inputSchema: {
          vault: vaultArg,
          query: z.string().min(1).describe("A question or description, e.g. \"what did the notary say about the flat purchase?\"."),
          folder: folderArg,
          limit: z.number().int().min(1).max(50).default(8).describe("Maximum number of notes to return."),
        },
        annotations: { readOnlyHint: true },
      },
      wrap(ctx, "semantic_search", async ({ vault, ...opts }) =>
        semanticSearch(ctx, resolveVault(ctx, vault), opts),
      ),
    );
  }

  server.registerTool(
    "write_note",
    {
      title: "Write note",
      description:
        "Create or change a note. Missing folders are created and \".md\" is added when the path has no extension. Modes: create (fails if it exists), overwrite, append (to the end), prepend (after the YAML frontmatter). Hidden paths such as .obsidian are refused, and so is anything outside the writable paths listed by list_vaults. Open Obsidian tabs pick up the change.",
      inputSchema: {
        vault: vaultArg,
        path: z.string().describe("Path inside the vault, e.g. \"Inbox/Idea.md\"."),
        content: z.string(),
        mode: z.enum(["create", "overwrite", "append", "prepend"]).default("create"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrap(ctx, "write_note", async ({ vault, path, content, mode }) => {
      const v = resolveVault(ctx, vault);
      const result = await writeNote(v, path, content, mode, access.writable);
      noteChanged(ctx, v);
      return result;
    }),
  );
}

module.exports = { registerTools };
