#!/bin/sh
# Clone (or update) the data branch, then collect forever in 20-minute cycles, pushing after each one.
set -e
if [ ! -d store/.git ]; then git clone -q -b data --single-branch "$GIT_REMOTE" store; fi
git -C store config user.name "portflow-collector"
git -C store config user.email "portflow-collector@users.noreply.github.com"
exec python ingest/collect.py --store store --minutes "${MINUTES:-20}" --cycles 0 --git-push
