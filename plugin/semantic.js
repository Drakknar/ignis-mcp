const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  ToolError,
  walk,
  resolveReadable,
  statIfExists,
  MAX_SEARCH_FILE_BYTES,
} = require("./vault");

// Search by meaning: notes are split into passages, embedded with an Ollama embedding model and
// compared with the embedded query. Off unless MCP_EMBED_URL points at an Ollama server.
const CHUNK_CHARS = 1200;
const EXCERPT_CHARS = 300;
const BATCH = 16;
const RESYNC_MS = 15 * 60 * 1000;
const QUERY_WAIT_MS = 20 * 1000;
const SAVE_EVERY_MS = 10 * 1000;
const PASSAGES_PER_NOTE = 2;

function embedConfig(env = process.env) {
  if (!env.MCP_EMBED_URL) {
    return null;
  }

  return {
    url: env.MCP_EMBED_URL.replace(/\/+$/, ""),
    model: env.MCP_EMBED_MODEL || "bge-m3",
    keepAlive: env.MCP_EMBED_KEEP_ALIVE || "1h",
    // CPU by default, so the embedding model never pushes a chat model out of VRAM.
    options: env.MCP_EMBED_GPU === "true" ? {} : { num_gpu: 0 },
  };
}

function normalize(vec) {
  const out = Float32Array.from(vec);
  let norm = 0;

  for (const v of out) {
    norm += v * v;
  }

  norm = Math.sqrt(norm) || 1;

  for (let i = 0; i < out.length; i++) {
    out[i] /= norm;
  }

  return out;
}

