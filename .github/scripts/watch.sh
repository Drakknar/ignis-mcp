#!/usr/bin/env bash
# Shared helper for the Claude upstream-watch workflows. What has been reviewed
# is recorded in state.json on the "watch-state" branch, so scheduled runs don't
# repeat a review and main gets no bookkeeping commits.
#
#   watch.sh should-run KEY   "true" if KEY was never reviewed, or the last review
#                             was transient (an outage) more than a day ago
#   watch.sh get KEY          KEY's stored value, empty if none
#   watch.sh set K=V...       stores values
#   watch.sh report DIR       turns DIR/verdict.json and DIR/changes.patch into a
#                             pull request and/or issues, then records WATCH_KEYS
#
# report reads these variables:
#   WATCH_KEYS      space-separated K=V pairs to record. A value of "@" becomes
#                   "done:<date>" (or "transient:<epoch>" on a transient verdict;
#                   other pairs are then skipped, so nothing moves forward).
#   WATCH_SUBJECT   what was reviewed, for titles ("Home Assistant 2026.11.0")
#   WATCH_BRANCH    branch name for a pull request
#   WATCH_DISPATCH  optional workflow file to run on that branch to verify it
#
# Needs GH_TOKEN and the standard GITHUB_* variables.
set -euo pipefail

STATE_BRANCH=watch-state
STATE_FILE=state.json
LABEL=upstream-watch
repo=$GITHUB_REPOSITORY

fetch_state() {
	gh api "repos/$repo/contents/$STATE_FILE?ref=$STATE_BRANCH" 2>/dev/null || true
}

get() {
	local resp
	resp=$(fetch_state)
	[ -n "$resp" ] || return 0
	jq -r .content <<<"$resp" | base64 -d | jq -r --arg k "$1" '.[$k] // ""'
}

