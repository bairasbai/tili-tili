"""SC-007: real Chromium -> existing API -> disposable PostgreSQL.

Only transport delivery is interrupted. No JSON response, SQL implementation,
component, API client or authentication handler is replaced by a mock.
"""
import asyncio
import json
import os
import pathlib
import re
import traceback
from playwright.async_api import async_playwright, expect

BASE = 'http://127.0.0.1:3000'
API = 'http://127.0.0.1:3001'
OUT = pathlib.Path(os.environ['E2E_RESULT_DIR'])
OUT.mkdir(parents=True, exist_ok=True)
fixture = json.loads(pathlib.Path(os.environ['E2E_FIXTURE_FILE']).read_text())
wedding = fixture['weddingId']
PATH = f'/weddings/{wedding}/guests'
result = {'passed': [], 'page_errors': [], 'console_errors': [], 'expected_transport_errors': [], 'route_errors': [], 'cases': []}
WORDS = {
    'ru': {'bulk': 'Добавить списком', 'list': 'Список гостей', 'review': 'Проверить и дополнить',
           'add': 'Добавить человека в семью', 'person': 'Человек семьи', 'primary': 'Основной человек',
           'submit': 'Импортировать приглашения', 'retry': 'Повторить тот же импорт',
           'created': 'Создано приглашений:', 'people': 'Создано персон:',
           'named': 'Указать имя вместо +1', 'close': 'Закрыть без потери попытки', 'group': 'Состав приглашения', 'duplicate': 'уже в списке'},
    'en': {'bulk': 'Add as a list', 'list': 'Guest list', 'review': 'Review and complete',
           'add': 'Add family member', 'person': 'Family member', 'primary': 'Primary person',
           'submit': 'Import invitations', 'retry': 'Retry the same import',
           'created': 'Invitations created:', 'people': 'People created:',
           'named': 'Name the +1 companion', 'close': 'Close and keep attempt', 'group': 'Invitation members', 'duplicate': 'already on the list'},
}

def checked(response, status, label):
    if response.status != status:
        raise AssertionError(f'{label}: expected HTTP {status}, received {response.status}')
    return response

def record(case, check, **details):
    result['passed'].append({'case': case, 'check': check, **details})

