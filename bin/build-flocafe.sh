#!/bin/sh
set -e
REF="$1"
DIR=/work/flocafe
rm -rf "$DIR"
git clone -q --depth 1 --branch "$REF" https://github.com/FreeOpenSourcePOS/FloCafe "$DIR"
cd "$DIR"
git rev-parse HEAD > /work/flocafe.commit
npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
npm rebuild better-sqlite3 --loglevel=error
(cd frontend && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error)
npm run -s build:frontend > /tmp/build-frontend.log 2>&1
npm run -s build > /tmp/build-backend.log 2>&1
echo "built $REF at $(cat /work/flocafe.commit)"
