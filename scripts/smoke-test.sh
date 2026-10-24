#!/usr/bin/env bash
# Starts the built image with a throwaway vault, enables the MCP plugin through
# the same API the Ignis UI uses, and checks every tool over real MCP requests.
# Usage: scripts/smoke-test.sh <image>
set -euo pipefail

image=${1:?usage: smoke-test.sh <image>}

echo "plugin unit tests"
node --test "$(dirname "$0")/unit-test.js"

port=18080
embed_port=18434
token=smoke-test-token
admin_token=smoke-admin-token
read_token=smoke-read-token
base=http://localhost:$port
work=$(mktemp -d)
vault=$work/vaults/Test

mkdir -p "$vault/.obsidian" "$vault/Projects"
printf -- '---\ntags: [demo]\n---\n# Welcome\nThe needle is here.\n' > "$vault/Welcome.md"
printf 'Nothing to see.\n' > "$vault/Projects/Plan.md"
printf '{"needle": "hidden config must not be searched"}\n' > "$vault/.obsidian/app.json"
printf '# Heating\nThe yearly boiler inspection was on 3 March.\n' > "$vault/Projects/House.md"
# A link that leads a visible path into hidden config.
ln -s ../.obsidian/app.json "$vault/Projects/Config.md"

# A second vault where only Inbox/ and Facts/ are writable (MCP_WRITE_PATHS below, as a {...} group).
other=$work/vaults/Other
mkdir -p "$other/.obsidian" "$other/Inbox"
printf 'Read me, but do not change me.\n' > "$other/Root.md"
# Symlinks in the writable folder that lead elsewhere: to a read-only note, to a read-only folder, and nowhere (outside).
ln -s ../Root.md "$other/Inbox/Link to root.md"
mkdir -p "$other/Notes" && printf 'Not writable.\n' > "$other/Notes/Kept.md"
ln -s ../Notes "$other/Inbox/notes"
ln -s /tmp/ignis-smoke-escape.md "$other/Inbox/Dangling.md"

# Stand-in for Ollama's embedding API, reached from the container through the host gateway.
node "$(dirname "$0")/fake-embed.js" $embed_port &
embed_pid=$!

docker run -d --name ignis-smoke -p $port:8080 \
  --add-host=host.docker.internal:host-gateway \
  -e MCP_EMBED_URL=http://host.docker.internal:$embed_port -e MCP_EMBED_MODEL=fake-embed \
  -e MCP_TOKEN=$token -e MCP_ADMIN_TOKEN=$admin_token -e MCP_READ_TOKEN=$read_token -e MCP_DEFAULT_VAULT=Test -e MCP_WRITE_PATHS="Test, Other/{Inbox,Facts}" \
  -e MCP_MEMORY_VAULT=Other \
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
    -H "Authorization: Bearer ${auth:-$token}" \
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
  | jq -e '[.result.tools[].name] | sort == ["edit_note","forget","list_notes","list_vaults","read_note","remember","search_notes","semantic_search","write_note"]' >/dev/null

echo "list_vaults"
call list_vaults '{}'   | jq -e '.structuredContent | (.vaults | sort) == ["Other","Test"] and .defaultVault == "Test" and .writable == ["Test","Other/Inbox","Other/Facts"]' >/dev/null

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

echo "search_notes stops a catastrophically backtracking regex, and the server keeps answering"
printf '%s!\n' "$(printf 'a%.0s' $(seq 40))" > "$vault/Projects/Backtrack.md"
call search_notes '{"query":"(a+)+$","regex":true}' | jq -e '.isError == true' >/dev/null
call read_note '{"path":"Welcome.md"}' | jq -e '.structuredContent.content | contains("needle")' >/dev/null
rm "$vault/Projects/Backtrack.md"

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

echo "hidden paths can't be read, listed or searched, not even through a symlink"
call read_note '{"path":".obsidian/app.json"}' | jq -e '.isError == true' >/dev/null
call read_note '{"path":"Projects/Config.md"}' | jq -e '.isError == true' >/dev/null
call list_notes '{"folder":".obsidian"}' | jq -e '.isError == true' >/dev/null
call search_notes '{"query":"needle","folder":".obsidian","extensions":["json"]}' | jq -e '.isError == true' >/dev/null
call semantic_search '{"query":"needle","folder":".obsidian"}' | jq -e '.isError == true' >/dev/null

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

echo "every folder of a {...} group in MCP_WRITE_PATHS is writable, and only those"
call write_note '{"vault":"Other","path":"Facts/Brace","content":"ok\n"}' | jq -e '.isError != true' >/dev/null
grep -qx 'ok' "$other/Facts/Brace.md"
call write_note '{"vault":"Other","path":"Facts}/X","content":"x"}' | jq -e '.isError == true' >/dev/null
call write_note '{"vault":"Other","path":"{Inbox/X","content":"x"}' | jq -e '.isError == true' >/dev/null