// Error messages name the model but not the server: they reach the model, and the URL is internal.
async function embed(cfg, inputs, log) {
  let res;

  try {
    res = await fetch(`${cfg.url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        input: inputs,
        truncate: true,
        keep_alive: cfg.keepAlive,
        options: cfg.options,
      }),
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
  } catch (e) {
    log?.(
      `Embedding server unreachable at ${cfg.url}: ${e.cause?.message || e.message}`,
    );
    throw new ToolError(
      "Embedding server unreachable; details are in the Ignis log.",
    );
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    log?.(
      `Embedding model "${cfg.model}" at ${cfg.url} failed (${res.status}): ${body}`,
    );
    throw new ToolError(
      `Embedding model "${cfg.model}" failed (HTTP ${res.status}); details are in the Ignis log.`,
    );
  }

  const { embeddings } = await res.json().catch(() => ({}));

  if (
    !Array.isArray(embeddings) ||
    embeddings.length !== inputs.length ||
    !embeddings.every(
      (v) =>
        Array.isArray(v) && v.length > 0 && v.length === embeddings[0].length,
    )
  ) {
    throw new ToolError(
      `Embedding model "${cfg.model}" returned an unexpected response`,
    );
  }

  return embeddings.map(normalize);
}

// Passages follow the note's headings, so each one stays about a single topic; long sections are
// cut at paragraph breaks. The note title and heading go into the embedded text for context.
function chunkNote(rel, text) {
  const title = path.basename(rel, path.extname(rel));
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let heading = "";
  let buf = [];
  let start = 1;

  const flush = () => {
    const body = buf.join("\n").trim();

    if (body) {
      chunks.push({ line: start, heading, body });
    }

    buf = [];
  };

  // YAML frontmatter is metadata, not prose: skip it so it doesn't dilute the first passage.
  let first = 0;

  if (lines[0].replace(/^\uFEFF/, "") === "---") {
    const end = lines.indexOf("---", 1);
    first = end > 0 ? end + 1 : 0;
  }

  for (let i = first; i < lines.length; i++) {
    const h = lines[i].match(/^#{1,6}\s+(.*)$/);

    if (h) {
      flush();
      heading = h[1].trim();
      start = i + 1;
      continue;
    }

    if (buf.length === 0) {
      start = i + 1;
    }

    const size = buf.reduce((n, l) => n + l.length + 1, 0);

    if (
      size + lines[i].length > CHUNK_CHARS &&
      buf.length &&
      lines[i].trim() === ""
    ) {
      flush();
      continue;
    }

    if (size + lines[i].length > CHUNK_CHARS * 2) {
      flush();
      start = i + 1;
    }

    buf.push(lines[i]);
  }

  flush();

  if (chunks.length === 0) {
    chunks.push({ line: 1, heading: "", body: "" });
  }

  return chunks.map((c) => ({
    line: c.line,
    heading: c.heading,
    excerpt: c.body.replace(/\s+/g, " ").slice(0, EXCERPT_CHARS),
    input: [title + (c.heading ? ` > ${c.heading}` : ""), c.body]
      .filter(Boolean)
      .join("\n"),
  }));
}

function safeName(s) {
  return String(s).replace(/[^\w.-]+/g, "_");
}

// Up to 0.8.0 the index file was named after safeName() alone, so "My Vault" and "My_Vault" shared one file and
// overwrote each other's index. The readable part stays, and a hash of the exact vault and model makes it unique.
function legacyIndexFile(dataDir, vaultId, model) {
  return path.join(
    dataDir,
    `semantic-${safeName(vaultId)}-${safeName(model)}.json`,
  );
}

function indexFile(dataDir, vaultId, model) {
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify([vaultId, model]))
    .digest("hex")
    .slice(0, 12);
  return path.join(
    dataDir,
    `semantic-${safeName(vaultId)}-${safeName(model)}-${hash}.json`,
  );
}

// One index per vault, kept in memory and saved to the plugin's data folder. It is brought up to
// date by comparing each note's mtime and size, so edits made in Obsidian are picked up too.
class VaultIndex {
  // enabledVaults() lists the enabled vault ids; it decides whether an old shared-name index can be taken over.
  constructor(vault, cfg, dataDir, log, enabledVaults = () => []) {
    this.vault = vault;
    this.cfg = cfg;
    this.log = log;
    this.enabledVaults = enabledVaults;
    this.file = indexFile(dataDir, vault.id, cfg.model);
    this.legacyFile = legacyIndexFile(dataDir, vault.id, cfg.model);
    this.notes = new Map();
    this.loaded = false;
    this.running = null;
    this.again = false;
    this.pending = 0;
    this.total = 0;
    this.lastError = null;
    this.lastSave = 0;
    this.dirty = false;
  }

  async load() {
    if (this.loaded) {
      return;
    }

    this.loaded = true;
    await this.adoptLegacy();

    try {
      const data = JSON.parse(await fs.promises.readFile(this.file, "utf-8"));

      // Written for another vault or model (should not happen with hashed names): start over rather than mix.
      if (
        (data.vault !== undefined && data.vault !== this.vault.id) ||
        (data.model !== undefined && data.model !== this.cfg.model)
      ) {
        throw new Error("index belongs to another vault or model");
      }

      for (const [rel, n] of Object.entries(data.notes || {})) {
        this.notes.set(rel, {
          ...n,
          chunks: n.chunks.map((c) => {
            // Small Buffers share a pooled ArrayBuffer, so copy out exactly this vector's bytes.
            const buf = Buffer.from(c.vec, "base64");
            const bytes = buf.buffer.slice(
              buf.byteOffset,
              buf.byteOffset + buf.byteLength,
            );
            return { ...c, vec: new Float32Array(bytes) };
          }),
        });
      }
    } catch (e) {
      if (e.code !== "ENOENT") {
        this.log(
          `Semantic index for ${this.vault.id} unreadable, rebuilding: ${e.message}`,
        );
      }
    }
  }

  // Moves an index saved under the old name to the new one, so upgrading doesn't re-embed every note. Skipped when
  // another enabled vault maps to the same old name: the file may hold that vault's notes.
  async adoptLegacy() {
    if (fs.existsSync(this.file) || !fs.existsSync(this.legacyFile)) {
      return;
    }

    const shared = this.enabledVaults().some(
      (id) => id !== this.vault.id && safeName(id) === safeName(this.vault.id),
    );

    if (shared) {
      this.log(
        `Semantic index for ${this.vault.id}: old index file is shared with another vault, rebuilding`,
      );
      return;
    }

    try {
      await fs.promises.rename(this.legacyFile, this.file);
    } catch (e) {
      this.log(
        `Semantic index for ${this.vault.id}: old index file not moved, rebuilding: ${e.message}`,
      );
    }
  }

  async save(force = false) {
    if (!this.dirty || (!force && Date.now() - this.lastSave < SAVE_EVERY_MS)) {
      return;
    }

    const notes = {};

    for (const [rel, n] of this.notes) {
      notes[rel] = {
        mtimeMs: n.mtimeMs,
        size: n.size,
        chunks: n.chunks.map((c) => ({
          line: c.line,
          heading: c.heading,
          excerpt: c.excerpt,
          vec: Buffer.from(
            c.vec.buffer,
            c.vec.byteOffset,
            c.vec.byteLength,
          ).toString("base64"),
        })),
      };
    }

    const tmp = `${this.file}.tmp`;
    await fs.promises.writeFile(
      tmp,
      JSON.stringify({
        version: 1,
        vault: this.vault.id,
        model: this.cfg.model,
        notes,
      }),
    );
    await fs.promises.rename(tmp, this.file);
    this.dirty = false;
    this.lastSave = Date.now();
  }

  // Starts a sync unless one is running. A request during a run (e.g. right after write_note)
  // queues one more pass, since the running one may have scanned the folder already.
  sync() {
    if (this.running) {
      this.again = true;
      return this.running;
    }

    this.running = (async () => {
      do {
        this.again = false;

        try {
          await this._sync();
        } catch (e) {
          // Only expected errors reach the model; others (file system) can name server paths.
          this.lastError =
            e instanceof ToolError
              ? e.message
              : "indexing failed; details are in the Ignis log.";
          this.log(`Semantic index for ${this.vault.id} failed: ${e.message}`);
          break;
        }
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });

    return this.running;
  }

  async _sync() {
    await this.load();

    const seen = new Set();
    const changed = [];
    const unreadable = [];

    for await (const file of walk(
      this.vault.root,
      this.vault.root,
      unreadable,
    )) {
      if (path.extname(file.rel).toLowerCase() !== ".md") {
        continue;
      }

      // Notes renamed or deleted mid-scan (Obsidian, sync) are simply gone, not a reason to abort the sync.
      const stat = await statIfExists(file.abs);

      if (!stat || stat.size > MAX_SEARCH_FILE_BYTES) {
        continue;
      }

      seen.add(file.rel);
      const known = this.notes.get(file.rel);

      if (
        !known ||
        known.mtimeMs !== stat.mtimeMs ||
        known.size !== stat.size
      ) {
        changed.push({ ...file, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }

    // A vault folder that can't be read right now (share offline, permissions) must not wipe the index: a full
    // rebuild re-embeds every note.
    if (unreadable.includes("")) {
      throw new Error(`vault folder unreadable: ${this.vault.root}`);
    }

    const inUnreadable = (rel) =>
      unreadable.some((dir) => rel.startsWith(`${dir}/`));

    for (const rel of this.notes.keys()) {
      if (!seen.has(rel) && !inUnreadable(rel)) {
        this.notes.delete(rel);
        this.dirty = true;
      }
    }

    this.total = seen.size;
    this.pending = changed.length;

    if (changed.length) {
      this.log(
        `Semantic index for ${this.vault.id}: embedding ${changed.length} changed note(s)`,
      );
    }

    for (const file of changed) {
      const text = await fs.promises
        .readFile(file.abs, "utf-8")
        .catch(() => null);

      if (text !== null) {
        const chunks = chunkNote(file.rel, text);

        for (let i = 0; i < chunks.length; i += BATCH) {
          const batch = chunks.slice(i, i + BATCH);
          const vecs = await embed(
            this.cfg,
            batch.map((c) => c.input),
            this.log,
          );
          batch.forEach((c, j) => {
            c.vec = vecs[j];
            delete c.input;
          });
        }

        this.notes.set(file.rel, {
          mtimeMs: file.mtimeMs,
          size: file.size,
          chunks,
        });
        this.dirty = true;
      }

      this.pending--;
      await this.save();
    }

    this.lastError = null;
    await this.save(true);
  }

  search(qvec, { prefix, limit }) {
    const results = [];

    for (const [rel, n] of this.notes) {
      if (prefix && rel !== prefix && !rel.startsWith(`${prefix}/`)) {
        continue;
      }

      // Vectors from another model version (other length) would score NaN; dropStale() re-embeds those notes.
      const scored = n.chunks
        .filter((c) => c.vec.length === qvec.length)
        .map((c) => {
          let s = 0;

          for (let i = 0; i < qvec.length; i++) {
            s += qvec[i] * c.vec[i];
          }

          return { c, s };
        })
        .sort((a, b) => b.s - a.s);

      if (scored.length === 0) {
        continue;
      }

      results.push({
        path: rel,
        score: Math.round(scored[0].s * 1000) / 1000,
        passages: scored.slice(0, PASSAGES_PER_NOTE).map(({ c, s }) => ({
          line: c.line,
          heading: c.heading,
          text: c.excerpt,
          score: Math.round(s * 1000) / 1000,
        })),
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  // The model behind the same name changed its vector size (e.g. a new tag was pulled): forget the old vectors so
  // the next sync embeds those notes again. Returns whether anything was dropped.
  dropStale(dims) {
    let dropped = false;

    for (const [rel, n] of this.notes) {
      if (n.chunks.some((c) => c.vec.length !== dims)) {
        this.notes.delete(rel);
        dropped = true;
      }
    }

    if (dropped) {
      this.dirty = true;
      this.log(
        `Semantic index for ${this.vault.id}: vector size changed, re-embedding affected notes`,
      );
    }

    return dropped;
  }
}

const indexes = new Map();
const timers = new Map();

function getIndex(ctx, vault) {
  const cfg = embedConfig();
  const key = `${vault.id}\0${vault.root}\0${cfg.model}`;

  if (!indexes.has(key)) {
    indexes.set(
      key,
      new VaultIndex(vault, cfg, ctx.dataDir, ctx.log, () =>
        ctx.getEnabledVaults(),
      ),
    );
  }

  return indexes.get(key);
}

// Indexes a vault in the background when it is enabled, then keeps it fresh every few minutes.
function startVault(ctx, vault) {
  if (!embedConfig()) {
    return;
  }

  stopVault(vault.id);
  const index = getIndex(ctx, vault);
  index.sync();
  const timer = setInterval(() => index.sync(), RESYNC_MS);
  timer.unref();
  timers.set(vault.id, timer);
}

function stopVault(vaultId) {
  clearInterval(timers.get(vaultId));
  timers.delete(vaultId);
}

function stopAll() {
  for (const id of [...timers.keys()]) {
    stopVault(id);
  }
}

function noteChanged(ctx, vault) {
  if (embedConfig()) {
    getIndex(ctx, vault).sync();
  }
}

async function semanticSearch(ctx, vault, { query, folder, limit }) {
  const cfg = embedConfig();
  const prefix = folder ? resolveReadable(vault, folder).rel : "";
  const index = getIndex(ctx, vault);

  // Waits a little for changed notes, so a note written a moment ago can already be found.
  const syncing = index.sync();
  const finished = await Promise.race([
    syncing.then(() => true),
    new Promise((r) => setTimeout(() => r(false), QUERY_WAIT_MS).unref()),
  ]);

  if (index.notes.size === 0 && index.lastError) {
    throw new ToolError(`Semantic index unavailable: ${index.lastError}`);
  }

  const [qvec] = await embed(cfg, [query], ctx.log);

  if (index.dropStale(qvec.length)) {
    index.sync();
  }

  const result = { results: index.search(qvec, { prefix, limit }) };

  if (!finished) {
    result.indexing = { pending: index.pending, total: index.total };
    result.hint =
      "The index is still being built, so some notes are missing. Use search_notes as well, or try again later.";
  } else if (result.results.length === 0) {
    result.hint = "No notes indexed in this folder.";
  }

  return result;
}

module.exports = {
  VaultIndex,
  indexFile,
  embedConfig,
  chunkNote,
  startVault,
  stopVault,
  stopAll,
  noteChanged,
  semanticSearch,
};
