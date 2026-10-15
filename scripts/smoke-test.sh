#!/usr/bin/env bash
# Starts the built image with a throwaway vault, enables the MCP plugin through
# the same API the Ignis UI uses, and checks every tool over real MCP requests.
# Usage: scripts/smoke-test.sh <image>
set -euo pipefail

image=${1:?usage: smoke-test.sh <image>}
port=18080
embed_port=18434
token=smoke-test-token
base=http://localhost:$port
work=$(mktemp -d)
vault=$work/vaults/Test

mkdir -p "$vault/.obsidian" "$vault/Projects"
printf -- '---\ntags: [demo]\n---\n# Welcome\nThe needle is here.\n' > "$vault/Welcome.md"
printf 'Nothing to see.\n' > "$vault/Projects/Plan.md"
printf '{"needle": "hidden config must not be searched"}\n' > "$vault/.obsidian/app.json"
printf '# Heating\nThe yearly boiler inspection was on 3 March.\n' > "$vault/Projects/House.md"

# A second vault where only Inbox/ is writable (MCP_WRITE_PATHS below).
other=$work/vaults/Other
mkdir -p "$other/.obsidian" "$other/Inbox"
printf 'Read me, but do not change me.\n' > "$other/Root.md"

# Stand-in for Ollama's embedding API, reached from the container through the host gateway.
node "$(dirname "$0")/fake-embed.js" $embed_port &
embed_pid=$!

docker run -d --name ignis-smoke -p $port:8080 \
  --add-host=host.docker.internal:host-gateway \
  -e MCP_EMBED_URL=http://host.docker.internal:$embed_port -e MCP_EMBED_MODEL=fake-embed \
  -e MCP_TOKEN=$token -e MCP_DEFAULT_VAULT=Test -e MCP_WRITE_PATHS="Test, Other/Inbox" \
  -e PUID="$(id -u)" -e PGID="$(id -g)" \
  -v "$work/vaults:/vaults" "$image" >/dev/null

cleanup() { docker rm -f ignis-smoke >/dev/null 2>&1 || true; kill $embed_pid 2>/dev/null || true; }
trap cleanup EXIT
trap 'echo "--- container log"; docker logs ignis-smoke 2>&1 | tail -n 60' ERR

# First start downloads Obsidian, so allow a few minutes.
echo "Waiting for Ignis to discover the plugin"
for _ in $(seq 120); do
  curl -fsS "$base/api/plugins" 2>/dev/null | jq -e 'any(.[]; .id == "mcp")' >/dev/null && break
  sleep 3
done
curl -fsS "$base/api/plugins" | jq -e 'any(.[]; .id == "mcp")' >/dev/null

echo "Enabling the plugin for the test vaults"
for v in Test Other; do
  curl -fsS -X POST "$base/api/plugins/mcp/enable" \
    -H 'Content-Type: application/json' -d "{\"vault\":\"$v\"}" | jq -e '.ok' >/dev/null
done

rpc() {
  curl -fsS -X POST "$base/api/ext/mcp" \
    -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "$1"
}

# status [curl args...] -> prints the HTTP status of a tools/list request sent with only those headers
status() {
  curl -sS -o /dev/null -w '%{http_code}' -X POST "$base/api/ext/mcp" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$@"
}

# call <tool> <arguments-json> -> prints the tool result object
call() {
  rpc "$(jq -nc --arg n "$1" --argjson a "$2" \
    '{jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: $n, arguments: $a}}')" | jq '.result'
}

echo "requests without the right bearer token are refused"
[ "$(status)" = 401 ]
[ "$(status -H 'Authorization: Bearer wrong')" = 401 ]
[ "$(status -H "Authorization: Basic $token")" = 401 ]
[ "$(curl -sS -o /dev/null -w '%{http_code}' "$base/api/ext/mcp")" = 401 ]
[ "$(status -H "Authorization: bearer $token")" = 200 ]

echo "initialize"
rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
  | jq -e '.result.serverInfo.name == "ignis-vaults"' >/dev/null

echo "tools/list has all tools"
rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | jq -e '[.result.tools[].name] | sort == ["list_notes","list_vaults","read_note","search_notes","semantic_search","write_note"]' >/dev/null

echo "list_vaults"
call list_vaults '{}'   | jq -e '.structuredContent | (.vaults | sort) == ["Other","Test"] and .defaultVault == "Test" and .writable == ["Test","Other/Inbox"]' >/dev/null

echo "list_notes skips hidden folders"
call list_notes '{}' | jq -e '[.structuredContent.notes[].path] == ["Projects/House.md","Projects/Plan.md","Welcome.md"]' >/dev/null

echo "read_note"
call read_note '{"path":"Welcome.md"}' | jq -e '.structuredContent.content | contains("needle")' >/dev/null

