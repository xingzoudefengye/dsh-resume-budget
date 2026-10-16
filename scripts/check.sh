#!/usr/bin/env bash
# Verify one profile's resume-budget wiring:
#   1. the row is present in the composed tree;
#   2. its threshold is the value the deployment means to run.
#
# Usage: scripts/check.sh [profile] [expected-threshold]   (default: web 100000)
set -euo pipefail

PROFILE="${1:-web}"
EXPECTED="${2:-100000}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

[ -d "$PROFILE_DIR" ] || { echo "FAIL: no such profile: $PROFILE_DIR" >&2; exit 1; }

DUMP="$(mktemp)"
trap 'rm -f "$DUMP"' EXIT
dsh --profile "$PROFILE" --dump-config > "$DUMP"

status=0

if grep -q "id: resume-budget" "$DUMP"; then
	echo "ok:   resume-budget is in the composed tree"
else
	echo "FAIL: resume-budget is missing — install this bundle: dsh plugin --profile $PROFILE add github:xingzoudefengye/dsh-resume-budget" >&2
	status=1
fi

if grep -q "thresholdTokens: $EXPECTED" "$DUMP"; then
	echo "ok:   thresholdTokens is $EXPECTED"
else
	echo "WARN: thresholdTokens $EXPECTED not found in the composed tree" >&2
fi

exit "$status"
