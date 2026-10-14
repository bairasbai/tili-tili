"""Bounded caller of the copied V12 checks; no trace or injected logger in main."""
import asyncio
import base64
import gc
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import sys
import time
from urllib.parse import urlsplit

from playwright.async_api import async_playwright

sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
MODE = os.environ['TILI_POLICY_MODE']
assert MODE in ('positive', 'main')
OUT = pathlib.Path(os.environ['ONBOARDING_OUT']).resolve()
assert OUT == HERE / MODE and OUT.is_dir()
assert not (OUT / 'browser-summary.json').exists()
raw = (OUT / 'admission-copy.json').read_bytes()
admission = json.loads(raw)
assert admission['origin'] == os.environ['TILI_POLICY_BASE_URL']
spec = importlib.util.spec_from_file_location('policy_teardown_v12', HERE / 'onboarding-browser-v12.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

ERROR_KEYS = ('captureErrors', 'pageErrors', 'requestFailures', 'consoleErrors', 'failures')
summary = {'mode': MODE, 'status': 'RUNNING', 'cases': [], 'errors': [],
           'browserClosed': False, 'traceEnabled': MODE == 'positive',
           'injectedLoggers': False, 'contextsCreated': 0, 'contextsClosed': 0,
           'counts': {key: 0 for key in ('layouts', 'held', 'png', 'requests', 'responses', 'finished')},
           'sourceErrors': {key: [] for key in ERROR_KEYS}}
api = {'requests': [], 'responses': [], 'finished': [], 'errors': []}
journal = {'cases': [], 'errors': []}
body_store = []
redaction_count = 0

def sha(raw_bytes):
    return hashlib.sha256(raw_bytes).hexdigest().upper()

def write_new(path, value):
    with path.open('x', encoding='utf-8', newline='\n') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    return {'path': str(path), 'sha256': sha(path.read_bytes()), 'bytes': path.stat().st_size}

def redact_marker(value, marker):
    """Sanitize only the diagnostic cookie; checks have already used real headers."""
    global redaction_count
    if isinstance(value, dict):
        for key in list(value):
            value[key] = redact_marker(value[key], marker)
    elif isinstance(value, list):
        for index in range(len(value)):
            value[index] = redact_marker(value[index], marker)
    elif isinstance(value, str) and marker in value:
        redaction_count += value.count(marker)
        value = value.replace(marker, 'sha256:' + sha(marker.encode('ascii')))
    return value

def export_api(observer):
    responses = {row['id']: row for row in observer.result['responses']}
    finishes = {row['id']: row for row in observer.result['finished']}
    for state in observer.states.values():
        row = state['row']
        if not urlsplit(row['url']).path.startswith('/api/'):
            continue
        response, finish = responses.get(row['id']), finishes.get(row['id'])
        module.require(response is not None and finish is not None, 'api_occurrence_complete')
        timing = state['request'].timing
        start = timing['startTime'] / 1000
        module.require(math.isfinite(start) and start > 0
                       and all(math.isfinite(timing[key]) and timing[key] >= 0
                               for key in ('responseStart', 'responseEnd')), 'api_network_timing_complete')
        module.require(row.get('probeCookieObserved') is True
                       and row.get('caseCookieSHA256') == observer._probe_case_sha256, 'api_observed_case_cookie')
        occurrence_id = row['caseId'] + ':' + str(row['id'])
        api['requests'].append({key: row[key] for key in ('caseId', 'caseCookieSHA256', 'probeCookieObserved', 'method', 'url', 'at')} | {
            'id': occurrence_id, 'originalRequestId': row['id'],
            'path': urlsplit(row['url']).path.removeprefix('/api'), 'phase': row['phase'],
            'networkStartAt': start,
            'networkResponseStartAt': start + timing['responseStart'] / 1000,
            'networkResponseEndAt': start + timing['responseEnd'] / 1000})
        api['responses'].append({key: response[key] for key in ('caseId', 'status', 'bodySHA256', 'at')} | {
            'id': occurrence_id, 'originalRequestId': response['id'], 'bodyBytes': response['bodyByteLength']})
        api['finished'].append({key: finish[key] for key in ('caseId', 'at')} | {
            'id': occurrence_id, 'originalRequestId': finish['id']})

async def finish_captures(observer):
    deadline = asyncio.get_running_loop().time() + 10
    if observer.tasks:
        _, pending = await asyncio.wait(list(observer.tasks), timeout=max(0, deadline - asyncio.get_running_loop().time()))
        if pending:
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            observer.result['captureErrors'].append({'code': 'capture_cleanup_deadline'})
    try:
        observer.result['finishedTaskCleanup'] = await observer.finished_owner.drain(deadline)
    except BaseException as error:
        observer.result['failures'].append(module.safe_failure(error))

async def save_trace(session, completion, marker):
    await session.send('Tracing.end')
    event = await asyncio.wait_for(completion, 10)
    chunks, size = [], 0
    try:
        while True:
            part = await session.send('IO.read', {'handle': event['stream'], 'size': 1024 * 1024})
            chunk = base64.b64decode(part['data']) if part.get('base64Encoded') else part['data'].encode('utf-8')
            size += len(chunk)
            module.require(size <= 96 * 1024 * 1024, 'positive_trace_size_limit')
            chunks.append(chunk)
            if part.get('eof'):
                break
    finally:
        await session.send('IO.close', {'handle': event['stream']})
    trace = json.loads(b''.join(chunks))
    if marker is not None:
        trace = redact_marker(trace, marker)
    summary['trace'] = write_new(OUT / 'chromium-trace.json', trace)
    summary['trace']['redaction'] = 'Only tt_probe_case value replaced by its SHA256; original marker never written'
    summary['traceResources'] = [
        {'name': event['name'], 'ts': event.get('ts'), 'pid': event.get('pid'), 'tid': event.get('tid'),
         'data': event.get('args', {}).get('data', {})}
        for event in trace.get('traceEvents', []) if event.get('name') == 'ResourceSendRequest'
        and urlsplit(event.get('args', {}).get('data', {}).get('url', '')).path in ('/api/health', '/api/legal/policy')]

def preserve_failed_case(observer, selected_case, began, errors_exported):
    """Failure evidence is retained even if owner exit or lifecycle validation fails."""
    if observer is None:
        return
    if not errors_exported:
        for key in ERROR_KEYS:
            summary['sourceErrors'][key].extend(observer.result[key])
    target = OUT / 'cases' / (selected_case['id'] + '.json')
    if target.exists():
        return
    events = observer.result.get('closeJournal', [])
    def observed(event, kind=None):
        entries = [entry for entry in events if entry['event'] == event and (kind is None or entry.get('kind') == kind)]
        return entries[0]['at'] if len(entries) == 1 else None
    close_return = observed('close-return')
    original_cases = observer.result.get('cases', [])
    original_status = original_cases[0].get('status') if len(original_cases) == 1 else None
    record = {'caseId': selected_case['id'], 'caseCookieSHA256': getattr(observer, '_probe_case_sha256', None),
              'startedAt': began, 'phaseEnd': observed('phase-end', 'scenario'),
              'unloadStart': observed('unload-start'), 'unloadDone': observed('unload-done'),
              'closeCall': observed('close-call'), 'closeReturn': close_return,
              'observeUntil': close_return + 2 if close_return is not None else None,
              'completed': False, 'status': 'CASE_COLLECTION_FAILED',
              'originalStatus': original_status, 'events': events, 'failureSnapshot': True}
    journal['cases'].append(record)
    observer.result['boundedCallerFailure'] = record
    marker = getattr(observer, '_probe_value', None)
    if marker is not None:
        redact_marker(observer.result, marker)
    ref = write_new(target, observer.result)
    body_store.append(ref)
    counts = {key: len(observer.result[key]) for key in ('layouts', 'held', 'requests', 'responses', 'finished')}
    counts['png'] = len(list(OUT.glob(selected_case['id'] + '-*.png')))
    for key, value in counts.items():
        summary['counts'][key] += value
    summary['contextsCreated'] += observer.result['contextsCreated']
    summary['contextsClosed'] += observer.result['contextsClosed']
    summary['cases'].append({'caseId': selected_case['id'], 'status': 'CASE_COLLECTION_FAILED',
        'originalStatus': original_status, 'caseCookieSHA256': record['caseCookieSHA256'],
        'counts': counts, 'capture': ref, 'failureSnapshot': True})

async def run():
    selected = [row for row in admission['matrix'] if row['network'] == 'offline']
    module.require(len(selected) == 48 and len({row['id'] for row in selected}) == 48, 'exact_offline48_selection')
    if MODE == 'positive':
        selected = [next(row for row in selected if row['id'] == 'en-320-1-offline-normal')]
    summary['selectedCaseIds'] = [row['id'] for row in selected]
    (OUT / 'cases').mkdir()
    browser = trace_session = trace_completion = None
    trace_marker = None
    active_observer = active_case = active_began = None
    active_errors_exported = False
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(executable_path=admission['chromium']['path'], headless=True)
            module.require(browser.version == admission['chromium']['version'], 'actual_chromium_version')
            summary['browserVersion'] = browser.version
            if MODE == 'positive':
                trace_session = await browser.new_browser_cdp_session()
                trace_completion = asyncio.get_running_loop().create_future()
                trace_session.on('Tracing.tracingComplete', lambda event: trace_completion.set_result(event)
                                 if not trace_completion.done() else None)
                await trace_session.send('Tracing.start', {'transferMode': 'ReturnAsStream',
                    'categories': 'devtools.timeline,blink.user_timing,loading'})
            try:
                for selected_case in selected:
                    # Same browser/context options and whole original .case(); bounded collection memory only.
                    active_observer = None
                    active_case = selected_case
                    active_errors_exported = False
                    observer = module.Observer(OUT, admission, raw)
                    active_observer = observer
                    observer.browser = browser
                    observer._old_close_control = MODE == 'positive'
                    began = time.time()
                    active_began = began
                    caught = None
                    with observer.finished_owner:
                        try:
                            await observer.case(selected_case)
                        except BaseException as error:
                            caught = module.safe_failure(error)
                            observer.result['failures'].append(caught)
                        finally:
                            if MODE == 'positive':
                                trace_marker = getattr(observer, '_probe_value', None)
                            for context in list(observer.contexts):
                                try:
                                    await context.close()
                                    observer.result['contextsClosed'] += 1
                                    observer.contexts.remove(context)
                                except BaseException as error:
                                    observer.result['failures'].append(module.safe_failure(error))
                            close_returns = [event['at'] for event in observer.result.get('closeJournal', [])
                                             if event['event'] == 'close-return']
                            if close_returns:
                                await asyncio.sleep(max(0, max(close_returns) + 2 - time.time()))
                            await finish_captures(observer)
                    errors = {key: observer.result[key] for key in ERROR_KEYS}
                    for key in ERROR_KEYS:
                        summary['sourceErrors'][key].extend(errors[key])
                    active_errors_exported = True
                    module.require(len(observer.result['cases']) == 1, 'one_full_case_record')
                    original_case = observer.result['cases'][0]
                    events = observer.result.get('closeJournal', [])
                    def exactly(event, optional=False):
                        matches = [entry for entry in events if entry['event'] == event]
                        module.require(len(matches) == (0 if optional and not matches else 1), 'unique_' + event.replace('-', '_'))
                        return matches[0]['at'] if matches else None
                    close_call, close_return = exactly('close-call'), exactly('close-return')
                    exactly('page-close'); exactly('context-close')
                    phase_ends = [event['at'] for event in events if event['event'] == 'phase-end' and event.get('kind') == 'scenario']
                    module.require(len(phase_ends) == 1, 'unique_scenario_phase_end')
                    marker = observer._probe_value
                    trace_marker = marker if MODE == 'positive' else None
                    identity = observer._probe_case_sha256
                    module.require(all(event['caseId'] == selected_case['id'] and event['caseCookieSHA256'] == identity
                                       for event in events), 'case_bound_lifecycle')
                    module.require(observer.result['contextsCreated'] == observer.result['contextsClosed'] == 1,
                                   'one_context_created_and_closed')
                    complete = (caught is None and not any(errors.values())
                                and original_case['status'] == 'CASE_COLLECTION_COMPLETE_UNQUALIFIED')
                    if MODE == 'main':
                        unload_start, unload_done = exactly('unload-start'), exactly('unload-done')
                        module.require(phase_ends[0] <= unload_start <= unload_done <= close_call <= close_return,
                                       'unload_before_close_order')
                        phase = [row for row in observer.result['phases'] if row['name'] == 'teardown-unload']
                        module.require(len(phase) == 1 and phase[0]['captured'] is True, 'unload_phase_captured')
                    else:
                        unload_start = unload_done = None
                        exactly('unload-skipped')
                    export_api(observer)
                    record = {'caseId': selected_case['id'], 'caseCookieSHA256': identity,
                              'startedAt': began, 'phaseEnd': phase_ends[0], 'unloadStart': unload_start,
                              'unloadDone': unload_done, 'closeCall': close_call, 'closeReturn': close_return,
                              'observeUntil': close_return + 2, 'completed': complete,
                              'status': 'CASE_COLLECTION_COMPLETE' if complete else 'CASE_COLLECTION_FAILED',
                              'originalStatus': original_case['status'], 'events': events}
                    journal['cases'].append(record)
                    observer.result['boundedCaller'] = {'mode': MODE, 'collectionOnly': True,
                        'matrix96AdmissionUnchanged': True, 'record': record}
                    redact_marker(observer.result, marker)
                    ref = write_new(OUT / 'cases' / (selected_case['id'] + '.json'), observer.result)
                    body_store.append(ref)
                    case_png = len(list(OUT.glob(selected_case['id'] + '-*.png')))
                    counts = {key: len(observer.result[key]) for key in ('layouts', 'held', 'requests', 'responses', 'finished')}
                    counts['png'] = case_png
                    for key, value in counts.items():
                        summary['counts'][key] += value
                    summary['contextsCreated'] += observer.result['contextsCreated']
                    summary['contextsClosed'] += observer.result['contextsClosed']
                    summary['cases'].append({'caseId': selected_case['id'], 'status': record['status'],
                        'originalStatus': original_case['status'], 'caseCookieSHA256': identity, 'counts': counts, 'capture': ref})
                    print(json.dumps({'mode': MODE, 'case': selected_case['id'], 'status': record['status'],
                                      'done': len(summary['cases']), 'total': len(selected)}), flush=True)
                    module.require(complete, 'case_collection_errors')
                    # All original checks/captures have completed and evidence is written.
                    active_observer = None
                    del observer
                    gc.collect()
            finally:
                try:
                    if trace_session is not None:
                        await save_trace(trace_session, trace_completion, trace_marker)
                finally:
                    await browser.close()
                    summary['browserClosed'] = True
            expected = 48 if MODE == 'main' else 1
            module.require(len(summary['cases']) == expected
                           and summary['contextsCreated'] == summary['contextsClosed'] == expected
                           and not any(summary['sourceErrors'].values()), 'bounded_collection_complete')
            if MODE == 'main':
                module.require(summary['counts']['layouts'] == 48 and summary['counts']['held'] == 540
                               and summary['counts']['png'] == 588, 'original_offline_half_counts')
            summary['status'] = 'CASE_COLLECTION_COMPLETE'
    except BaseException as error:
        summary['status'] = 'CASE_COLLECTION_FAILED'
        summary['errors'].append(module.safe_failure(error))
        try:
            preserve_failed_case(active_observer, active_case, active_began, active_errors_exported)
        except BaseException as evidence_error:
            summary['errors'].append(module.safe_failure(evidence_error))
    finally:
        summary['cookieRedactions'] = redaction_count
        summary['finishedAt'] = time.time()
        api['errors'] = summary['errors'] + [error for rows in summary['sourceErrors'].values() for error in rows]
        journal['errors'] = api['errors']
        write_new(OUT / 'api-browser.json', api)
        write_new(OUT / 'case-journal.json', journal)
        with (OUT / 'body-store.jsonl').open('x', encoding='utf-8') as handle:
            for ref in body_store:
                handle.write(json.dumps(ref) + '\n')
        write_new(OUT / 'browser-summary.json', summary)
        print(json.dumps({'mode': MODE, 'status': summary['status'], 'cases': len(summary['cases']),
                          'errors': len(api['errors']), 'browserClosed': summary['browserClosed']}), flush=True)
    return summary['status'] == 'CASE_COLLECTION_COMPLETE'

async def owned_run():
    running = asyncio.create_task(run())
    async def stop():
        while not running.done():
            marker = OUT / 'stop.request.json'
            if marker.exists():
                try:
                    value = json.loads(marker.read_bytes())
                    module.require(value.get('mode') == MODE and value.get('reason') == 'OWN_RUNNER_FINALLY', 'owned_stop_identity')
                except BaseException as error:
                    summary['errors'].append(module.safe_failure(error))
                running.cancel()
                return
            await asyncio.sleep(.05)
    watcher = asyncio.create_task(stop())
    try:
        return await running
    finally:
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)

raise SystemExit(0 if asyncio.run(owned_run()) else 1)
