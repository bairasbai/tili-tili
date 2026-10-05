#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
: "${TEST_DATABASE_URL:?Use a disposable local *_test database}"
: "${E2E_RESULT_DIR:?Set an evidence directory outside the source tree}"
python - <<'PY'
import os, urllib.parse
u = urllib.parse.urlparse(os.environ['TEST_DATABASE_URL'])
assert u.scheme in ('postgres', 'postgresql') and u.hostname in ('127.0.0.1', 'localhost') and u.path.endswith('_test'), 'Only local disposable *_test databases are allowed'
PY
mkdir -p "$E2E_RESULT_DIR"
work=$(mktemp -d)
export E2E_FIXTURE_FILE="$work/fixture.json"
api_pid= ui_pid=
cleanup() {
  for pid in "$api_pid" "$ui_pid"; do
    if test -n "$pid"; then kill "$pid" 2>/dev/null || true; fi
  done
  for pid in "$api_pid" "$ui_pid"; do
    if test -n "$pid"; then wait "$pid" 2>/dev/null || true; fi
  done
  rm -rf "$work"
}
trap cleanup EXIT
cd "$ROOT/Тили-тили/backend"
DATABASE_URL="$TEST_DATABASE_URL" node node_modules/node-pg-migrate/bin/node-pg-migrate.js -m migrations up > "$E2E_RESULT_DIR/migrations.log" 2>&1
(exec node node_modules/tsx/dist/cli.mjs scripts/task-e2e-server.mts) > "$work/api.log" 2>&1 & api_pid=$!
(cd "$ROOT/Тили-тили/app" && exec node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 3000 --strictPort) > "$work/ui.log" 2>&1 & ui_pid=$!
ready=0
for attempt in $(seq 1 60); do
  if ! kill -0 "$api_pid" 2>/dev/null || ! kill -0 "$ui_pid" 2>/dev/null; then break; fi
  if test -s "$E2E_FIXTURE_FILE" && curl --fail --silent http://127.0.0.1:3001/health >/dev/null && curl --fail --silent http://127.0.0.1:3000 >/dev/null; then ready=1; break; fi
  sleep 1
done
if test "$ready" != 1; then
  WORK="$work" python - <<'PY'
import json, os, pathlib, re
logs = {}
for name in ('api', 'ui'):
    text = (pathlib.Path(os.environ['WORK'])/(name+'.log')).read_text(errors='replace')[-12000:]
    text = re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[redacted-token]', text)
    text = re.sub(r'postgres(?:ql)?://[^\s"\x27]+', '[redacted-db]', text)
    logs[name] = re.sub(r'\+7\d{10}', '[redacted-phone]', text)
(pathlib.Path(os.environ['E2E_RESULT_DIR'])/'startup-error.json').write_text(json.dumps(logs, indent=2))
PY
  exit 1
fi
python "$ROOT/Тили-тили/e2e/guest-import-recovery-browser.py"
# An independent native SQL read checks the browser/API counts against persisted rows.
node --input-type=module <<'JS'
import pg from 'pg'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const fixture = JSON.parse(readFileSync(process.env.E2E_FIXTURE_FILE, 'utf8'))
const dir = process.env.E2E_RESULT_DIR
const browser = JSON.parse(readFileSync(join(dir, 'recovery-result.json'), 'utf8'))
const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL })
await client.connect()
try {
  const persons = await client.query('select count(*)::int as n from guests where wedding_id=$1', [fixture.weddingId])
  const parties = await client.query('select count(*)::int as n from guest_parties where wedding_id=$1', [fixture.weddingId])
  const proof = { persons: persons.rows[0].n, parties: parties.rows[0].n, expectedPersons: browser.expected_db_persons, expectedParties: browser.expected_db_parties }
  writeFileSync(join(dir, 'db-proof.json'), JSON.stringify(proof, null, 2))
  if (browser.status !== 'passed' || proof.persons !== 129 || proof.parties !== 50 || proof.persons !== proof.expectedPersons || proof.parties !== proof.expectedParties) throw new Error('Browser/API/SQL totals differ')
} finally { await client.end() }
JS
printf 'WP02_RECOVERY_BROWSER_PASS\n'
