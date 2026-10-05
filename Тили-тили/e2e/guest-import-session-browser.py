"""Chromium component/API-client acceptance; controlled HTTP, no PostgreSQL claims."""
from __future__ import annotations
import asyncio
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

from playwright.async_api import async_playwright, expect

APP = Path(__file__).resolve().parents[1] / 'app'
OUT = Path(os.environ['E2E_RESULT_DIR']).resolve()
BASE = 'http://127.0.0.1:4179'
FIXTURE = '''import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { GuestImportPanel } from './src/components/GuestImportPanel'
import { saveTokens } from './src/lib/api/client'
import { setI18nLang, t } from './src/lib/i18n'
import './src/index.css'
const lang = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'ru'
setI18nLang(lang)
const tokens = (sub: string, sid: string, exp = 2000000000) => ({
  accessToken: `e30.${btoa(JSON.stringify({sub, sid, exp}))}.test`, refreshToken: `test-${sid}-${exp}`,
})
saveTokens(tokens('browser-a', 'browser-a'))
;(window as unknown as {ttLabel: typeof t}).ttLabel = t
function Fixture() {
  const [open, setOpen] = useState(true)
  const [wedding, setWedding] = useState('browser-w1')
  const [refreshes, setRefreshes] = useState(0)
  return <main style={{maxWidth: 480, margin: 'auto'}}>
    <nav style={{display:'flex',flexWrap:'wrap',gap:8,padding:8}}>
      <button data-testid="renew" onClick={() => saveTokens(tokens('browser-a', 'browser-a', 2000000300))}>Renew</button>
      <button data-testid="account" onClick={() => saveTokens(tokens('browser-b', 'browser-b'))}>Switch session</button>
      <button data-testid="wedding" onClick={() => setWedding('browser-w2')}>Switch wedding</button>
      <button data-testid="toggle" onClick={() => setOpen(value => !value)}>Toggle</button>
      <output data-testid="refreshes">{refreshes}</output>
    </nav>
    <GuestImportPanel weddingId={wedding} existing={[]} open={open}
      onClose={() => setOpen(false)} onImported={() => setRefreshes(value => value + 1)} />
  </main>
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>)
'''
HTML = '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/ci-import-session-fixture.tsx"></script></body></html>'


def digest() -> dict[str, str]:
    names = ['src/components/GuestImportPanel.tsx', 'src/lib/api/client.ts',
             'src/lib/guestImportDraft.ts', 'src/lib/guestsImport.ts', 'src/index.css',
             'src/lib/i18n.ts', 'src/lib/i18n.en.ts']
    return {name: hashlib.sha256((APP / name).read_bytes()).hexdigest() for name in names}


