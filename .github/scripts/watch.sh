#!/usr/bin/env bash
# Shared helper for the Claude upstream-watch workflows. What has been reviewed
# is recorded in state.json on the "watch-state" branch, so scheduled runs don't
# repeat a review and main gets no bookkeeping commits.
#
#   watch.sh should-run KEY   "true" if KEY was never reviewed, or the last review
#                             was transient (an outage) more than a day ago
#   watch.sh get KEY          KEY's stored value, empty if none
#   watch.sh set K=V...       stores values
#   watch.sh has-open LABEL   "true" if an open issue or pull request has LABEL
#   watch.sh report DIR       turns DIR/verdict.json and DIR/changes.patch into a
#                             pull request and/or issues, then records WATCH_KEYS
#
# report reads these variables:
#   WATCH_KEYS      space-separated K=V pairs to record. A value of "@" becomes
#                   "done:<date>" (or "transient:<epoch>" on a transient verdict;
#                   other pairs are then skipped, so nothing moves forward).
#   WATCH_SUBJECT   what was reviewed, for titles ("Home Assistant 2026.11.0")
#   WATCH_BRANCH    branch name for a pull request
#   WATCH_DISPATCH  optional workflow file to run on that branch to verify it;
#                   the result is posted on the pull request
#   WATCH_MODE      "fix" when a failed build was reviewed: a verdict of "clear"
#                   with no changes then still opens an issue, since the build
#                   is still failing
#   WATCH_EXTRA_LABEL  optional second label for everything opened
#   WATCH_SECRET    the Claude token. If the verdict or the diff contains it, or
#                   a piece of it, nothing is published (see leaks below)
#
# Needs GH_TOKEN and the standard GITHUB_* variables.
set -euo pipefail

STATE_BRANCH=watch-state
STATE_FILE=state.json
LABEL=upstream-watch
BODY_LIMIT=60000 # characters; GitHub allows 65536 per body
# Bodies go to gh as files: one command-line argument is limited to 128 KB on
# Linux, which a long report in a multi-byte script can exceed.
repo=$GITHUB_REPOSITORY

