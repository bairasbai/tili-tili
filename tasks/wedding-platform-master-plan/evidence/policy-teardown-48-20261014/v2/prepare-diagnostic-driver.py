import hashlib
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
BASE = pathlib.Path('C:/Тили-тили/.unlazy/policy-teardown-48-20261014/driver.py')
PIN = '83E7C23792D4675F0725E3A43D2E0DB8F0E86F6F7347CD517D4CE7BCE74F5EB2'
COPY = HERE / BASE.name
sha = lambda value: hashlib.sha256(value).hexdigest().upper()
raw = BASE.read_bytes()
assert sha(raw) == PIN
edits = []

def replace(old, new, purpose):
    global raw
    old_bytes, new_bytes = old.encode(), new.encode()
    if raw.count(old_bytes) == 0:
        old_bytes = old_bytes.replace(b'\n', b'\r\n')
        new_bytes = new_bytes.replace(b'\n', b'\r\n')
    assert raw.count(old_bytes) == 1, purpose
    raw = raw.replace(old_bytes, new_bytes, 1)
    edits.append((old_bytes, new_bytes, purpose))

replace("assert MODE in ('positive', 'main')\n", "assert MODE in ('diagnostic', 'main')\n", 'only diagnostic and main allowed; no new actual old-close control')
replace("api = {'requests': [], 'responses': [], 'finished': [], 'errors': []}\n", "api = {'requests': [], 'responses': [], 'finished': [], 'errors': []}\n"
        "api_clock = {'cases': [], 'errors': []}\n", 'raw numeric CDP clock evidence store')

replace("def export_api(observer):\n    responses", """def phase_proofs(observer):
    return [{key: row.get(key) for key in ('caseId', 'name', 'startedAt', 'finishedAt', 'captured')}
            for row in observer.result['phases']]

def export_api(observer):
    api_clock['cases'].append({'caseId': observer.current['id'],
        'caseCookieSHA256': observer._probe_case_sha256,
        'observations': observer.result.get('apiClockObservations', [])})
    responses""", 'export original captured phase clocks and raw API clocks')

replace("        occurrence_id = row['caseId'] + ':' + str(row['id'])\n", """        phases = [phase for phase in observer.result['phases']
                  if phase['caseId'] == row['caseId'] and phase['name'] == row['phase']]
        module.require(len(phases) == 1 and phases[0]['captured'] is True, 'api_captured_phase_identity')
        phase = phases[0]
        module.require(all(math.isfinite(phase[key]) for key in ('startedAt', 'finishedAt'))
                       and phase['startedAt'] <= row['at'] <= finish['at'] <= phase['finishedAt'],
                       'api_host_callback_inside_captured_phase')
        occurrence_id = row['caseId'] + ':' + str(row['id'])
""", 'original API callback must belong to original completed phase')

replace("            'path': urlsplit(row['url']).path.removeprefix('/api'), 'phase': row['phase'],\n", "            'path': urlsplit(row['url']).path.removeprefix('/api'), 'phase': row['phase'],\n"
        "            'phaseStartedAt': phase['startedAt'], 'phaseFinishedAt': phase['finishedAt'],\n"
        "            'phaseCaptured': phase['captured'],\n", 'retained host phase interval; PW mapped epoch stays diagnostic')

replace("              'originalStatus': original_status, 'events': events, 'failureSnapshot': True}\n", "              'originalStatus': original_status, 'events': events, 'failureSnapshot': True,\n"
        "              'phaseProofs': phase_proofs(observer)}\n", 'failed case retains original phase capture evidence')
replace("    if MODE == 'positive':\n        selected = [next(row for row in selected if row['id'] == 'en-320-1-offline-normal')]\n", "    if MODE == 'diagnostic':\n        selected = [next(row for row in selected if row['id'] == 'ru-480-1-offline-normal')]\n", 'single exact failed case; full main selection unchanged')

replace("                    if MODE == 'main':\n                        unload_start, unload_done", "                    if MODE in ('diagnostic', 'main'):\n                        unload_start, unload_done", 'diagnostic uses the same observed blank unload as main')
replace("                              'originalStatus': original_case['status'], 'events': events}\n", "                              'originalStatus': original_case['status'], 'events': events,\n"
        "                              'phaseProofs': phase_proofs(observer)}\n", 'completed journal retains original phase witnesses')
replace("        write_new(OUT / 'api-browser.json', api)\n", "        api_clock['errors'] = api['errors']\n"
        "        write_new(OUT / 'api-clock.json', api_clock)\n"
        "        write_new(OUT / 'api-browser.json', api)\n", 'save raw clock observations without headers or logger injection')

inverse = raw
for old, new, purpose in reversed(edits):
    assert inverse.count(new) == 1, purpose
    inverse = inverse.replace(new, old, 1)
assert inverse == BASE.read_bytes()
verify = sys.argv[1:] == ['--verify']
assert sys.argv[1:] in ([], ['--verify'])
if verify:
    assert COPY.read_bytes() == raw
else:
    assert COPY.read_bytes() == BASE.read_bytes()
    COPY.write_bytes(raw)
    with (HERE / 'diagnostic-driver-inverse.json').open('x', encoding='utf8') as handle:
        json.dump({'kind': 'AUTHORIZED_DIAGNOSTIC_DRIVER_EXACT_BYTE_INVERSE',
                   'basePath': str(BASE), 'baseSHA256': PIN, 'copyPath': str(COPY),
                   'copySHA256': sha(raw), 'exactByteInverse': True, 'baseUnchanged': True,
                   'editGroups': len(edits), 'purposes': [entry[2] for entry in edits],
                   'originalCaseChecksChanged': False, 'mainCaseOrderChanged': False,
                   'extraCDPSends': 0, 'mainTrace': False, 'injectedJSLoggers': False}, handle, indent=2)
print(json.dumps({'copySHA256': sha(raw), 'exactByteInverse': True, 'baseUnchanged': True}))