async def scenario(browser, lang, width, report):
    context = await browser.new_context(viewport={'width': width, 'height': 900})
    page = await context.new_page()
    page.set_default_timeout(10000)
    calls = []
    errors = []
    response_gate = asyncio.Event()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
    label = f'{lang}-{width}'
    async def command(route):
        if route.request.method != 'POST' or not route.request.url.endswith('/guests/import'):
            errors.append('Unexpected API request: ' + route.request.method + ' ' + route.request.url)
            await route.fulfill(status=500, json={'error': {'code': 'unexpected', 'message': 'Unexpected fixture request'}})
            return
        calls.append({'url': route.request.url, 'body': route.request.post_data_json})
        if len(calls) == 1:
            await response_gate.wait()
        size = 2 if len(calls) == 1 else 1
        await route.fulfill(status=201, json={'created': [{'id': f'fixture-{len(calls)}', 'name': 'Test', 'partySize': size}], 'skipped': []})
    # Match the API root only; /src/lib/api/client.ts is a Vite source asset.
    await context.route(BASE + '/api/**', command)
    try:
        await page.goto(BASE + '/ci-import-session.html?lang=' + lang)
        await page.get_by_test_id('renew').wait_for()
        async def tr(key):
            return await page.evaluate('key => window.ttLabel(key)', key)
        async def blank():
            await expect(page.get_by_role('textbox', name=await tr('Список гостей'), exact=True)).to_have_value('')
            await expect(page.get_by_role('textbox', name=await tr('Основной человек'), exact=True)).to_have_count(0)
            assert '+79170001122' not in (await page.locator('body').inner_text())
        await page.get_by_role('textbox', name=await tr('Список гостей'), exact=True).fill('Анна, +79170001122')
        await page.get_by_role('button', name=await tr('Проверить и дополнить'), exact=True).click()
        await page.get_by_role('button', name=await tr('Добавить человека в семью'), exact=True).click()
        member = page.get_by_role('textbox', name=(await tr('Человек семьи')) + ' 2', exact=True)
        await member.fill('Борис')
        await page.get_by_test_id('toggle').click()
        await page.get_by_test_id('toggle').click()
        await expect(member).to_have_value('Борис')
        await page.get_by_test_id('renew').click()
        await expect(member).to_have_value('Борис')
        geometry = await page.evaluate('({viewport: innerWidth, document: document.documentElement.scrollWidth})')
        assert geometry['document'] <= geometry['viewport'], geometry
        await page.screenshot(path=str(OUT / (label + '-family.png')), full_page=True)
        async with page.expect_response(lambda response: response.request.method == 'POST' and response.url.endswith('/guests/import')) as response_info:
            await page.get_by_role('button', name=await tr('Импортировать приглашения'), exact=True).click()
            await expect(page.get_by_text(await tr('Добавляем…'), exact=True)).to_be_visible()
            await page.get_by_test_id('account').click()
            await blank()
            response_gate.set()
        response = await response_info.value
        await response.finished()
        await page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        await expect(page.get_by_test_id('refreshes')).to_have_text('0')
        await blank()
        assert calls[0]['body'] == {'guests': [{'name': 'Анна', 'phone': '+79170001122', 'members': [{'name': 'Борис'}]}]}
        await page.screenshot(path=str(OUT / (label + '-cleared.png')), full_page=True)
        await page.get_by_role('textbox', name=await tr('Список гостей'), exact=True).fill('Вера')
        await page.get_by_role('button', name=await tr('Проверить и дополнить'), exact=True).click()
        await page.get_by_role('button', name=await tr('Импортировать приглашения'), exact=True).click()
        await expect(page.get_by_test_id('refreshes')).to_have_text('1')
        assert len(calls) == 2 and calls[1]['body'] == {'guests': [{'name': 'Вера'}]}, calls
        await page.get_by_test_id('wedding').click()
        await blank()
        assert not errors, errors
        report['passed'].append({'case': label, 'checks': ['family-edit', 'close-reopen', 'same-session-renewal', 'pending-session-change', 'late-response-no-refresh', 'clean-new-import', 'wedding-change', 'no-overflow'], 'posts': len(calls), 'geometry': geometry})
    finally:
        response_gate.set()
        report['errors'].extend({'case': label, 'error': error} for error in errors)
        await context.close()


async def browser_checks(report):
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch()
        try:
            for lang in ('ru', 'en'):
                for width in (320, 390, 1280):
                    await scenario(browser, lang, width, report)
        finally:
            await browser.close()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'kind': 'real Chromium and real component/API-client; controlled HTTP; not database or physical-device acceptance', 'passed': [], 'errors': [], 'source_before': digest()}
    html = APP / 'ci-import-session.html'
    script = APP / 'ci-import-session-fixture.tsx'
    if html.exists() or script.exists():
        raise RuntimeError('Refuse to overwrite existing browser fixture paths')
    process = None
    code = 0
    try:
        html.write_text(HTML, encoding='utf-8')
        script.write_text(FIXTURE, encoding='utf-8')
        with (OUT / 'vite.log').open('w') as log:
            process = subprocess.Popen(['node', 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4179', '--strictPort'], cwd=APP, env={**os.environ, 'VITE_API_URL': '/api'}, stdout=log, stderr=subprocess.STDOUT)
            ready = False
            for _ in range(60):
                if process.poll() is not None:
                    break
                try:
                    with urllib.request.urlopen(BASE + '/ci-import-session.html', timeout=1) as response:
                        ready = response.status == 200
                    if ready:
                        break
                except OSError:
                    pass
                time.sleep(0.25)
            if not ready:
                raise RuntimeError('Loopback Vite fixture did not become ready')
            asyncio.run(browser_checks(report))
    except Exception as error:
        code = 1
        report['failure'] = str(error)
    finally:
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
        html.unlink(missing_ok=True)
        script.unlink(missing_ok=True)
        report['source_after'] = digest()
        if report['source_before'] != report['source_after']:
            code = 1
            report['failure'] = 'Source bytes changed during the browser run'
        report['result'] = 'passed' if code == 0 and len(report['passed']) == 6 and not report['errors'] else 'failed'
        (OUT / 'browser-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'result': report['result'], 'cases': len(report['passed'])}))
    return 0 if report['result'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
