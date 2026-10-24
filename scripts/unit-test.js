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
