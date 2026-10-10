const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { registerTools } = require("./tools");

const SERVER_INFO = { name: "ignis-vaults", version: "0.1.0" };

module.exports = {
  id: "mcp",
  name: "MCP Server",
  description:
    "Expose enabled vaults to AI clients over MCP at /api/ext/mcp (no auth, LAN only)",
  version: SERVER_INFO.version,

  _ctx: null,

  async register(ctx) {
    this._ctx = ctx;

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
        registerTools(server, ctx);
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
      res.status(405).set("Allow", "POST").json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed" },
        id: null,
      });
    };
    ctx.router.get("/", notAllowed);
    ctx.router.delete("/", notAllowed);

    ctx.log(`MCP endpoint ready at /api/ext/${this.id}`);
  },

  async shutdown() {
    this._ctx = null;
  },

  async onVaultEnabled(vaultId) {
    this._ctx?.log(`Vault exposed over MCP: ${vaultId}`);
  },

  async onVaultDisabled(vaultId) {
    this._ctx?.log(`Vault no longer exposed over MCP: ${vaultId}`);
  },
};
