import hashlib
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
ORIGINAL = pathlib.Path('C:/Тили-тили/.unlazy/wp03-onboarding-20261010/onboarding-browser-v12.py')
COPY = HERE / 'onboarding-browser-v12.py'
PIN = '8193050D4EFB58213600A4A93108F3B8C06672B9E11C35CF763683A86F95BD21'
raw = ORIGINAL.read_bytes()
sha = lambda value: hashlib.sha256(value).hexdigest().upper()
VERIFY_ONLY = sys.argv[1:] == ['--verify']
assert sys.argv[1:] in ([], ['--verify'])
assert sha(raw) == PIN and (VERIFY_ONLY or COPY.read_bytes() == raw)
edits = []

def replace(old, new, purpose):
    global raw
    old_bytes, new_bytes = old.encode(), new.encode()
    if raw.count(old_bytes) == 0:
        old_bytes = old_bytes.replace(b'\n', b'\r\n')
        new_bytes = new_bytes.replace(b'\n', b'\r\n')
    assert raw.count(old_bytes) == 1, purpose
    edits.append((old_bytes, new_bytes, purpose))
    raw = raw.replace(old_bytes, new_bytes, 1)

replace("                   'at': now(), 'resourceType': request.resource_type, 'documentURL': request.frame.url,\n",
        "                   'at': now(), 'resourceType': request.resource_type, 'documentURL': request.frame.url,\n"
        "                    'expectedCaseCookieSHA256': self._probe_case_sha256,\n", 'case marker observation')

replace("                require(not row['authorizationPresent'] and not row['cookiePresent'], 'anonymous_headers')\n",
        "                require(not row['authorizationPresent'], 'anonymous_headers')\n"
        "                marker = None\n"
        "                if row['cookiePresent']:\n"
        "                    parts = h['cookie'].split(';')\n"
        "                    require(len(parts) == 1 and parts[0].strip().startswith('tt_probe_case='), 'probe_cookie_only')\n"
        "                    name, value = parts[0].strip().split('=', 1)\n"
        "                    require(name == 'tt_probe_case' and re.fullmatch(r'[a-f0-9]{64}', value), 'probe_cookie_format')\n"
        "                    marker = digest(value.encode('ascii'))\n"
        "                    require(marker == row['expectedCaseCookieSHA256'], 'probe_cookie_identity')\n"
        "                row.update(caseCookieSHA256=marker, probeCookieObserved=marker is not None)\n"
        "                if urlsplit(request.url).path.startswith('/api/'):\n"
        "                    require(marker == row['expectedCaseCookieSHA256'], 'api_probe_cookie_observed')\n", 'permit only diagnostic marker cookie; preserve auth prohibition')

replace("    async def phase_end(self):\n",
        "    def close_event(self, identity, event, **values):\n"
        "        self.result.setdefault('closeJournal', []).append({**identity, 'event': event, 'at': now(), **values})\n\n"
        "    async def teardown_drain(self):\n"
        "        # Only the unloaded document: original scenario/font/geometry checks are unchanged.\n"
        "        deadline = asyncio.get_running_loop().time() + 10\n"
        "        while True:\n"
        "            self.changed.clear()\n"
        "            require(self.phase == 'teardown-unload' and self.page.url == 'about:blank', 'unloaded_teardown_scope')\n"
        "            require(asyncio.get_running_loop().time() < deadline, 'teardown_capture_deadline')\n"
        "            require(not any(self.result[k] for k in ('captureErrors', 'pageErrors', 'requestFailures', 'consoleErrors')), 'actual_observation_errors')\n"
        "            rows = [s for s in self.states.values() if s['page'] is self.page]\n"
        "            complete = all(s['finished'] and s.get('finishedCapture') is not None\n"
        "                           and s['finishedCapture'].done() and 'bodyKind' in s.get('responseRow', {}) for s in rows)\n"
        "            if complete and not self.tasks:\n"
        "                ids = {s['row']['id'] for s in rows}\n"
        "                require(len(ids) == len(rows), 'current_request_bijection')\n"
        "                require(all(s['responseRow']['status'] == 200 for s in rows), 'unexpected_http_status')\n"
        "                self.result['drains'].append({**self.binding(), 'at': now(),\n"
        "                    'document': {'url': 'about:blank', 'observedVia': 'page.url'},\n"
        "                    'requestIds': sorted(ids), 'pendingRequests': 0, 'pendingCaptures': 0,\n"
        "                    'terminalHealthRequired': False, 'teardownOnly': True})\n"
        "                return\n"
        "            await asyncio.wait_for(self.changed.wait(), max(0, deadline - asyncio.get_running_loop().time()))\n\n"
        "    async def phase_end(self):\n", 'observe unload phase without nonexistent blank-page fonts')

