#!/usr/bin/env bash
# Обход одного задания: bash run.sh <name> <role> <setup> <clicks> [w=390] route... → $LIVE_DIR/crawl/out/<name>.log, сводка на stdout.
S="$(cd "$(dirname "$0")" && pwd)"
C="${LIVE_DIR:?LIVE_DIR не задан — см. README.md}/crawl"
mkdir -p "$C/out"
name="$1"
mkdir "$C/run-$name.lock" 2>/dev/null || { echo "lock held — second run skipped"; exit 0; }
export MSYS_NO_PATHCONV=1
node "$S/mkjob.mjs" "$@"
node "$S/crawl-run.cjs" 2>"$C/out/$name.err" | tee "$C/out/$name.log"
rc=${PIPESTATUS[0]}
rmdir "$C/run-$name.lock"
[ -s "$C/out/$name.err" ] && { echo "stderr:"; head -c 1500 "$C/out/$name.err"; }
echo "rc=$rc"
