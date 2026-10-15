# ignis-mcp

[Ignis](https://github.com/Nystik-gh/ignis) (Obsidian as a self-hosted web app) with an extra **server plugin** that exposes your vaults to AI clients over [MCP](https://modelcontextprotocol.io).

The image is upstream `nobbe/ignis:latest` with the plugin copied in. Nothing in upstream's code is changed. A GitHub Action checks every 6 hours and rebuilds `ghcr.io/drakknar/ignis` when upstream or the plugin changes. Before publishing, it smoke-tests every MCP tool against a throwaway vault. If a new upstream release breaks the plugin, nothing is published and the last working image stays in place.

## Install on unRAID

1. Docker tab → the Ignis container → **Edit**.
2. Change **Repository** from `nobbe/ignis:latest` to `ghcr.io/drakknar/ignis:latest`. Leave every path and variable as it is.
3. **Apply**.
4. In Ignis, open Settings → **Ignis → Core plugins** and enable **MCP Server** for each vault you want to expose. Vaults you don't enable can't be reached.
5. Optional but recommended: add the variable `MCP_TOKEN` (see [Authentication](#authentication)).

## Connect a client

The endpoint is `http://<unraid-ip>:<ignis-port>/api/ext/mcp` (Streamable HTTP, stateless).

Claude Code:

```sh
claude mcp add --transport http ignis http://<unraid-ip>:<ignis-port>/api/ext/mcp \
  --header "Authorization: Bearer <token>"
```

Other clients: add a remote/HTTP MCP server with the same URL and the header `Authorization: Bearer <token>`.

### Authentication

Set `MCP_TOKEN` on the container to require `Authorization: Bearer <MCP_TOKEN>` on every MCP request; anything else gets `401`. Generate a long random value, e.g. `openssl rand -hex 32`. Without a token the endpoint is open, as before, and the log says so at startup.

Two tokens give two levels of access to the same tools:

| Token | Writes |
|---|---|
| `MCP_TOKEN` (agents) | Only inside `MCP_WRITE_PATHS` (anywhere when that is unset) |
| `MCP_ADMIN_TOKEN` (you) | Anywhere in every enabled vault, including vaults enabled later |

Both read every enabled vault, and hidden paths stay off limits for both. Give AI models the agent token and keep the admin token for clients that act for you, e.g. a separate MCP connection you switch on only when you want a model to edit your notes. Setting only `MCP_ADMIN_TOKEN` also turns authentication on.

The token only protects the MCP endpoint. Ignis's own web UI has no login, so keep the port on the LAN or behind an authenticating reverse proxy.

## Tools

| Tool | What it does |
|---|---|
| `list_vaults` | Vaults enabled for MCP |
| `list_notes` | Files in a vault or folder (recursive), with size and modified time |
| `read_note` | A note's text (up to 1 MB) |
| `search_notes` | Case-insensitive text or regex search over file names and contents (`.md` by default). Returns path, line number and line |
| `semantic_search` | Search by meaning instead of exact words, across languages. Returns notes best first, with their most relevant passages and a 0-1 score. Only offered when semantic search is on (see below) |
| `write_note` | `create` (default, fails if the note exists), `overwrite`, `append`, or `prepend` (after the YAML frontmatter). Adds `.md` when the path has no extension and creates missing folders |

The `vault` argument is optional when only one vault is enabled or `MCP_DEFAULT_VAULT` is set. Hidden folders (`.obsidian`, `.trash`, `.git`) are skipped when listing and searching, and writes to them are refused. Paths can't leave the vault, not even through symlinks. Ignis watches the vault folder, so open Obsidian tabs show changes straight away.

### Several vaults

| Variable | Default | Meaning |
|---|---|---|
| `MCP_DEFAULT_VAULT` | (none) | Vault used when a call names none and more than one vault is enabled |
| `MCP_WRITE_PATHS` | (anywhere) | Comma-separated `Vault` or `Vault/folder` entries; with the agent token (or no token), `write_note` refuses everything else. The admin token ignores it. E.g. `Agents/Inbox, Agents/Facts` keeps every other vault and folder read-only |

`list_vaults` returns both, so a model can see where it may write.

## Semantic search

`semantic_search` finds notes by meaning: "when was the heating last checked?" finds a note titled "Boiler service", and an Italian question finds a German note. It needs an embedding model on an [Ollama](https://ollama.com) server and is off until you set `MCP_EMBED_URL`.

Add these variables to the Ignis container:

| Variable | Default | Meaning |
|---|---|---|
| `MCP_EMBED_URL` | (off) | Ollama server, e.g. `http://192.168.1.4:11434` |
| `MCP_EMBED_MODEL` | `bge-m3` | Embedding model; pull it first (`ollama pull bge-m3`). `bge-m3` is multilingual |
| `MCP_EMBED_KEEP_ALIVE` | `1h` | How long Ollama keeps the model loaded after a request |
| `MCP_EMBED_GPU` | `false` | `true` lets Ollama put the model on the GPU. By default it runs on the CPU (`num_gpu: 0`), so it never pushes a chat model out of VRAM |

If your main Ollama sets `OLLAMA_MAX_LOADED_MODELS=1`, loading the embedding model still unloads the chat model, even on the CPU. Run a second, CPU-only Ollama container (no `--gpus`) for embeddings; it can share the main one's models folder.

How it works: each note is split into passages at its headings (long sections at paragraph breaks; YAML frontmatter is skipped), and each passage is embedded together with the note title and heading. The index lives in the plugin's data folder (`<data>/plugins/mcp/semantic-<vault>-<model>.json`). It is built in the background when a vault is enabled, refreshed every 15 minutes, after every `write_note`, and before each search (only notes whose size or modified time changed are embedded again), so edits made in Obsidian are picked up too. While the first index is still building, results say so and may be incomplete. Changing `MCP_EMBED_MODEL` starts a new index.

## Layout

- `plugin/`: the Ignis server plugin; `semantic.js` holds the embedding index behind `semantic_search`. Ignis loads any `server/plugins/<id>/index.js` that exports `{ id, name, register(ctx) }`. `register` gets an Express router mounted at `/api/ext/<id>`, the server config (`getVaultPath`), and `getEnabledVaults()`.
- `Dockerfile`: installs the plugin's dependencies in a separate stage and copies the plugin into the upstream image. The build fails if upstream moves its plugins folder.
- `scripts/smoke-test.sh <image>`: runs the image, enables the plugin through `POST /api/plugins/mcp/enable` (the call the Ignis UI makes), and checks each tool. `semantic_search` is tested against `scripts/fake-embed.js`, a stand-in for Ollama's embedding API, so no model is downloaded.
- `.github/workflows/build.yml`: the 6-hourly check, smoke test and publish.
  If a scheduled build fails on a new upstream image, Claude (`anthropics/claude-code-action`, secret `CLAUDE_CODE_OAUTH_TOKEN`, instructions in `.github/prompts/upstream-fix.md`) diagnoses it and proposes a fix as a pull request, or opens an issue. The workflow then runs `build.yml` on the fix's branch, without publishing, and posts the result on the pull request; a failed check turns it into a draft. While an `upstream-fix` pull request or issue is open, new failures wait. `.github/scripts/watch.sh` records on the `watch-state` branch what has been handled.
  Only the `publish` job, which runs on `main` only, can push to the registry; building and testing run read-only. Claude's commands run without the Claude token, sudo or a view of other processes, but with Docker, which the fix needs. The report job won't publish output that contains the token.

To test locally: `docker build -t ignis-test . && bash scripts/smoke-test.sh ignis-test`

## License

AGPL-3.0-or-later, same as Ignis.
