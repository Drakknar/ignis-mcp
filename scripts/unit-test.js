// Plugin unit tests that need no Docker and no npm install: node --test scripts/unit-test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { searchNotes, regexMatcher, ToolError } = require("../plugin/vault");

function tempVault(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ignis-mcp-test-")));

  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }

  return { id: "Test", root };
}

test("search_notes regex still finds matching lines", async () => {
  const vault = tempVault({ "A.md": "first\nNothing to see\n", "B.md": "other\n" });
  const r = await searchNotes(vault, { query: "^nothing to", regex: true, limit: 20 });
  assert.deepStrictEqual(r.results.map((n) => [n.path, n.lines]), [["A.md", [{ line: 2, text: "Nothing to see" }]]]);
});

test("a catastrophically backtracking regex fails fast instead of hanging", async () => {
  const vault = tempVault({ "A.md": `${"a".repeat(40)}!\n` });
  const start = Date.now();
  await assert.rejects(searchNotes(vault, { query: "(a+)+$", regex: true, limit: 20 }), (e) => e instanceof ToolError);
  assert.ok(Date.now() - start < 10000, "search should stop within its time budget");
});

test("the regex time budget is shared by all files of a search", () => {
  const { findAll } = regexMatcher("(a+)+$", false, 200);
  const start = Date.now();
  assert.throws(() => findAll([`${"a".repeat(40)}!`]), ToolError);
  assert.throws(() => findAll([`${"a".repeat(40)}!`]), ToolError);
  assert.ok(Date.now() - start < 2000);
});

test("vaults whose names differ only in special characters get separate index files", () => {
  const { indexFile } = require("../plugin/semantic");
  assert.notStrictEqual(indexFile("/d", "My Vault", "bge-m3"), indexFile("/d", "My_Vault", "bge-m3"));
  assert.notStrictEqual(indexFile("/d", "Notes", "bge-m3:latest"), indexFile("/d", "Notes", "bge-m3_latest"));
  assert.strictEqual(indexFile("/d", "Notes", "bge-m3"), indexFile("/d", "Notes", "bge-m3"));
});

test("an index saved under the old file name is taken over, unless another vault shares that name", async () => {
  const { VaultIndex } = require("../plugin/semantic");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-mcp-data-"));
  const cfg = { model: "m" };
  const vec = Buffer.from(new Float32Array([1, 0]).buffer).toString("base64");
  const legacy = { version: 1, model: "m", notes: { "A.md": { mtimeMs: 1, size: 1, chunks: [{ line: 1, heading: "", excerpt: "", vec }] } } };
  const legacyPath = path.join(dataDir, "semantic-My_Vault-m.json");
  const log = () => {};

  fs.writeFileSync(legacyPath, JSON.stringify(legacy));
  const shared = new VaultIndex({ id: "My Vault", root: "/x" }, cfg, dataDir, log, () => ["My Vault", "My_Vault"]);
  await shared.load();
  assert.strictEqual(shared.notes.size, 0);
  assert.ok(fs.existsSync(legacyPath));

  const alone = new VaultIndex({ id: "My Vault", root: "/x" }, cfg, dataDir, log, () => ["My Vault"]);
  await alone.load();
  assert.deepStrictEqual([...alone.notes.keys()], ["A.md"]);
  assert.ok(!fs.existsSync(legacyPath) && fs.existsSync(alone.file));

  // The other vault no longer sees that index.
  const other = new VaultIndex({ id: "My_Vault", root: "/y" }, cfg, dataDir, log, () => ["My Vault", "My_Vault"]);
  await other.load();
  assert.strictEqual(other.notes.size, 0);
  assert.notStrictEqual(other.file, alone.file);
});

test("an unreadable note doesn't make the whole search fail", { skip: process.getuid?.() === 0 }, async () => {
  const vault = tempVault({ "A.md": "hello\n", "B.md": "hello\n" });
  fs.chmodSync(path.join(vault.root, "B.md"), 0);
  const r = await searchNotes(vault, { query: "hello", limit: 20 });
  assert.deepStrictEqual(r.results.map((n) => n.path), ["A.md"]);
});
