// Stand-in for Ollama's /api/embed in the smoke test: a hashed bag of words, where a few words
// share a meaning, so semantic_search can be checked without downloading a real model.
// Usage: node scripts/fake-embed.js <port>
const http = require("http");

const SAME = {
  boiler: "heating",
  heater: "heating",
  inspection: "service",
  serviced: "service",
};
const DIMS = 1024;

function embed(text) {
  const v = Array.from({ length: DIMS }, () => 0);

  for (let w of text.toLowerCase().match(/[a-z]+/g) || []) {
    w = SAME[w] || w;
    let h = 0;

    for (const c of w) {
      h = (h * 31 + c.charCodeAt(0)) % DIMS;
    }

    v[h] += 1;
  }

  return v;
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const { model, input } = JSON.parse(body || "{}");

      if (req.url !== "/api/embed" || model !== "fake-embed") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `model "${model}" not found` }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ model, embeddings: [].concat(input).map(embed) }),
      );
    });
  })
  .listen(Number(process.argv[2]), "0.0.0.0");
