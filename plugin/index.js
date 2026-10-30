const crypto = require("crypto");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { registerTools } = require("./tools");
const { resolveVault, writePaths } = require("./vault");
const semantic = require("./semantic");

const SERVER_INFO = { name: "ignis-vaults", version: "0.8.1" };

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest();
}

// Narrowest first.
const ROLES = ["reader", "agent", "admin"];

// tokens: { role: token }. The matching role is stored on req.mcpRole. The presented token's digest is compared
// with every configured one, so the check takes the same time whatever the length or content of the token.
function requireBearer(tokens) {
  const known = Object.entries(tokens)
    .filter(([, t]) => t)
    .map(([role, t]) => [role, sha256(t)]);

  return (req, res, next) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
    const presented = m ? sha256(m[1].trim()) : null;
    const matches = presented
      ? known.filter(([, d]) => crypto.timingSafeEqual(presented, d))
      : [];

    if (matches.length > 0) {
      // A token set for several roles gets the narrowest of them.
      req.mcpRole = ROLES.find((r) => matches.some(([role]) => role === r));
      return next();
    }

    res
      .status(401)
      .set("WWW-Authenticate", 'Bearer realm="ignis-mcp"')
      .json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Unauthorized: missing or wrong bearer token",
        },
        id: null,
      });
  };
}

module.exports = {
  id: "mcp",
  name: "MCP Server",
  description:
    "Expose enabled vaults to AI clients over MCP at /api/ext/mcp (bearer tokens when MCP_TOKEN / MCP_ADMIN_TOKEN are set)",
  version: SERVER_INFO.version,

  _ctx: null,

  async register(ctx) {
    this._ctx = ctx;

    // MCP_READ_TOKEN = read tools only; MCP_TOKEN = agents, limited by MCP_WRITE_PATHS; MCP_ADMIN_TOKEN = write
    // anywhere. None set = open, agent limits. Trimmed like the presented token, so a stray space in the container
    // setting doesn't lock everyone out.
    const tokens = {
      reader: (process.env.MCP_READ_TOKEN || "").trim(),
      agent: (process.env.MCP_TOKEN || "").trim(),
      admin: (process.env.MCP_ADMIN_TOKEN || "").trim(),
    };
    const auth = ROLES.some((r) => tokens[r]);

    if (auth) {
      ctx.router.use(requireBearer(tokens));
    }

    // Stateless Streamable HTTP: a fresh server + transport per request, so there is no session state to leak or expire.
    ctx.router.post("/", async (req, res) => {
      const server = new McpServer(SERVER_INFO);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        transport.close();
        server.close();
      });

      try {
        registerTools(server, ctx, {
          readOnly: req.mcpRole === "reader",
          writable:
            req.mcpRole === "reader"
              ? []
              : req.mcpRole === "admin"
                ? null
                : writePaths(),
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (e) {
        ctx.log(`Request failed: ${e.message}`);

        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    });

    // Stateless mode has no server-initiated stream (GET) and no sessions to end (DELETE).
    const notAllowed = (req, res) => {
      res
        .status(405)
        .set("Allow", "POST")
        .json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        });
    };
    ctx.router.get("/", notAllowed);
    ctx.router.delete("/", notAllowed);

    ctx.log(
      `MCP endpoint ready at /api/ext/${this.id}` +
        (auth
          ? ` (bearer token required: ${ROLES.filter((r) => tokens[r]).join(" + ")})`
          : " (no auth: set MCP_TOKEN to require a bearer token)"),
    );

    const writable = writePaths();
    ctx.log(
      writable === null
        ? "Agents may write anywhere (MCP_WRITE_PATHS unset or *)"
        : writable.length
          ? `Agents may write to: ${writable.join(", ")}`
          : "Agents may not write anywhere (MCP_TOKEN set without MCP_WRITE_PATHS)",
    );

    const embed = semantic.embedConfig();
    ctx.log(
      embed
        ? `Semantic search on: ${embed.model} at ${embed.url}${embed.options.num_gpu === 0 ? " (CPU)" : ""}`
        : "Semantic search off (set MCP_EMBED_URL to an Ollama server to enable it)",
    );
  },

  async shutdown() {
    semantic.stopAll();
    this._ctx = null;
  },

  async onVaultEnabled(vaultId) {
    this._ctx?.log(`Vault exposed over MCP: ${vaultId}`);

    // Index in the background; Ignis awaits this hook during startup.
    try {
      semantic.startVault(this._ctx, resolveVault(this._ctx, vaultId));
    } catch (e) {
      this._ctx?.log(`Semantic index not started for ${vaultId}: ${e.message}`);
    }
  },

  async onVaultDisabled(vaultId) {
    semantic.stopVault(vaultId);
    this._ctx?.log(`Vault no longer exposed over MCP: ${vaultId}`);
  },
};