echo "remember saves to the memory vault's inbox with frontmatter"
mem='Inbox/Prefers green tea.md'
call remember '{"text":"The user prefers green tea to coffee.","title":"Prefers green tea","type":"preference","source":"smoke"}' \
  | jq -e --arg p "$mem" '.structuredContent | .path == $p and .vault == "Other" and .created == true' >/dev/null
head -n 6 "$other/$mem" | grep -qx 'type: preference'
head -n 6 "$other/$mem" | grep -qx 'status: inbox'
head -n 6 "$other/$mem" | grep -qx 'source: "smoke"'

echo "remember with the same title adds an update instead of a duplicate"
call remember '{"text":"Also likes oolong.","title":"Prefers green tea","type":"preference"}' \
  | jq -e '.structuredContent.updated == true' >/dev/null
grep -q '^## Update ' "$other/$mem"
[ "$(ls "$other/Inbox" | grep -c 'green tea')" = 1 ]

echo "remember dates episodes and keeps titles inside the inbox"
call remember '{"text":"Boiler serviced.","title":"Boiler service","type":"episode"}' \
  | jq -e '.structuredContent.path | test("^Inbox/[0-9]{4}-[0-9]{2}-[0-9]{2} Boiler service[.]md$")' >/dev/null
call remember '{"text":"x","title":"../../Escape"}' | jq -e '.structuredContent.path == "Inbox/Escape.md"' >/dev/null
call remember '{"text":"x","title":"..\\..\\Facts\\Escape2"}' | jq -e '.structuredContent.path == "Inbox/Facts Escape2.md"' >/dev/null
[ ! -e "$other/Facts/Escape2.md" ]

echo "edit_note replaces exactly one passage"
call edit_note '{"vault":"Other","path":"Inbox/Prefers green tea.md","old_text":"to coffee.","new_text":"to coffee or mate."}' | jq -e '.isError != true' >/dev/null
grep -qx 'The user prefers green tea to coffee or mate.' "$other/$mem"
call edit_note '{"vault":"Other","path":"Inbox/Prefers green tea.md","old_text":"green tea","new_text":"x"}' | jq -e '.isError == true' >/dev/null
call edit_note '{"vault":"Other","path":"Inbox/Prefers green tea.md","old_text":"not there","new_text":"x"}' | jq -e '.isError == true' >/dev/null
call edit_note '{"vault":"Other","path":"Root.md","old_text":"Read me","new_text":"x"}' | jq -e '.isError == true' >/dev/null
grep -qx 'Read me, but do not change me.' "$other/Root.md"

echo "forget marks a memory outdated and keeps it"
call forget '{"path":"Inbox/Prefers green tea.md","reason":"Now drinks coffee"}' | jq -e '.structuredContent.status == "outdated"' >/dev/null
grep -qx 'status: outdated' "$other/$mem"
grep -qx 'outdated_reason: "Now drinks coffee"' "$other/$mem"
[ "$(grep -cx 'status: inbox' "$other/$mem" || true)" = 0 ]
grep -qx 'The user prefers green tea to coffee or mate.' "$other/$mem"
call forget '{"path":"Root.md","reason":"x"}' | jq -e '.isError == true' >/dev/null

echo "remember on a forgotten memory makes it current again"
call remember '{"text":"Back to green tea.","title":"Prefers green tea","type":"preference"}' | jq -e '.structuredContent.updated == true' >/dev/null
grep -qx 'status: inbox' "$other/$mem"
[ "$(grep -c '^outdated_' "$other/$mem" || true)" = 0 ]
[ "$(grep -c '^---$' "$other/$mem")" = 2 ]
grep -qx 'Back to green tea.' "$other/$mem"

echo "forget accepts a path without .md"
call forget '{"path":"Inbox/Prefers green tea","reason":"Test"}' | jq -e '.structuredContent.status == "outdated"' >/dev/null

echo "the admin token may write anywhere, except hidden paths"
auth=$admin_token call list_vaults '{}' | jq -e '.structuredContent.writable == null' >/dev/null
auth=$admin_token call write_note '{"vault":"Other","path":"Root.md","content":"changed by admin\n","mode":"overwrite"}' | jq -e '.isError != true' >/dev/null
grep -qx 'changed by admin' "$other/Root.md"
auth=$admin_token call write_note '{"vault":"Other","path":".obsidian/evil.json","content":"{}","mode":"overwrite"}' | jq -e '.isError == true' >/dev/null
[ "$(status -H "Authorization: Bearer $admin_token")" = 200 ]

echo "an agent call after an admin call is restricted again"
call list_vaults '{}' | jq -e '.structuredContent.writable == ["Test","Other/Inbox","Other/Facts"]' >/dev/null
call write_note '{"vault":"Other","path":"Root.md","content":"x","mode":"overwrite"}' | jq -e '.isError == true' >/dev/null