# Prints the contents API response, or nothing if there is no state yet. On an
# error gh still prints the error body to stdout, so only a success counts.
fetch_state() {
	local resp
	if resp=$(gh api "repos/$repo/contents/$STATE_FILE?ref=$STATE_BRANCH" 2>/dev/null); then
		printf '%s\n' "$resp"
	fi
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

has_open() {
	local n
	n=$(gh issue list -R "$repo" --state open --label "$1" --limit 1 --json number --jq length)
	n=$((n + $(gh pr list -R "$repo" --state open --label "$1" --limit 1 --json number --jq length)))
	if [ "$n" -gt 0 ]; then echo true; else echo false; fi
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
	printf '%s' "$body" >"$RUNNER_TEMP/watch-body.md"
	gh issue create -R "$repo" --title "$title" --body-file "$RUNNER_TEMP/watch-body.md" --label "$labels" \
		--assignee "$GITHUB_REPOSITORY_OWNER"
}

# Succeeds if a file in DIR contains WATCH_SECRET: whole, base64-encoded, or any
# 20-character piece of it (checked every 10 characters, so any 30 consecutive
# characters are caught). The repositories are public, so a pull request or
# issue would publish the token. Encoded or scrambled copies can't be caught;
# the subprocess scrub in the review job is what keeps Claude away from it.
leaks() {
	local dir=$1 s=${WATCH_SECRET:-} i f p
	local -a pieces=()
	[ ${#s} -ge 20 ] || return 1
	pieces+=("$s" "$(printf '%s' "$s" | base64 -w0)")
	for ((i = 0; i + 20 <= ${#s}; i += 10)); do
		pieces+=("${s:i:20}")
	done
	for f in "$dir/verdict.json" "$dir/changes.patch"; do
		[ -f "$f" ] || continue
		for p in "${pieces[@]}"; do
			grep -qF -e "$p" "$f" && return 0
		done
	done
	return 1
}

# Runs WATCH_DISPATCH on the pull request's branch, waits for it and posts the
# result on the pull request. A failed check turns the pull request into a draft.
# Runs started by the Actions token send no failure email, hence the comment.
verify_branch() {
	local branch=$1 pr_url=$2 run_id="" url
	gh workflow run "$WATCH_DISPATCH" -R "$repo" --ref "$branch" -f force=true
	for _ in $(seq 24); do
		sleep 5
		run_id=$(gh run list -R "$repo" --workflow "$WATCH_DISPATCH" --branch "$branch" --event workflow_dispatch \
			--limit 1 --json databaseId --jq '.[0].databaseId // ""')
		[ -n "$run_id" ] && break
	done
	if [ -z "$run_id" ]; then
		gh pr comment "$pr_url" -R "$repo" --body "Couldn't find the \`$WATCH_DISPATCH\` run started on this branch. Run it by hand before merging."
		return 0
	fi
	url="$GITHUB_SERVER_URL/$repo/actions/runs/$run_id"
	echo "Verification run: $url"
	if timeout 55m gh run watch "$run_id" -R "$repo" --interval 30 --exit-status >/dev/null 2>&1; then
		gh pr comment "$pr_url" -R "$repo" --body "Check passed: \`$WATCH_DISPATCH\` built and tested this branch without publishing ([run]($url))."
	elif [ "$(gh run view "$run_id" -R "$repo" --json status --jq .status)" != completed ]; then
		gh pr comment "$pr_url" -R "$repo" --body "\`$WATCH_DISPATCH\` on this branch was still running after 55 minutes ([run]($url)). Check it before merging."
	else
		gh pr ready "$pr_url" -R "$repo" --undo >/dev/null 2>&1 || true
		gh pr comment "$pr_url" -R "$repo" --body "**Check failed:** \`$WATCH_DISPATCH\` failed on this branch ([run]($url)), so this pull request is now a draft. Don't merge it as it is."
	fi
}

report() {
	local dir=$1 run_url status title body improvements footer labels pr_url="" issue_url="" branch="" value kv
	local -a pairs=()
	run_url="$GITHUB_SERVER_URL/$repo/actions/runs/$GITHUB_RUN_ID"
	footer=$'\n\n---\n'"Opened by the Claude upstream watch ([run]($run_url)). Review the change before merging."
	labels=$LABEL${WATCH_EXTRA_LABEL:+,$WATCH_EXTRA_LABEL}

	gh label create "$LABEL" -R "$repo" --color 5319e7 --description "Opened by the Claude upstream watch" --force >/dev/null
	if [ -n "${WATCH_EXTRA_LABEL:-}" ]; then
		gh label create "$WATCH_EXTRA_LABEL" -R "$repo" --color d93f0b \
			--description "Claude's handling of a failed upstream build; new failures wait until this is closed" --force >/dev/null
	fi
	gh label list -R "$repo" --search enhancement --json name --jq '.[].name' | grep -qx enhancement ||
		gh label create enhancement -R "$repo" --color a2eeef --description "New feature or request" >/dev/null

	if leaks "$dir"; then
		# Nothing from the review is published, not even in the log.
		open_issue "Claude upstream watch withheld a report: $WATCH_SUBJECT" \
			"The review's report or proposed change contained the CLAUDE_CODE_OAUTH_TOKEN secret, or part of it, so nothing from it was published. That points to a prompt injection in the upstream content Claude read.

Treat the token as exposed:
1. Create a new one with \`claude setup-token\`.
2. Update the CLAUDE_CODE_OAUTH_TOKEN secret in every repository that uses it.
3. Revoke the old token.

The review's files are deleted at the end of this run; the run log doesn't contain them.$footer" \
			"$labels" >/dev/null
		echo "::error::The review output contained the Claude token; nothing was published"
		return 1
	fi

	if [ -s "$dir/verdict.json" ] && jq -e '.status and .title and .report' "$dir/verdict.json" >/dev/null 2>&1; then
		status=$(jq -r .status "$dir/verdict.json")
		title=$(jq -r .title "$dir/verdict.json")
		body=$(jq -r --argjson n "$BODY_LIMIT" '.report[0:$n]' "$dir/verdict.json")
		improvements=$(jq -r --argjson n "$BODY_LIMIT" '(.improvements // "")[0:$n]' "$dir/verdict.json")
	else
		# No verdict: Claude didn't run or didn't finish (expired token, usage
		# limit, timeout). Report it, record nothing, and retry next run.
		open_issue "Claude upstream watch failed: $WATCH_SUBJECT" \
			"The review for $WATCH_SUBJECT produced no result. Check the run log, and the CLAUDE_CODE_OAUTH_TOKEN secret if Claude didn't start.$footer" \
			"$labels" >/dev/null
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
		printf '%s' "$body$footer" >"$RUNNER_TEMP/watch-body.md"
		pr_url=$(gh pr create -R "$repo" --base "$(gh api "repos/$repo" --jq .default_branch)" --head "$branch" \
			--title "$title" --body-file "$RUNNER_TEMP/watch-body.md" --label "$labels" --assignee "$GITHUB_REPOSITORY_OWNER")
		echo "Pull request: $pr_url"
	elif [ "$status" = fixed ]; then
		status=needs_attention
		body="Claude reported a fix but left no changes, so this needs a look.

$body"
	elif [ "$status" = clear ] && [ "${WATCH_MODE:-}" = fix ]; then
		status=needs_attention
		body="The build failed, but Claude found nothing to change and didn't call it an outage. The build is still failing, so this needs a look.

$body"
	fi

	if [ "$status" = needs_attention ]; then
		if [ -n "$pr_url" ]; then
			body="$body

Proposed fix: $pr_url"
		fi
		issue_url=$(open_issue "$title" "$body$footer" "$labels")
		echo "Issue: $issue_url"
	fi

	if [ -n "$improvements" ]; then
		open_issue "Ideas from $WATCH_SUBJECT" "$improvements$footer" "$LABEL,enhancement" >/dev/null
	fi

	value="done:$(date -u +%F)"
	for kv in $WATCH_KEYS; do
		if [ "${kv#*=}" = "@" ]; then pairs+=("${kv%%=*}=$value"); else pairs+=("$kv"); fi
	done
	set_state "${pairs[@]}"

	{
		echo "## $status: $title"
		if [ -n "$pr_url" ]; then echo "Pull request: $pr_url"; fi
		if [ -n "$issue_url" ]; then echo "Issue: $issue_url"; fi
		echo
		echo "$body"
	} >>"$GITHUB_STEP_SUMMARY"

	# Last, so a slow or stuck check can't keep the review from being recorded.
	if [ -n "$pr_url" ] && [ -n "${WATCH_DISPATCH:-}" ]; then
		verify_branch "$branch" "$pr_url"
	fi
}

cmd=${1:?usage: watch.sh should-run|get|set|has-open|report ...}
shift
case "$cmd" in
	should-run) should_run "$1" ;;
	get) get "$1" ;;
	set) set_state "$@" ;;
	has-open) has_open "$1" ;;
	report) report "$1" ;;
	*) echo "unknown command $cmd" >&2; exit 2 ;;
esac