async def run_case(browser, api, lang, width):
    case = f'{lang}-{width}'
    w = WORDS[lang]
    prefix = f'E2E{lang}{width}'
    context = await browser.new_context(viewport={'width': width, 'height': 844})
    setup = {'tokens': fixture['owner']['tokens'], 'weddingId': wedding, 'lang': lang}
    await context.add_init_script('''(() => {
      const f = %s;
      localStorage.setItem('tt_auth', JSON.stringify({accessToken:f.tokens.accessToken,refreshToken:f.tokens.refreshToken}));
      localStorage.setItem('tt_onboarded', '1');
      localStorage.setItem('tt_wedding_id', JSON.stringify(f.weddingId));
      localStorage.setItem('tt_lang', f.lang);
    })();''' % json.dumps(setup))
    page = await context.new_page()
    page.on('pageerror', lambda error: result['page_errors'].append(f'{case}: {error}'))
    def console_message(message):
        if message.type != 'error':
            return
        # Only the two deliberately interrupted import deliveries are expected.
        # Unrelated console errors must fail acceptance rather than disappear.
        expected = message.text in (
            'Failed to load resource: net::ERR_INTERNET_DISCONNECTED',
            'Failed to load resource: net::ERR_CONNECTION_RESET',
        ) and message.location.get('url') == BASE + '/api' + PATH + '/import'
        bucket = 'expected_transport_errors' if expected else 'console_errors'
        result[bucket].append({'case': case, 'message': message.text, 'url': message.location.get('url')})
    page.on('console', console_message)
    commands = []
    responses = []
    fault = {'next': None}

    async def intercept(route):
        commands.append(route.request.post_data_json)
        mode = fault['next']
        fault['next'] = None
        try:
            if mode == 'before':
                await route.abort('internetdisconnected')
                return
            response = await route.fetch(max_retries=0, max_redirects=0)
            checked(response, 201, 'real import response')
            data = await response.json()
            responses.append(data)
            if mode == 'after':
                # The real API already returned 201 after the DB transaction.
                # Intentionally do not deliver that result to the application.
                await route.abort('connectionreset')
            else:
                await route.fulfill(response=response)
            await response.dispose()
        except Exception as error:
            result['route_errors'].append(f'{case}: {type(error).__name__}: {error}')
            try:
                await route.abort('failed')
            except Exception:
                pass

    await page.route(BASE + '/api' + PATH + '/import', intercept)

    async def get_guests():
        response = checked(await api.get(PATH), 200, 'fresh guest read')
        data = await response.json()
        assert isinstance(data, list)
        return data

    async def fresh(text):
        async with page.expect_response(lambda r: r.request.method == 'GET' and r.url.endswith('/api' + PATH)):
            await page.goto(BASE + '/wedding/guests', wait_until='domcontentloaded')
        await page.get_by_role('button', name=w['bulk'], exact=True).click()
        panel = page.get_by_role('region', name=w['bulk'], exact=True)
        await panel.get_by_role('textbox', name=w['list'], exact=True).fill(text)
        await panel.get_by_role('button', name=w['review'], exact=True).click()
        return panel

    async def add_member(panel, name, number=2):
        await panel.get_by_role('button', name=w['add'], exact=True).click()
        await panel.get_by_role('textbox', name=f"{w['person']} {number}", exact=True).fill(name)

    async def totals(panel, invitations, persons):
        await expect(panel.get_by_text(f"{w['created']} {invitations}", exact=True)).to_be_visible()
        await expect(panel.get_by_text(f"{w['people']} {persons}", exact=True)).to_be_visible()

    async def screenshot(name):
        await page.screenshot(path=str(OUT / f'{case}-{name}.png'), full_page=True)
        overflow = await page.evaluate('document.documentElement.scrollWidth > innerWidth + 1')
        assert not overflow, f'{case}/{name}: horizontal overflow'

    try:
        # The two possible outcomes of response loss must be tested separately.
        for mode in ['before', 'after']:
            name, member = f'{prefix} {mode} Primary', f'{prefix} {mode} Member'
            before = await get_guests()
            panel = await fresh(name)
            await add_member(panel, member)
            start = len(commands)
            fault['next'] = mode
            await panel.get_by_role('button', name=w['submit'], exact=True).click()
            await expect(panel.get_by_role('button', name=w['retry'], exact=True)).to_be_visible()
            await expect(panel.get_by_role('textbox', name=w['primary'], exact=True)).to_be_disabled()
            await expect(panel.get_by_text(f"{w['created']} 1", exact=True)).to_have_count(0)
            assert len(commands) == start + 1, 'Unexpected automatic POST retry'
            stored = await get_guests()
            family = [g for g in stored if g['name'] in [name, member]]
            assert len(family) == (2 if mode == 'after' else 0)
            captured = commands[-1]
            assert captured == {'guests': [{'name': name, 'members': [{'name': member}]}]}
            if mode == 'after':
                await panel.get_by_role('button', name=w['close'], exact=True).click()
                await page.get_by_role('button', name=w['bulk'], exact=True).click()
                await expect(panel.get_by_role('textbox', name=w['primary'], exact=True)).to_have_value(name)
            await screenshot(mode + '-unknown')
            # A real same-tick double click must result in one replay command.
            await panel.get_by_role('button', name=w['retry'], exact=True).evaluate('(b) => { b.click(); b.click(); }')
            await totals(panel, 0 if mode == 'after' else 1, 0 if mode == 'after' else 2)
            assert len(commands) == start + 2
            assert commands[-1] == captured
            final = await get_guests()
            assert len(final) == len(before) + 2
            final_family = [g for g in final if g['name'] in [name, member]]
            assert len(final_family) == 2 and len({g['partyId'] for g in final_family}) == 1
            assert sorted(g['partyPosition'] for g in final_family) == [1, 2]
            if mode == 'after':
                assert {g['id'] for g in family} == {g['id'] for g in final_family}
                assert responses[-1]['created'] == []
                assert responses[-1]['skipped'] == [{'index': 0, 'name': name, 'reason': 'duplicate'}]
            await screenshot(mode + '-confirmed')
            record(case, f'{mode}-commit-loss-exact-retry-no-duplicates', persons=2, commands=2)

        # Race a fresh server row against the already reviewed client preview.
        new_name, rival = f'{prefix} Partial New', f'{prefix} Partial Rival'
        panel = await fresh(f'А\n{new_name}\n{rival}')
        checked(await api.post(PATH + '/import', data={'guests': [{'name': rival}]}), 201, 'competing import')
        await panel.get_by_role('button', name=w['submit'], exact=True).click()
        await totals(panel, 1, 1)
        inputs = panel.get_by_role('textbox', name=w['primary'], exact=True)
        assert await inputs.count() == 2
        assert [await inputs.nth(i).input_value() for i in range(2)] == ['А', rival]
        assert responses[-1]['skipped'] == [{'index': 1, 'name': rival, 'reason': 'duplicate'}]
        await expect(panel.get_by_role('group', name=f"{w['group']} 3", exact=True).get_by_text(w['duplicate'], exact=True)).to_be_visible()
        await screenshot('partial')
        await inputs.nth(0).fill(f'{prefix} Corrected')
        await panel.get_by_role('button', name=w['submit'], exact=True).click()
        await totals(panel, 1, 1)
        assert commands[-1] == {'guests': [{'name': f'{prefix} Corrected'}]}
        record(case, 'partial-result-filtered-index-and-explicit-correction')

        # Named and unnamed compatibility flows materialize actual person rows.
        for named in [False, True]:
            name = f'{prefix} Legacy {named}'
            panel = await fresh(name + ',+1')
            if named:
                await panel.get_by_role('button', name=w['named'], exact=True).click()
                await expect(panel.get_by_role('button', name=w['submit'], exact=True)).to_be_disabled()
                await panel.get_by_role('textbox', name=f"{w['person']} 2", exact=True).fill(name + ' Member')
            await panel.get_by_role('button', name=w['submit'], exact=True).click()
            await totals(panel, 1, 2)
            all_guests = await get_guests()
            primary = next(g for g in all_guests if g['name'] == name)
            party = [g for g in all_guests if g['partyId'] == primary['partyId']]
            assert len(party) == 2 and primary['partySize'] == 2
            assert sum(g['isPlaceholder'] for g in party) == (0 if named else 1)
            record(case, 'legacy-plus-one-named' if named else 'legacy-plus-one-materialized')

        # Full family boundary and same-family duplicates use the real component.
        name = f'{prefix} Full Family'
        panel = await fresh(name)
        await add_member(panel, name)
        await expect(panel.get_by_role('button', name=w['submit'], exact=True)).to_be_disabled()
        await panel.get_by_role('textbox', name=f"{w['person']} 2", exact=True).fill(name + ' 2')
        for n in range(3, 11):
            await add_member(panel, name + f' {n}', n)
        await expect(panel.get_by_role('button', name=w['add'], exact=True)).to_be_disabled()
        await screenshot('ten-person-preview')
        await panel.get_by_role('button', name=w['submit'], exact=True).click()
        await totals(panel, 1, 10)
        all_guests = await get_guests()
        primary = next(g for g in all_guests if g['name'] == name)
        party = [g for g in all_guests if g['partyId'] == primary['partyId']]
        assert len(party) == 10 and all(g['partySize'] == 10 for g in party)
        record(case, 'ten-person-boundary-and-family-duplicate')
        result['cases'].append({'language': lang, 'width': width, 'browser_import_commands': len(commands)})
    except Exception:
        await page.screenshot(path=str(OUT / f'{case}-failure.png'), full_page=True)
        raise
    finally:
        await context.close()

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        api = await p.request.new_context(base_url=API, extra_http_headers={
            'authorization': 'Bearer ' + fixture['owner']['tokens']['accessToken']})
        try:
            for lang in ['ru', 'en']:
                for width in [320, 390, 1280]:
                    await run_case(browser, api, lang, width)
            # Real partial validation: one invalid row does not roll back a good one.
            response = checked(await api.post(PATH + '/import', data={'guests': [
                {'name': '  '}, {'name': 'E2E Server Valid'}]}), 201, 'partial server validation')
            data = await response.json()
            assert len(data['created']) == 1 and data['skipped'] == [{'index': 0, 'name': '  ', 'reason': 'invalid'}]
            record('server', 'invalid-row-does-not-hide-success')
            # Two actual parallel commands on the same transaction-locked wedding.
            body = {'guests': [{'name': 'E2E Concurrent Primary', 'members': [{'name': 'E2E Concurrent Member'}]}]}
            replies = await asyncio.gather(api.post(PATH + '/import', data=body), api.post(PATH + '/import', data=body))
            data = [await checked(reply, 201, 'concurrent import').json() for reply in replies]
            assert sorted(len(item['created']) for item in data) == [0, 1]
            assert sorted(len(item['skipped']) for item in data) == [0, 1]
            record('server', 'concurrent-exact-import-single-family')
            final = await (await api.get(PATH)).json()
            result['expected_db_persons'] = len(final)
            result['expected_db_parties'] = len({g['partyId'] for g in final})
            assert len(final) == 129 and result['expected_db_parties'] == 50
            assert len(result['passed']) == 38
            assert not result['page_errors'] and not result['route_errors'] and not result['console_errors']
            assert len(result['expected_transport_errors']) == 12
        finally:
            await api.dispose()
            await browser.close()

try:
    asyncio.run(main())
    result['status'] = 'passed'
except Exception:
    result['status'] = 'failed'
    result['error'] = re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[redacted-token]', traceback.format_exc())
    raise
finally:
    (OUT / 'recovery-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({'status': result.get('status'), 'passed': len(result['passed']), 'page_errors': len(result['page_errors'])}))