echo "paths can't escape the writable folders in other spellings"
for p in 'Inbox\..\Root' '/Other/Root' 'Inbox/./../Root.md' 'Inbox/..'; do
  call write_note "$(jq -nc --arg p "$p" '{vault:"Other",path:$p,content:"x",mode:"overwrite"}')" | jq -e '.isError == true' >/dev/null
done
call edit_note '{"vault":"Other","path":"Inbox/../Root","old_text":"changed","new_text":"x"}' | jq -e '.isError == true' >/dev/null
call forget '{"vault":"Other","path":"Inbox/../Root","reason":"x"}' | jq -e '.isError == true' >/dev/null
call forget '{"vault":"Other","path":"Root","reason":"x"}' | jq -e '.isError == true' >/dev/null
grep -qx 'changed by admin' "$other/Root.md"

echo "symlinks can't lead writes out of the writable folders"
call write_note '{"vault":"Other","path":"Inbox/Link to root.md","content":"x","mode":"overwrite"}' | jq -e '.isError == true' >/dev/null
call edit_note '{"vault":"Other","path":"Inbox/Link to root.md","old_text":"changed","new_text":"x"}' | jq -e '.isError == true' >/dev/null
call write_note '{"vault":"Other","path":"Inbox/notes/Kept.md","content":"x","mode":"overwrite"}' | jq -e '.isError == true' >/dev/null
call write_note '{"vault":"Other","path":"Inbox/notes/New","content":"x"}' | jq -e '.isError == true' >/dev/null
call write_note '{"vault":"Other","path":"Inbox/Dangling.md","content":"x"}' | jq -e '.isError == true' >/dev/null
grep -qx 'changed by admin' "$other/Root.md"
[ ! -e "$other/Notes/New.md" ] && grep -qx 'Not writable.' "$other/Notes/Kept.md"
! docker exec ignis-smoke test -e /tmp/ignis-smoke-escape.md

echo "unexpected errors don't reveal server paths"
mkdir -p "$other/Inbox/Folder.md"
call write_note '{"vault":"Other","path":"Inbox/Folder.md","content":"x","mode":"overwrite"}' | jq -e '.isError == true and (.content[0].text | contains("/vaults") | not)' >/dev/null
call write_note "$(jq -nc '{vault:"Other",path:"Inbox/nul\u0000byte",content:"x"}')" | jq -e '.isError == true and (.content[0].text | contains("/vaults") | not)' >/dev/null

echo "concurrent appends to one note all land"
for i in $(seq 10); do
  call write_note "$(jq -nc --arg c "line $i" '{vault:"Other",path:"Inbox/Log",content:($c + "\n"),mode:"append"}')" >/dev/null &
  pids+=($!)
done
# Only these calls: a bare wait would also wait for the fake embedding server.
wait "${pids[@]}"
[ "$(grep -c '^line ' "$other/Inbox/Log.md")" = 10 ]

echo "the read token gets only the read tools"
auth=$read_token rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | jq -e '[.result.tools[].name] | sort == ["list_notes","list_vaults","read_note","search_notes","semantic_search"]' >/dev/null
auth=$read_token call list_vaults '{}' | jq -e '.structuredContent.writable == []' >/dev/null
auth=$read_token call read_note '{"vault":"Other","path":"Root.md"}' | jq -e '.structuredContent.content | contains("changed by admin")' >/dev/null
auth=$read_token rpc "$(jq -nc '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"write_note",arguments:{vault:"Other",path:"Inbox/R",content:"x"}}}')" \
  | jq -e '.error != null or .result.isError == true' >/dev/null
[ ! -e "$other/Inbox/R.md" ]

echo "the frontmatter stays one clean block"
printf -- '---\nstatus: inbox\nnote: |\n  two\n  lines\nstatus: inbox\n---\n# Dup\n' > "$other/Inbox/Dup.md"
call forget '{"vault":"Other","path":"Inbox/Dup","reason":"x"}' | jq -e '.isError != true' >/dev/null
[ "$(grep -c '^status:' "$other/Inbox/Dup.md")" = 1 ]
grep -qx 'status: outdated' "$other/Inbox/Dup.md"

echo "a byte-order mark before the frontmatter doesn't produce a second block"
printf '\xEF\xBB\xBF---\nstatus: inbox\n---\n# Bom\n' > "$other/Inbox/Bom.md"
call forget '{"vault":"Other","path":"Inbox/Bom","reason":"x"}' | jq -e '.isError != true' >/dev/null
[ "$(grep -c 'status:' "$other/Inbox/Bom.md")" = 1 ]
[ "$(grep -c -e '---' "$other/Inbox/Bom.md")" = 2 ]
grep -qx 'status: outdated' "$other/Inbox/Bom.md"

echo "All smoke tests passed"