echo "search_notes finds content but not .obsidian"
call search_notes '{"query":"NEEDLE"}' \
  | jq -e '.structuredContent.results == [{"path":"Welcome.md","matchedTerms":["needle"],"matchingLines":1,"lines":[{"line":5,"text":"The needle is here."}]}]' >/dev/null

echo "search_notes matches all words across lines and the file name, in any order"
call search_notes '{"query":"here is the needle, welcome?"}' \
  | jq -e '.structuredContent | .matched == "all" and ([.results[].path] == ["Welcome.md"]) and (.results[0].lines[0].line == 0)' >/dev/null

echo "search_notes falls back to the best partial matches"
call search_notes '{"query":"needle nothing zzzz"}' \
  | jq -e '.structuredContent | .matched == "any" and ([.results[].path] | sort == ["Projects/Plan.md","Welcome.md"])' >/dev/null

echo "search_notes keeps quoted phrases whole"
call search_notes '{"query":"\"needle is here\""}' | jq -e '[.structuredContent.results[].path] == ["Welcome.md"]' >/dev/null
call search_notes '{"query":"\"here is needle\""}' | jq -e '.structuredContent.results == [] and (.structuredContent.hint | length > 0)' >/dev/null

echo "search_notes regex"
call search_notes '{"query":"^Nothing to","regex":true}' | jq -e '[.structuredContent.results[].path] == ["Projects/Plan.md"]' >/dev/null

echo "semantic_search matches by meaning, best passage first"
call semantic_search '{"query":"when was the heater serviced?"}' \
  | jq -e '.structuredContent.results[0] | .path == "Projects/House.md" and .passages[0].heading == "Heating" and .passages[0].line == 2' >/dev/null

echo "semantic_search finds a note right after write_note"
call write_note '{"path":"Inbox/Garden","content":"Plant tomatoes and basil in May.\n"}' | jq -e '.isError != true' >/dev/null
call semantic_search '{"query":"tomatoes basil"}' | jq -e '.structuredContent.results[0].path == "Inbox/Garden.md"' >/dev/null

echo "semantic_search index is saved in the plugin data folder"
# find exits non-zero on unreadable folders, which pipefail would treat as a failure.
docker exec ignis-smoke sh -c 'find / -name semantic-Test-fake-embed.json -not -path "/proc/*" 2>/dev/null || true' | grep -q .

echo "write_note create, then read back from disk"
call write_note '{"path":"Inbox/New idea","content":"hello from MCP\n"}' \
  | jq -e '.structuredContent == {"path":"Inbox/New idea.md","created":true,"bytes":15}' >/dev/null
grep -qx 'hello from MCP' "$vault/Inbox/New idea.md"

echo "write_note create refuses to overwrite"
call write_note '{"path":"Welcome.md","content":"x"}' | jq -e '.isError == true' >/dev/null

echo "write_note prepend keeps frontmatter first"
call write_note '{"path":"Welcome.md","content":"Added line","mode":"prepend"}' | jq -e '.isError != true' >/dev/null
head -n 4 "$vault/Welcome.md" | tail -n 1 | grep -qx 'Added line'

echo "path traversal is refused"
call read_note '{"path":"../../etc/passwd"}' | jq -e '.isError == true' >/dev/null

echo "writes to .obsidian are refused"
call write_note '{"path":".obsidian/evil.json","content":"{}","mode":"overwrite"}' | jq -e '.isError == true' >/dev/null

echo "unknown vault is refused"
call list_notes '{"vault":"Nope"}' | jq -e '.isError == true' >/dev/null

echo "calls without a vault use the default vault"
call read_note '{"path":"Root.md"}' | jq -e '.isError == true' >/dev/null
call read_note '{"vault":"Other","path":"Root.md"}' | jq -e '.structuredContent.content | contains("Read me")' >/dev/null

echo "write_note only writes inside MCP_WRITE_PATHS"
call write_note '{"vault":"Other","path":"Inbox/Fact","content":"ok\n"}' | jq -e '.isError != true' >/dev/null
grep -qx 'ok' "$other/Inbox/Fact.md"
call write_note '{"vault":"Other","path":"Root.md","content":"x","mode":"overwrite"}' | jq -e '.isError == true' >/dev/null
call write_note '{"vault":"Other","path":"Inboxes/Fact","content":"x"}' | jq -e '.isError == true' >/dev/null
call write_note '{"vault":"Other","path":"Inbox/../Sneaky","content":"x"}' | jq -e '.isError == true' >/dev/null
grep -qx 'Read me, but do not change me.' "$other/Root.md"
[ ! -e "$other/Inboxes" ] && [ ! -e "$other/Sneaky.md" ]

echo "All smoke tests passed"