replace("            await self.drain(health=False)\n            complete = True\n",
        "            if record['name'] == 'teardown-unload':\n"
        "                await self.teardown_drain()\n"
        "            else:\n"
        "                await self.drain(health=False)\n"
        "            complete = True\n", 'teardown-only phase completion')
replace("            record['fontProofs'] = [d['fonts'] for d in self.result['drains']\n"
        "                if d['caseId'] == record['caseId'] and d['phase'] == record['name']]\n",
        "            record['fontProofs'] = [] if record['name'] == 'teardown-unload' else [d['fonts'] for d in self.result['drains']\n"
        "                if d['caseId'] == record['caseId'] and d['phase'] == record['name']]\n", 'explicit unloaded phase has no rendered-font claims')

replace("        self.contexts.append(context);self.result['contextsCreated'] += 1\n",
        "        self.contexts.append(context);self.result['contextsCreated'] += 1\n"
        "        probe_value = uuid.uuid4().hex + uuid.uuid4().hex\n"
        "        self._probe_value = probe_value  # In-memory only, for evidence redaction.\n"
        "        self._probe_case_sha256 = digest(probe_value.encode('ascii'))\n"
        "        identity = {'caseId': spec['id'], 'caseCookieSHA256': self._probe_case_sha256}\n"
        "        context.on('close', lambda: self.close_event(identity, 'context-close'))\n"
        "        await context.add_cookies([{'name': 'tt_probe_case', 'value': probe_value,\n"
        "            'url': self.ui + '/', 'httpOnly': True, 'sameSite': 'Lax', 'secure': False}])\n"
        "        self.result.setdefault('caseProbes', []).append({**identity, 'at': now(), 'cookieAddedBeforeNavigation': True})\n", 'random context cookie before first navigation; only hash retained')
replace("        self.page = await context.new_page()\n",
        "        self.page = await context.new_page()\n"
        "        self.page.on('close', lambda: self.close_event(identity, 'page-close'))\n", 'case-bound page-close observation')

replace("        finally:\n            try:\n                await self.phase_end()\n            finally:\n                await context.close()\n                self.result['contextsClosed'] += 1;self.contexts.remove(context)\n",
        "        finally:\n"
        "            try:\n"
        "                await self.phase_end()\n"
        "                self.close_event(identity, 'phase-end', phase=self.phase, kind='scenario')\n"
        "                if not getattr(self, '_old_close_control', False):\n"
        "                    await self.phase_start('teardown-unload')\n"
        "                    self.close_event(identity, 'unload-start')\n"
        "                    try:\n"
        "                        await self.page.goto('about:blank', wait_until='load', timeout=5000)\n"
        "                        require(self.page.url == 'about:blank', 'application_unloaded')\n"
        "                        self.close_event(identity, 'unload-done', url='about:blank')\n"
        "                    except BaseException as error:\n"
        "                        failure = safe_failure(error)\n"
        "                        self.result['captureErrors'].append({**identity, 'phase': 'teardown-unload', 'code': 'unload_failed', **failure})\n"
        "                        self.close_event(identity, 'unload-error', failure=failure)\n"
        "                        raise\n"
        "                    finally:\n"
        "                        await self.phase_end()\n"
        "                    self.close_event(identity, 'phase-end', phase='teardown-unload', kind='teardown')\n"
        "                else:\n"
        "                    self.close_event(identity, 'unload-skipped', reason='positive-old-order-control')\n"
        "            finally:\n"
        "                self.close_event(identity, 'close-call')\n"
        "                try:\n"
        "                    await context.close()\n"
        "                    self.result['contextsClosed'] += 1;self.contexts.remove(context)\n"
        "                finally:\n"
        "                    self.close_event(identity, 'close-return')\n", 'observable unload then unconditional close; positive old-order switch')

inverse = raw
for old_bytes, new_bytes, purpose in reversed(edits):
    assert inverse.count(new_bytes) == 1, purpose
    inverse = inverse.replace(new_bytes, old_bytes, 1)
assert inverse == ORIGINAL.read_bytes()
if VERIFY_ONLY:
    assert COPY.read_bytes() == raw
else:
    COPY.write_bytes(raw)
report = {'original': {'path': str(ORIGINAL), 'sha256': PIN},
          'copy': {'path': str(COPY), 'sha256': sha(raw)},
          'exactByteInverse': True, 'editGroups': len(edits),
          'purposes': [purpose for _, _, purpose in edits],
          'originalUnchanged': sha(ORIGINAL.read_bytes()) == PIN}
with (HERE / 'copy-inverse.json').open('w' if VERIFY_ONLY else 'x', encoding='utf-8') as handle:
    json.dump(report, handle, indent=2)
print(json.dumps(report))
