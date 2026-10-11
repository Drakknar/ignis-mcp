# ignis-mcp

[Ignis](https://github.com/Nystik-gh/ignis) (Obsidian as a self-hosted web app) with an extra **server plugin** that exposes your vaults to AI clients over [MCP](https://modelcontextprotocol.io).

The image is upstream `nobbe/ignis:latest` with the plugin copied in. Nothing in upstream's code is changed. A GitHub Action checks every 6 hours and rebuilds `ghcr.io/drakknar/ignis` when upstream or the plugin changes. Before publishing, it smoke-tests every MCP tool against a throwaway vault. If a new upstream release breaks the plugin, nothing is published and the last working image stays in place.

## Install on unRAID

1. Docker tab → the Ignis container → **Edit**.
2. Change **Repository** from `nobbe/ignis:latest` to `ghcr.io/drakknar/ignis:latest`. Leave every path and variable as it is.
3. **Apply**.
4. In Ignis, open Settings → **Ignis → Core plugins** and enable **MCP Server** for each vault you want to expose. Vaults you don't enable can't be reached.

## Connect a client

The endpoint is `http://<unraid-ip>:<ignis-port>/api/ext/mcp` (Streamable HTTP, stateless).

Claude Code:

```sh
claude mcp add --transport http ignis http://<unraid-ip>:<ignis-port>/api/ext/mcp
```

Other clients: add a remote/HTTP MCP server with the same URL.

**No authentication.** Anyone who can reach Ignis can read and write the enabled vaults. Ignis itself has no login either, so this adds no new exposure, but keep it on the LAN.

## Tools

| Tool | What it does |
|---|---|
| `list_vaults` | Vaults enabled for MCP |
| `list_notes` | Files in a vault or folder (recursive), with size and modified time |
| `read_note` | A note's text (up to 1 MB) |
| `search_notes` | Case-insensitive text or regex search over file names and contents (`.md` by default). Returns path, line number and line |
| `write_note` | `create` (default, fails if the note exists), `overwrite`, `append`, or `prepend` (after the YAML frontmatter). Adds `.md` when the path has no extension and creates missing folders |

The `vault` argument is optional when only one vault is enabled. Hidden folders (`.obsidian`, `.trash`, `.git`) are skipped when listing and searching, and writes to them are refused. Paths can't leave the vault, not even through symlinks. Ignis watches the vault folder, so open Obsidian tabs show changes straight away.

## Layout

- `plugin/`: the Ignis server plugin. Ignis loads any `server/plugins/<id>/index.js` that exports `{ id, name, register(ctx) }`. `register` gets an Express router mounted at `/api/ext/<id>`, the server config (`getVaultPath`), and `getEnabledVaults()`.
- `Dockerfile`: installs the plugin's dependencies in a separate stage and copies the plugin into the upstream image. The build fails if upstream moves its plugins folder.
- `scripts/smoke-test.sh <image>`: runs the image, enables the plugin through `POST /api/plugins/mcp/enable` (the call the Ignis UI makes), and checks each tool.
- `.github/workflows/build.yml`: the 6-hourly check, smoke test and publish.
  If a scheduled build fails on a new upstream image, Claude (`anthropics/claude-code-action`, secret `CLAUDE_CODE_OAUTH_TOKEN`, instructions in `.github/prompts/upstream-fix.md`) diagnoses it and proposes a fix as a pull request, or opens an issue. The workflow then runs `build.yml` on the fix's branch, without publishing, and posts the result on the pull request; a failed check turns it into a draft. While an `upstream-fix` pull request or issue is open, new failures wait. `.github/scripts/watch.sh` records on the `watch-state` branch what has been handled.
  Only the `publish` job, which runs on `main` only, can push to the registry; building and testing run read-only. Claude's commands run without the Claude token, sudo or a view of other processes, but with Docker, which the fix needs. The report job won't publish output that contains the token.

To test locally: `docker build -t ignis-test . && bash scripts/smoke-test.sh ignis-test`

## License

AGPL-3.0-or-later, same as Ignis.
