import hashlib
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
BASE = pathlib.Path('C:/Тили-тили/.unlazy/policy-teardown-48-20261014/onboarding-browser-v12.py')
BASE_SHA = 'D5C6E36292B490F7C28D72637075D7863B7CE324210EF0B756072E6AB2D42A74'
COPY = HERE / BASE.name
sha = lambda value: hashlib.sha256(value).hexdigest().upper()
raw = BASE.read_bytes()
assert sha(raw) == BASE_SHA
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

replace('def now():\n    return time.time()\n', r'''def now():
    return time.time()


def network_error_code(value):
    # Retain only the Chromium enum; never retain free-form error/console text.
    if not isinstance(value, str):
        return None
    match = re.search(r'\bnet::(ERR_[A-Z0-9_]+)\b', value)
    return match.group(1) if match else None
''', 'safe network error enum observation')

replace('        self.font_network, self.font_waiters = {}, {}\n', '''        self.font_network, self.font_waiters = {}, {}
        self.api_clock = {}
        self.result['apiClockObservations'] = []
        def api_clock_request(e):
            request = e.get('request', {})
            if urlsplit(request.get('url', '')).path not in ('/api/health', '/api/legal/policy'):
                return
            try:
                self.safe_url(request['url'])
                require(e['requestId'] not in self.api_clock, 'api_clock_request_identity')
                row = {**self.binding(), 'requestId': e['requestId'], 'url': request['url'],
                       'method': request['method'], 'hostRequestEventAt': now(),
                       'requestTimestamp': e['timestamp'], 'requestWallTime': e['wallTime']}
                self.api_clock[e['requestId']] = row
                self.result['apiClockObservations'].append(row)
            except BaseException as error:
                self.result['captureErrors'].append({**self.binding(), **safe_failure(error)})
        def api_clock_response(e):
            row = self.api_clock.get(e['requestId'])
            if row is None:
                return
            response = e['response']
            row.update(hostResponseEventAt=now(), responseTimestamp=e['timestamp'],
                       status=response['status'], fromServiceWorker=response.get('fromServiceWorker'))
            timing = response.get('timing', {})
            row['responseTiming'] = {key: timing[key] for key in (
                'requestTime', 'dnsStart', 'dnsEnd', 'connectStart', 'connectEnd', 'sslStart',
                'sslEnd', 'sendStart', 'sendEnd', 'receiveHeadersStart', 'receiveHeadersEnd') if key in timing}
        def api_clock_finish(kind, e):
            row = self.api_clock.get(e['requestId'])
            if row is not None and kind == 'finishedEvents':
                row.update(hostFinishedEventAt=now(), finishedTimestamp=e['timestamp'])
''', 'raw API clock observation through existing CDP listeners')

replace("        def font_request(e):\n            if e['type'] != 'Font':\n", "        def font_request(e):\n            api_clock_request(e)\n            if e['type'] != 'Font':\n", 'observe API request without new CDP session or sends')
replace("        def font_response(e):\n            if e['type'] != 'Font':\n", "        def font_response(e):\n            api_clock_response(e)\n            if e['type'] != 'Font':\n", 'observe raw API response timing')
replace("        def font_more(kind, e):\n            v = self.font_network.get(e['requestId'])\n", "        def font_more(kind, e):\n            api_clock_finish(kind, e)\n            v = self.font_network.get(e['requestId'])\n", 'observe API finish through existing callback')

replace("            {**self.binding(), 'code': 'original_cdp_loading_failed', 'cdpRequestId': e['requestId']}))\n", "            {**self.binding(), 'code': 'original_cdp_loading_failed', 'cdpRequestId': e['requestId'],\n"
        "             'networkErrorCode': network_error_code(e.get('errorText')),\n"
        "             'errorTextSHA256': digest(e.get('errorText', '').encode()),\n"
        "             'canceled': e.get('canceled') is True}))\n", 'retain network failure enum; original failure still counted')
replace("             'code': 'original_request_failed'}))\n", "             'code': 'original_request_failed',\n"
        "             'networkErrorCode': network_error_code(q.failure)}))\n", 'retain original PW request failure enum')
replace("            'textSHA256': digest(m.text.encode()), 'textByteLength': len(m.text.encode())}) if m.type == 'error' else None)\n", "            'textSHA256': digest(m.text.encode()), 'textByteLength': len(m.text.encode()),\n"
        "            'networkErrorCode': network_error_code(m.text)}) if m.type == 'error' else None)\n", 'retain console network enum alongside original hash and count')

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
    report = {'kind': 'AUTHORIZED_DIAGNOSTIC_COPY_EXACT_BYTE_INVERSE',
              'basePath': str(BASE), 'baseSHA256': BASE_SHA,
              'copyPath': str(COPY), 'copySHA256': sha(raw), 'baseUnchanged': True,
              'exactByteInverse': True, 'editGroups': len(edits),
              'purposes': [entry[2] for entry in edits], 'originalChecksChanged': False,
              'extraCDPSessions': 0, 'extraCDPSends': 0, 'injectedJSLoggers': False}
    with (HERE / 'diagnostic-copy-inverse.json').open('x', encoding='utf8') as handle:
        json.dump(report, handle, indent=2)
print(json.dumps({'copySHA256': sha(raw), 'exactByteInverse': True, 'baseUnchanged': True}))