should_run() {
	local v
	v=$(get "$1")
	case "$v" in
		"") echo true ;;
		transient:*)
			if [ $(($(date +%s) - ${v#transient:})) -gt 86400 ]; then echo true; else echo false; fi
			;;
		*) echo false ;;
	esac
}

create_state_branch() {
	local tree commit
	tree=$(jq -n --arg p "$STATE_FILE" --arg c "$1" '{tree: [{path: $p, mode: "100644", type: "blob", content: $c}]}' |
		gh api "repos/$repo/git/trees" --input - --jq .sha)
	commit=$(jq -n --arg t "$tree" '{message: "Start upstream-watch state", tree: $t, parents: []}' |
		gh api "repos/$repo/git/commits" --input - --jq .sha)
	gh api "repos/$repo/git/refs" -f ref="refs/heads/$STATE_BRANCH" -f sha="$commit" >/dev/null
}

set_state() {
	[ $# -gt 0 ] || return 0
	local attempt resp current sha new kv msg
	msg="Record $(printf '%s ' "${@%%=*}")"
	for attempt in 1 2 3 4 5; do
		resp=$(fetch_state)
		if [ -n "$resp" ]; then
			current=$(jq -r .content <<<"$resp" | base64 -d)
			sha=$(jq -r .sha <<<"$resp")
		else
			current='{}'
			sha=
		fi
		new=$current
		for kv in "$@"; do
			new=$(jq --arg k "${kv%%=*}" --arg v "${kv#*=}" '.[$k] = $v' <<<"$new")
		done
		new=$(jq -S . <<<"$new")
		if [ -n "$sha" ]; then
			gh api -X PUT "repos/$repo/contents/$STATE_FILE" -f message="$msg" -f branch="$STATE_BRANCH" \
				-f sha="$sha" -f content="$(base64 -w0 <<<"$new")" >/dev/null && return 0
		elif gh api -X PUT "repos/$repo/contents/$STATE_FILE" -f message="$msg" -f branch="$STATE_BRANCH" \
			-f content="$(base64 -w0 <<<"$new")" >/dev/null 2>&1 || create_state_branch "$new"; then
			return 0
		fi
		sleep $((attempt * 3))
	done
	echo "::error::Could not record $msg"
	return 1
}

# Opens an issue unless an open one with the same title exists, so a failure
# that repeats every scheduled run is reported once. Prints the issue URL.
open_issue() {
	local title=$1 body=$2 labels=$3 existing
	existing=$(gh issue list -R "$repo" --state open --label "$LABEL" --limit 100 --json title,url |
		jq -r --arg t "$title" '[.[] | select(.title == $t) | .url][0] // ""')
	if [ -n "$existing" ]; then
		echo "$existing"
		return 0
	fi
	gh issue create -R "$repo" --title "$title" --body "$body" --label "$labels" --assignee "$GITHUB_REPOSITORY_OWNER"
}

report() {
	local dir=$1 run_url status title body improvements footer pr_url="" issue_url="" branch value kv
	local -a pairs=()
	run_url="$GITHUB_SERVER_URL/$repo/actions/runs/$GITHUB_RUN_ID"
	footer=$'\n\n---\n'"Opened by the Claude upstream watch ([run]($run_url)). Review the change before merging."

	gh label create "$LABEL" -R "$repo" --color 5319e7 --description "Opened by the Claude upstream watch" --force >/dev/null
	gh label create enhancement -R "$repo" --color a2eeef --force >/dev/null

	if [ -s "$dir/verdict.json" ] && jq -e '.status and .title and .report' "$dir/verdict.json" >/dev/null 2>&1; then
		status=$(jq -r .status "$dir/verdict.json")
		title=$(jq -r .title "$dir/verdict.json")
		body=$(jq -r .report "$dir/verdict.json" | head -c 60000)
		improvements=$(jq -r '.improvements // ""' "$dir/verdict.json" | head -c 60000)
	else
		# No verdict: Claude didn't run or didn't finish (expired token, usage
		# limit, timeout). Report it, record nothing, and retry next run.
		open_issue "Claude upstream watch failed: $WATCH_SUBJECT" \
			"The review for $WATCH_SUBJECT produced no result. Check the run log, and the CLAUDE_CODE_OAUTH_TOKEN secret if Claude didn't start.$footer" \
			"$LABEL" >/dev/null
		echo "::error::No verdict from Claude"
		return 1
	fi
	echo "Verdict: $status - $title"

	if [ "$status" = transient ]; then
		for kv in $WATCH_KEYS; do
			[ "${kv#*=}" = "@" ] && pairs+=("${kv%%=*}=transient:$(date +%s)")
		done
		set_state "${pairs[@]}"
		{ echo "## Transient: $title"; echo; echo "$body"; } >>"$GITHUB_STEP_SUMMARY"
		return 0
	fi

	if [ -s "$dir/changes.patch" ]; then
		branch=$WATCH_BRANCH
		if git ls-remote --exit-code origin "refs/heads/$branch" >/dev/null 2>&1; then
			branch="$branch-$GITHUB_RUN_ID"
		fi
		git config user.name "github-actions[bot]"
		git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
		git switch -c "$branch"
		git apply --index "$dir/changes.patch"
		git commit -m "$title" -m "Proposed by the Claude upstream watch after reviewing $WATCH_SUBJECT."
		git push origin "HEAD:refs/heads/$branch"
		pr_url=$(gh pr create -R "$repo" --base "$(gh api "repos/$repo" --jq .default_branch)" --head "$branch" \
			--title "$title" --body "$body$footer" --label "$LABEL" --assignee "$GITHUB_REPOSITORY_OWNER")
		echo "Pull request: $pr_url"
		if [ -n "${WATCH_DISPATCH:-}" ]; then
			gh workflow run "$WATCH_DISPATCH" -R "$repo" --ref "$branch" -f force=true
			gh pr comment "$pr_url" -R "$repo" --body "Started \`$WATCH_DISPATCH\` on this branch to check the fix (it never publishes from a branch): $GITHUB_SERVER_URL/$repo/actions/workflows/$WATCH_DISPATCH?query=branch%3A$branch"
		fi
	elif [ "$status" = fixed ]; then
		status=needs_attention
		body="Claude reported a fix but left no changes, so this needs a look.

$body"
	fi

	if [ "$status" = needs_attention ]; then
		[ -n "$pr_url" ] && body="$body

Proposed fix: $pr_url"
		issue_url=$(open_issue "$title" "$body$footer" "$LABEL")
		echo "Issue: $issue_url"
	fi

	if [ -n "$improvements" ]; then
		open_issue "Ideas from $WATCH_SUBJECT" "$improvements$footer" "$LABEL,enhancement"
	fi

	value="done:$(date -u +%F)"
	for kv in $WATCH_KEYS; do
		if [ "${kv#*=}" = "@" ]; then pairs+=("${kv%%=*}=$value"); else pairs+=("$kv"); fi
	done
	set_state "${pairs[@]}"

	{
		echo "## $status: $title"
		[ -n "$pr_url" ] && echo "Pull request: $pr_url"
		[ -n "$issue_url" ] && echo "Issue: $issue_url"
		echo
		echo "$body"
	} >>"$GITHUB_STEP_SUMMARY"
}

cmd=${1:?usage: watch.sh should-run|get|set|report ...}
shift
case "$cmd" in
	should-run) should_run "$1" ;;
	get) get "$1" ;;
	set) set_state "$@" ;;
	report) report "$1" ;;
	*) echo "unknown command $cmd" >&2; exit 2 ;;
esac
