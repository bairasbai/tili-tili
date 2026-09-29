"""Timeline 021 acceptance against a real disposable API and PostgreSQL.
No routes are mocked. Fixture credentials are excluded from published evidence.
"""
import json
import os
import pathlib
import re
import traceback
import uuid
from datetime import datetime
from playwright.sync_api import sync_playwright, expect

fixture = json.loads(pathlib.Path(os.environ['E2E_FIXTURE_FILE']).read_text())
out = pathlib.Path(os.environ['E2E_RESULT_DIR'])
out.mkdir(parents=True, exist_ok=True)
api = 'http://127.0.0.1:3001'
ui = 'http://127.0.0.1:3000'
path = '/weddings/' + fixture['weddingId'] + '/timeline'
result = {'passed': [], 'page_errors': []}


def redact(value):
    text = str(value)
    for key in ('owner', 'helper'):
        for token in fixture[key]['tokens'].values():
            if isinstance(token, str) and len(token) > 20:
                text = text.replace(token, '[redacted]')
    return re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[redacted-token]', text)


def headers(person):
    return {'authorization': 'Bearer ' + person['tokens']['accessToken']}


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    pages = {}
    try:
        def session(person):
            context = browser.new_context(viewport={'width': 390, 'height': 844})
            storage = {
                'tt_auth': json.dumps({key: person['tokens'][key] for key in ('accessToken', 'refreshToken')}),
                'tt_onboarded': '1', 'tt_wedding_id': json.dumps(fixture['weddingId']),
                'tt_wedding_date': json.dumps('2027-06-14'),
            }
            context.add_init_script('for (const [key,value] of Object.entries(%s)) { if (!localStorage.getItem(key)) localStorage.setItem(key,value); }' % json.dumps(storage))
            return context

        owner = session(fixture['owner'])
        helper = session(fixture['helper'])

        def snapshot(context=owner, person=fixture['owner']):
            response = context.request.get(api + path, headers=headers(person))
            assert response.status == 200, response.status
            etag = response.headers.get('etag')
            assert etag and re.fullmatch(r'"timeline-[1-9][0-9]*"', etag), etag
            return response.json(), etag

        def put(events, etag):
            return owner.request.put(api + path, headers={**headers(fixture['owner']), 'if-match': etag}, data=events)

        _, etag = snapshot()
        assert put([], etag).status == 200
        page = owner.new_page()
        pages['owner'] = page
        page.on('pageerror', lambda error: result['page_errors'].append(redact(error)))
        page.goto(ui + '/wedding/timeline', wait_until='networkidle')
        expect(page.get_by_text('Тайминг пуст — добавьте событие или соберите автоплан по команде', exact=True)).to_be_visible()

        def edit(current):
            button = current.get_by_role('button', name='Править', exact=True)
            if button.is_visible():
                button.click()
            expect(current.get_by_role('button', name='Добавить в тайминг', exact=True)).to_be_enabled()

        def save(current, action, status=200):
            with current.expect_response(lambda r: r.url.endswith(path) and r.request.method == 'PUT') as pending:
                action()
            response = pending.value
            assert response.status == status, (response.status, redact(response.text())[:300])
            current.wait_for_load_state('networkidle')
            return response

        def row(current, name):
            return current.locator('div.card-s').filter(has=current.get_by_text(name, exact=True))

        for name, start, end, fixed in [
            ('E2E Фотосессия', '10:00', '11:00', False),
            ('E2E Церемония', '12:00', '13:00', True),
        ]:
            edit(page)
            page.get_by_placeholder('Событие (например, «Первый танец»)').fill(name)
            page.get_by_label('Начало', exact=True).fill(start)
            page.get_by_label('Конец', exact=True).fill(end)
            page.get_by_label('Фиксированное время — не сдвигать автоматически', exact=True).set_checked(fixed)
            save(page, lambda: page.get_by_role('button', name='Добавить в тайминг', exact=True).click())
            expect(row(page, name)).to_be_visible()
        result['passed'].append('create-two-blocks-through-mobile-ui')
        events, _ = snapshot()
        ids = [event['id'] for event in events]
        assert len(ids) == len(set(ids)) == 2
        parent_id, child_id = ids
        page.reload(wait_until='networkidle')
        assert [event['id'] for event in snapshot()[0]] == ids
        expect(row(page, 'E2E Церемония').get_by_text('фиксированное время', exact=True)).to_be_visible()
        result['passed'].append('server-ids-and-fixed-mode-survive-reload')

        edit(page)
        child = row(page, 'E2E Церемония')
        save(page, lambda: child.locator('select').nth(0).select_option(fixture['helper']['id']))
        save(page, lambda: child.locator('select').nth(2).select_option(parent_id))
        assert snapshot()[0][1]['assigneeUserIds'] == [fixture['helper']['id']]
        result['passed'].append('assign-team-member-and-prerequisite-through-ui')
        for label in ('Дорога, мин', 'Запас, мин'):
            field = child.get_by_label(label, exact=True)
            field.fill('15')
            save(page, lambda: field.press('Tab'))
        assert snapshot()[0][1]['dependsOn'] == [{'eventId': parent_id, 'travelMinutes': 15, 'bufferMinutes': 15}]
        result['passed'].append('travel-and-buffer-persist')
        save(page, lambda: row(page, 'E2E Фотосессия').get_by_label('Показывать гостям', exact=True).uncheck())
        assert snapshot()[0][0]['forGuests'] is False
        result['passed'].append('guest-visibility-persists')

        before, _ = snapshot()
        shifted = owner.request.post(api + path + '/shift', headers={**headers(fixture['owner']), 'idempotency-key': str(uuid.uuid4())}, data={'minutes': 15})
        assert shifted.status == 200
        after, _ = snapshot()
        assert [event['id'] for event in after] == ids
        parse = lambda value: datetime.fromisoformat(value.replace('Z', '+00:00'))
        assert (parse(after[0]['startsAt']) - parse(before[0]['startsAt'])).total_seconds() == 900
        assert after[1]['startsAt'] == before[1]['startsAt']
        result['passed'].append('day-shift-preserves-fixed-event-and-ids')
        page.reload(wait_until='networkidle')
        second = helper.new_page()
        pages['helper'] = second
        second.on('pageerror', lambda error: result['page_errors'].append(redact(error)))
        second.goto(ui + '/wedding/timeline', wait_until='networkidle')
        edit(page)
        edit(second)
        save(page, lambda: row(page, 'E2E Фотосессия').get_by_role('button', name='Зафиксировать время', exact=True).click())
        winning, winning_etag = snapshot()
        save(second, lambda: row(second, 'E2E Церемония').get_by_label('Показывать гостям', exact=True).uncheck(), 409)
        expect(second.get_by_text('Тайминг изменился. Обновляем расписание; автоплан нужно собрать заново.', exact=True)).to_be_visible()
        assert snapshot() == (winning, winning_etag)
        result['passed'].append('two-browser-sessions-reject-stale-write')

        second.get_by_role('button', name=re.compile('Собрать автоплан по команде')).click()
        apply = second.get_by_role('button', name='Заменить тайминг', exact=True)
        expect(apply).to_be_enabled()
        fresh, fresh_etag = snapshot()
        fresh[1]['name'] = 'E2E Новая церемония'
        assert put(fresh, fresh_etag).status == 200
        winner = snapshot()
        save(second, apply.click, 409)
        assert snapshot() == winner
        result['passed'].append('preview-retains-its-original-version')
        expect(apply).to_be_enabled()
        save(second, apply.click, 409)
        assert snapshot() == winner
        result['passed'].append('refetch-does-not-authorize-stale-preview')

        current, current_etag = snapshot()
        current[0]['dependsOn'] = [{'eventId': child_id, 'travelMinutes': 0, 'bufferMinutes': 0}]
        assert put(current, current_etag).status == 422
        assert snapshot() == winner
        result['passed'].append('cyclic-graph-is-atomic-rejection')
        missing = owner.request.put(api + path, headers=headers(fixture['owner']), data=[])
        assert missing.status == 428
        assert snapshot() == winner
        result['passed'].append('version-is-required-with-no-data-loss')
        forbidden = helper.request.post(api + path + '/shift', headers={**headers(fixture['helper']), 'idempotency-key': str(uuid.uuid4())}, data={'minutes': 15})
        assert forbidden.status == 403
        result['passed'].append('helper-cannot-command-day-shift')

        guest = owner.request.post(api + '/weddings/' + fixture['weddingId'] + '/guests', headers=headers(fixture['owner']), data={'name': 'Гость E2E'})
        assert guest.status == 201
        link = owner.request.post(api + '/weddings/' + fixture['weddingId'] + '/guests/' + guest.json()['id'] + '/invite-link', headers=headers(fixture['owner']))
        assert link.status == 200
        code = link.json()['url'].rsplit('/', 1)[-1]
        exchange = owner.request.get(api + '/invite/' + code)
        assert exchange.status == 200
        day = owner.request.get(api + '/join/' + exchange.json()['guestToken'] + '/day')
        assert day.status == 200
        public = day.json()['timeline']
        assert [event['id'] for event in public] == [child_id]
        assert all(not {'assigneeUserIds', 'dealIds', 'dependsOn', 'timingMode'} & set(event) for event in public)
        result['passed'].append('guest-projection-does-not-leak-organizer-metadata')
        page.reload(wait_until='networkidle')
        page.screenshot(path=str(out / 'timeline-mobile.png'), full_page=True)
        assert not result['page_errors'], result['page_errors']
        result['status'] = 'passed'
    except Exception:
        result['status'] = 'failed'
        result['error'] = redact(traceback.format_exc())
        for name, current in pages.items():
            try:
                current.screenshot(path=str(out / (name + '-failure.png')), full_page=True)
            except Exception:
                pass
        raise
    finally:
        (out / 'timeline-browser-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        browser.close()
