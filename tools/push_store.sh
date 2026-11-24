#!/usr/bin/env bash
# Commit everything in the data-branch checkout $1 with message $2 and push it, retrying when another workflow pushed
# first. On a conflicting file this run's version wins (each workflow writes its own files, so this is rare).
set -u
cd "$1"
git config user.name "portflow-collector"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
if git diff --cached --quiet; then
  echo "Nothing new to save."
  exit 0
fi
git commit -q -m "$2"
branch=$(git rev-parse --abbrev-ref HEAD)
for i in 1 2 3 4 5 6; do
  if git pull -q --rebase -X theirs origin "$branch" && git push -q origin "HEAD:$branch"; then
    echo "Saved: $2"
    exit 0
  fi
  git rebase --abort 2>/dev/null || true
  echo "push attempt $i failed; retrying"
  sleep $((i * ${PUSH_BACKOFF_S:-7}))
done
echo "::error::could not save to the data branch after 6 attempts"
exit 1
