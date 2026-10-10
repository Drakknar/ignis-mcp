#!/usr/bin/env bash
# Starts the built image with a throwaway vault, enables the MCP plugin through
# the same API the Ignis UI uses, and checks every tool over real MCP requests.
# Usage: scripts/smoke-test.sh <image>
set -euo pipefail

image=${1:?usage: smoke-test.sh <image>}
port=18080
base=http://localhost:$port
work=$(mktemp -d)
vault=$work/vaults/Test

mkdir -p "$vault/.obsidian" "$vault/Projects"
printf -- '---\ntags: [demo]\n---\n# Welcome\nThe needle is here.\n' > "$vault/Welcome.md"
printf 'Nothing to see.\n' > "$vault/Projects/Plan.md"
printf '{"needle": "hidden config must not be searched"}\n' > "$vault/.obsidian/app.json"

docker run -d --name ignis-smoke -p $port:8080 \
  -e PUID="$(id -u)" -e PGID="$(id -g)" \
  -v "$work/vaults:/vaults" "$image" >/dev/null

cleanup() { docker rm -f ignis-smoke >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'echo "--- container log"; docker logs ignis-smoke 2>&1 | tail -n 60' ERR

# First start downloads Obsidian, so allow a few minutes.
echo "Waiting for Ignis to discover the plugin"
for _ in $(seq 120); do
  curl -fsS "$base/api/plugins" 2>/dev/null | jq -e 'any(.[]; .id == "mcp")' >/dev/null && break
  sleep 3
done
curl -fsS "$base/api/plugins" | jq -e 'any(.[]; .id == "mcp")' >/dev/null

echo "Enabling the plugin for the test vault"
curl -fsS -X POST "$base/api/plugins/mcp/enable" \
  -H 'Content-Type: application/json' -d '{"vault":"Test"}' | jq -e '.ok' >/dev/null

rpc() {
  curl -fsS -X POST "$base/api/ext/mcp" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "$1"
}

# call <tool> <arguments-json> -> prints the tool result object
call() {
  rpc "$(jq -nc --arg n "$1" --argjson a "$2" \
    '{jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: $n, arguments: $a}}')" | jq '.result'
}

echo "initialize"
rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
  | jq -e '.result.serverInfo.name == "ignis-vaults"' >/dev/null

echo "tools/list has all tools"
rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | jq -e '[.result.tools[].name] | sort == ["list_notes","list_vaults","read_note","search_notes","write_note"]' >/dev/null

echo "list_vaults"
call list_vaults '{}' | jq -e '.structuredContent.vaults == ["Test"]' >/dev/null

echo "list_notes skips hidden folders"
call list_notes '{}' | jq -e '[.structuredContent.notes[].path] == ["Projects/Plan.md","Welcome.md"]' >/dev/null

echo "read_note"
call read_note '{"path":"Welcome.md"}' | jq -e '.structuredContent.content | contains("needle")' >/dev/null

echo "search_notes finds content but not .obsidian"
call search_notes '{"query":"NEEDLE"}' \
  | jq -e '.structuredContent.results == [{"path":"Welcome.md","line":5,"text":"The needle is here."}]' >/dev/null

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

echo "All smoke tests passed"
