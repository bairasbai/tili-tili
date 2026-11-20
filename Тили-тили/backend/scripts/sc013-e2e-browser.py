import json
import os
import re
import sys
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


UI = 'http://127.0.0.1:3000'
ADDRESS = 'Уфа, резервный павильон SC-013'
ACTION = 'Встретить гостей у входа SC-013'
CONTACT = 'private-sc013@example.test'
COORDINATOR = 'Координатор SC-013'
HELPER = 'Помощник SC-013'
NOTICE = 'Активирован план Б'
WARNING = 'Web Push не подключён. Уведомления доступны в приложении.'
FIXTURE = json.loads(Path(os.environ['E2E_FIXTURE_FILE']).read_text(encoding='utf-8'))['sc013']


def page_for(browser, errors, tokens=None, lang='ru'):
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    if tokens:
        context.add_init_script(f"""if (!localStorage.getItem('tt_auth')) {{
          localStorage.setItem('tt_auth', JSON.stringify({json.dumps(tokens)}));
          localStorage.setItem('tt_onboarded', '1');
        }}""")
    context.add_init_script(f"localStorage.setItem('tt_lang', {json.dumps(lang)})")
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(type(error).__name__))
    return page


def request(page, tokens, method, path, status, *, data=None, key=None):
    headers = {'Authorization': 'Bearer ' + tokens['accessToken']}
    if key:
        headers['Idempotency-Key'] = key
    response = page.request.fetch(UI + '/api' + path, method=method, headers=headers, data=data)
    assert response.status == status, f'{method} {path} returned {response.status}, expected {status}'
    return response.json() if status != 204 else None


def invite(owner, path, browser, errors, *, confirmed, tokens=FIXTURE['owner'], lang='ru'):
    guest = request(owner, tokens, 'POST', path + '/guests', 201,
                    data={'name': 'Подтвердивший гость' if confirmed else 'Гость без ответа'})
    guest_path = f"{path}/guests/{guest['id']}"
    if confirmed:
        request(owner, tokens, 'PATCH', guest_path, 200, data={'status': 'yes'})
    link = request(owner, tokens, 'POST', guest_path + '/invite-link', 200)['url']
    page = page_for(browser, errors, lang=lang)
    page.goto(UI + urlparse(link).path)
    expect(page).to_have_url(UI + '/invite')
    return page, guest['id']


def open_plan(page):
    page.goto(UI + '/wedding/planb')
    page.get_by_role('button', name=re.compile('Дождь или непогода')).click()

def verify_plan_keyboard(page, scenario, preview_name, cancel, address):
    page.goto(UI + '/wedding/planb')
    disclosure = page.get_by_role('button', name=re.compile(scenario))
    disclosure.press('Enter')
    expect(disclosure).to_have_attribute('aria-expanded', 'true')
    trigger = page.get_by_role('button', name=preview_name, exact=True)
    preview = page.get_by_role('region', name=preview_name, exact=True)
    for width in (320, 390, 480):
        page.set_viewport_size({'width': width, 'height': 844})
        trigger.press('Tab')
        page.keyboard.press('Shift+Tab')
        expect(trigger).to_be_focused()
        assert trigger.evaluate("e => e.matches(':focus-visible') && parseFloat(getComputedStyle(e).outlineWidth) >= 2")
        page.keyboard.press('Enter')
        expect(preview.get_by_text(address, exact=True)).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), width
        page.get_by_role('button', name=cancel, exact=True).press('Enter')
        expect(preview).to_have_count(0)
        expect(trigger).to_be_focused()
    return trigger, preview


def configure(page, address=ADDRESS, *, add_contact=True):
    open_plan(page)
    page.get_by_role('button', name='Настроить сценарий').click()
    page.get_by_label('Причина', exact=True).fill('Сильный дождь')
    page.get_by_label('Когда включать').fill('Открытая площадка недоступна')
    page.get_by_label('Резервный адрес или точка сбора').fill(address)
    page.get_by_label('Что сделать').fill(ACTION)
    page.get_by_label('Ответственный', exact=True).select_option(label=COORDINATOR)
    if add_contact:
        page.get_by_role('button', name='Добавить контакт').click()
        page.get_by_label('К кому обратиться').fill('Дежурный')
        page.get_by_label('Телефон или другой контакт').fill(CONTACT)
    page.get_by_role('button', name='Сохранить сценарий').click()
    expect(page.get_by_text('Сценарий сохранён.')).to_be_visible()
    page.get_by_role('button', name='Закрыть', exact=True).click()


def count_value(page, label, value):
    expect(page.get_by_text(label, exact=True).locator('..').locator('dd')).to_have_text(value)


def notices(page, tokens):
    return [item for item in request(page, tokens, 'GET', '/notifications', 200)
            if item['title'] == NOTICE]


def wait_guest_day(page, *, reload=True):
    if reload:
        page.reload()
    page.get_by_role('button', name='Открыть приглашение').click()
    expect(page.get_by_role('heading', name='День свадьбы')).to_be_visible()


def run(browser, errors):
    owner_tokens, coordinator_tokens, helper_tokens = (FIXTURE[role] for role in ('owner', 'coordinator', 'helper'))
    owner = page_for(browser, errors, owner_tokens)
    coordinator = page_for(browser, errors, coordinator_tokens)
    helper = page_for(browser, errors, helper_tokens)
    path = '/weddings/' + FIXTURE['weddingId']
    confirmed, _ = invite(owner, path, browser, errors, confirmed=True)
    pending, _ = invite(owner, path, browser, errors, confirmed=False)
    wait_guest_day(confirmed, reload=False)
    wait_guest_day(pending, reload=False)
    configure(owner)
    assert request(owner, owner_tokens, 'GET', path + '/planb', 200)['activatedAt'] is None

    english = page_for(browser, errors, coordinator_tokens, 'en')
    verify_plan_keyboard(english, 'Rain or bad weather', 'Preview Plan B', 'Cancel', ADDRESS)
    english.context.close()
    trigger, preview = verify_plan_keyboard(coordinator, 'Дождь или непогода', 'Предпросмотр Плана Б', 'Отмена', ADDRESS)
    trigger.press('Enter')
    expect(preview.get_by_text(ADDRESS, exact=True)).to_be_visible()
    coordinator.context.set_offline(True)
    expect(coordinator.get_by_role('status').filter(has_text='Нет связи с сервером')).to_be_visible()
    expect(preview).to_have_count(0)
    expect(trigger).to_have_count(0)
    with coordinator.expect_response(lambda reply: reply.request.method == 'GET'
                                     and urlparse(reply.url).path.endswith(path + '/planb')) as refreshed:
        coordinator.context.set_offline(False)
    assert refreshed.value.status == 200 and refreshed.value.json()['activatedAt'] is None
    expect(trigger).to_be_enabled()
    trigger.press('Enter')
    expect(preview.get_by_text(ADDRESS, exact=True)).to_be_visible()
    expect(preview.get_by_text(f'{ACTION} · {COORDINATOR}')).to_be_visible()
    expect(preview.get_by_text(WARNING)).to_be_visible()
    expect(preview.get_by_text('Автоматическое оповещение гостей недоступно.')).to_be_visible()
    expect(preview.get_by_text('Подтвердивший гость', exact=True)).to_be_visible()
    expect(preview.get_by_text('Гость без ответа', exact=True)).to_have_count(0)
    expect(preview.get_by_text(CONTACT, exact=True)).to_have_count(0)
    preview.get_by_role('button', name='Снять выбор').press('Enter')
    recipient = preview.get_by_role('checkbox', name=f'{HELPER} · Команда')
    recipient.press('Space')
    expect(recipient).to_be_checked()
    with coordinator.expect_response(lambda reply: reply.request.method == 'POST'
                                     and urlparse(reply.url).path.endswith('/planb/activate')) as activated:
        coordinator.get_by_role('button', name='Подтвердить', exact=True).press('Enter')
    response = activated.value
    assert response.status == 200
    expect(coordinator.get_by_role('heading', name='План Б активирован', exact=True)).to_be_focused()
    activation = response.json()
    assert activation['guestsAffected'] == 1
    body = response.request.post_data_json
    assert len(body['inAppRecipientIds']) == 1 and body['previewToken']
    key = response.request.headers['idempotency-key']
    assert request(coordinator, coordinator_tokens, 'POST', path + '/planb/activate', 200,
                   data=body, key=key) == activation
    repeated = request(coordinator, coordinator_tokens, 'POST', path + '/planb/activate', 200,
                       data=body, key=str(uuid4()))
    assert repeated['activationId'] == activation['activationId'] and repeated['alreadyActive']
    assert not notices(owner, owner_tokens)
    received = notices(helper, helper_tokens)
    assert len(received) == 1 and received[0]['push']['confirmedDeliveryAt'] is None
    assert all(value not in received[0]['body'] for value in (ADDRESS, CONTACT, ACTION))

    count_value(coordinator, 'Уведомления в приложении', '1')
    count_value(coordinator, 'Ожидают восстановления Web Push', '1')
    count_value(coordinator, 'Принял push-сервис', '0')
    count_value(coordinator, 'Доставку подтвердили', 'Нет подтверждения')
    helper.context.close()
    helper = page_for(browser, errors, helper_tokens, 'en')
    helper.goto(UI + '/notifications')
    notice = helper.get_by_role('button', name=re.compile('Plan B activated'))
    expect(notice).to_have_count(1)
    expect(notice.get_by_text('Unread', exact=True)).to_be_attached()
    helper.context.set_offline(True)
    expect(helper.get_by_role('status').filter(has_text='No connection to the server')).to_be_visible()
    with helper.expect_response(lambda reply: reply.request.method == 'GET'
                                and urlparse(reply.url).path.endswith('/notifications')) as inbox:
        helper.context.set_offline(False)
    assert inbox.value.status == 200 and not next(item for item in inbox.value.json() if item['title'] == NOTICE)['read']
    notice.press('Tab')
    helper.keyboard.press('Shift+Tab')
    expect(notice).to_be_focused()
    with helper.expect_response(lambda reply: reply.request.method == 'POST'
                                and urlparse(reply.url).path.endswith('/read')) as read:
        helper.keyboard.press('Enter')
    assert read.value.status == 204
    coordinator.get_by_role('button', name='Обновить статусы').click()
    count_value(coordinator, 'Отметили прочитанным', '1')
    count_value(coordinator, 'Доставку подтвердили', 'Нет подтверждения')

    wait_guest_day(confirmed)
    expect(confirmed.get_by_text('План Б включён', exact=True)).to_be_visible()
    expect(confirmed.get_by_text(ADDRESS, exact=False)).to_have_count(0)
    coordinator.get_by_role('button', name='Проверить версию сценария').click()
    expect(preview.get_by_text('Эта версия уже включена', exact=False)).to_be_visible()
    expect(preview.get_by_label('Текст для гостей')).to_have_value('План Б включён. Новая точка сбора: ' + ADDRESS)
    preview.get_by_role('button', name='Показать адрес подтвердившим гостям').click()
    expect(preview.get_by_text('Адрес открыт подтвердившим гостям основного дня.')).to_be_visible()
    wait_guest_day(confirmed)
    expect(confirmed.get_by_text(ADDRESS, exact=False)).to_be_visible()
    expect(confirmed.get_by_text(CONTACT, exact=False)).to_have_count(0)
    wait_guest_day(pending)
    expect(pending.get_by_text('План Б включён', exact=True)).to_have_count(0)
    expect(pending.get_by_text(ADDRESS, exact=False)).to_have_count(0)

    draft_address = 'Уфа, новый черновик SC-013'
    configure(owner, draft_address, add_contact=False)
    open_plan(coordinator)
    coordinator.get_by_role('button', name='Проверить версию сценария').click()
    expect(preview.get_by_text(draft_address, exact=True)).to_be_visible()
    message = preview.get_by_label('Текст для гостей по действующему Плану Б')
    expect(message).to_have_value('План Б включён. Новая точка сбора: ' + ADDRESS)
    preview.get_by_role('button', name='Скрыть адрес в приглашениях').click()
    expect(message).to_have_value('План Б включён. Уточните детали у организаторов.')
    expect(preview.get_by_role('button', name='Показать адрес подтвердившим гостям')).to_have_count(0)
    wait_guest_day(confirmed)
    expect(confirmed.get_by_text('План Б включён', exact=True)).to_be_visible()
    expect(confirmed.get_by_text(ADDRESS, exact=False)).to_have_count(0)
    expect(confirmed.get_by_text(draft_address, exact=False)).to_have_count(0)


def main():
    errors, passed = [], []
    output = Path(os.environ['E2E_RESULT_DIR']) / 'sc013-browser-result.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with sync_playwright() as playwright:
            channel = os.environ.get('E2E_CHROMIUM_CHANNEL')
            browser = playwright.chromium.launch(headless=True, **({'channel': channel} if channel else {}))
            try:
                if '--offline-only' not in sys.argv:
                    run(browser, errors)
                    passed.append('planb-activation-and-guest-visibility')
                    verify_pickup_history(browser, errors)
                    passed.append('current-shuttle-pickup')
                    verify_lodging(browser, errors)
                    passed.append('current-guest-lodging')
                    for lang in ('ru', 'en'):
                        verify_logistics_keyboard(browser, errors, lang)
                        passed.append(f'guest-logistics-keyboard-{lang}')
                verify_offline_actions(browser, errors)
                passed.append('offline-guest-actions')
                assert not errors, errors
            finally:
                browser.close()
    finally:
        output.write_text(json.dumps({'passed': passed, 'page_errors': errors}), encoding='utf-8')
    print('SC-013 passed: ' + ', '.join(passed))


def verify_pickup_history(browser, errors):
    tokens = FIXTURE['owner']
    owner = page_for(browser, errors, tokens)
    path = '/weddings/' + FIXTURE['weddingId']
    route_name = 'Рейс для проверки посадки'
    route = request(owner, tokens, 'POST', path + '/logistics/buses', 201,
                    data={'name': route_name, 'seats': 3, 'from': 'Первая точка'})
    passenger, _ = invite(owner, path, browser, errors, confirmed=True)
    wait_guest_day(passenger, reload=False)
    transfer = passenger.locator('#transfer')
    seat = transfer.get_by_role('button', name=re.compile('^' + re.escape(route_name)))
    seat.click()
    expect(seat).to_have_attribute('aria-pressed', 'true')
    for address in ('Вторая точка', 'Третья точка'):
        saved = request(owner, tokens, 'PATCH', path + '/logistics/buses/' + route['id'], 200, data={'from': address})
        assert saved['pickupNotified'] == 1
    wait_guest_day(passenger)
    active = transfer.get_by_role('list', name='Изменения посадки', exact=True)
    expect(active.get_by_role('listitem')).to_have_count(1)
    expect(active.get_by_text('Новая точка посадки · Третья точка')).to_be_visible()
    transfer.get_by_text('История изменений посадки', exact=True).click()
    history = transfer.get_by_role('list', name='История изменений посадки', exact=True)
    expect(history.get_by_text('Точка после изменения · Вторая точка')).to_be_visible()
    transfer.get_by_role('button', name=f'Отказаться от места · {route_name}').click()
    transfer.get_by_role('button', name='Подтвердить отказ от места').click()
    expect(active).to_have_count(0)
    expect(history.get_by_role('listitem')).to_have_count(2)
    seat.click()
    expect(seat).to_have_attribute('aria-pressed', 'true')
    expect(active).to_have_count(0)


def verify_lodging(browser, errors):
    tokens = FIXTURE['owner']
    owner = page_for(browser, errors, tokens)
    wedding = '/weddings/' + FIXTURE['weddingId']
    lodging = wedding + '/logistics/lodging'
    guest, guest_id = invite(owner, wedding, browser, errors, confirmed=True)
    hotel = request(owner, tokens, 'POST', wedding + '/logistics/hotels', 201,
                    data={'name': 'Гостиница FR-043', 'rooms': 4})
    rooms = {}
    for label in ('Архивный', 'Первый', 'Второй'):
        room_id = str(uuid4())
        request(owner, tokens, 'PUT', f'{lodging}/rooms/{room_id}', 200,
                data={'version': 0, 'hotelId': hotel['id'], 'label': label, 'capacity': 1})
        rooms[label] = room_id

    today = date.fromisoformat(FIXTURE['today'])
    stay = {'version': 0, 'guestId': guest_id, 'responsibleId': None}
    request(owner, tokens, 'PUT', f'{lodging}/placements/{uuid4()}', 200,
            data={**stay, 'roomId': rooms['Архивный'], 'source': 'guest',
                  'checkIn': str(today - timedelta(days=3)), 'checkOut': str(today - timedelta(days=1))})
    placement = f'{lodging}/placements/{uuid4()}'
    current = {**stay, 'roomId': rooms['Первый'], 'source': 'organizer',
               'checkIn': str(today + timedelta(days=1)), 'checkOut': str(today + timedelta(days=3))}
    saved = request(owner, tokens, 'PUT', placement, 200, data=current)
    wait_guest_day(guest)
    first_room = guest.get_by_text(re.compile('Номер в отеле Первый$'))
    second_room = guest.get_by_text(re.compile('Номер в отеле Второй$'))
    old_room = guest.get_by_text(re.compile('Номер в отеле Архивный$'))
    history = guest.get_by_text('Завершённые заезды', exact=True)
    expect(first_room).to_be_visible()
    expect(guest.get_by_text('Источник подтверждения · Организатор', exact=True)).to_be_visible()
    expect(history).to_be_visible()
    expect(old_room).to_be_hidden()
    history.click()
    expect(old_room).to_be_visible()
    expect(guest.get_by_text('Источник подтверждения · Гость', exact=True)).to_be_visible()
    history.click()

    saved = request(owner, tokens, 'PUT', placement, 200,
                    data={**current, 'version': saved['version'], 'roomId': rooms['Второй'], 'source': 'hotel'})
    guest.evaluate("window.dispatchEvent(new Event('focus'))")
    expect(second_room).to_be_visible()
    expect(first_room).to_have_count(0)
    expect(guest.get_by_text('Источник подтверждения · Отель', exact=True)).to_be_visible()
    expect(guest.get_by_text('План размещения не подтверждает оплату гостиницы.', exact=True)).to_be_visible()

    request(owner, tokens, 'DELETE', f"{placement}?version={saved['version']}", 204)
    guest.evaluate("window.dispatchEvent(new Event('online'))")
    expect(second_room).to_have_count(0)
    expect(history).to_be_visible()
    expect(old_room).to_be_hidden()
    expect(guest.get_by_role('button', name='Подать заявку на номер')).to_be_enabled()
    guest.context.close()
    owner.context.close()


def verify_logistics_keyboard(browser, errors, lang):
    tokens = FIXTURE['owner']
    owner = page_for(browser, errors, tokens)
    wedding = '/weddings/' + FIXTURE['weddingId']
    suffix = lang.upper()
    route_name, original_name, target_name = (f'{title} {suffix}' for title in ('WP14 bus', 'WP14 original hotel', 'WP14 target hotel'))
    route = request(owner, tokens, 'POST', wedding + '/logistics/buses', 201,
                    data={'name': route_name, 'seats': 2})
    original = request(owner, tokens, 'POST', wedding + '/logistics/hotels', 201,
                       data={'name': original_name, 'rooms': 2, 'price': {'amount': 12345, 'currency': 'RUB'}})
    target = request(owner, tokens, 'POST', wedding + '/logistics/hotels', 201,
                     data={'name': target_name, 'rooms': 1})
    guest, _ = invite(owner, wedding, browser, errors, confirmed=True, lang=lang)
    other, _ = invite(owner, wedding, browser, errors, confirmed=True)
    open_invite, transfer_title, lodging_title, receipt, move, full, error = (
        ('Открыть приглашение', 'Трансфер', 'Где остановиться', 'Бронь номера сохранена',
         'Перенести бронь?', 'номеров нет', 'Свободных номеров в этом блоке не осталось') if lang == 'ru' else
        ('Open the invitation', 'Transfer', 'Where to stay', 'Room booking saved',
         'Move your booking?', 'no rooms left', 'No rooms are left in this block')
    )
    guest.get_by_role('button', name=open_invite, exact=True).press('Enter')
    transfer = guest.get_by_role('region', name=transfer_title, exact=True)
    lodging = guest.get_by_role('region', name=lodging_title, exact=True)
    seat = transfer.get_by_role('button', name=re.compile('^' + re.escape(route_name)))
    first = lodging.get_by_role('button', name=re.compile('^' + re.escape(original_name)))
    second = lodging.get_by_role('button', name=re.compile('^' + re.escape(target_name)))
    expect(first).to_contain_text('123,45 ₽' if lang == 'ru' else '123.45 ₽')
    for width in (320, 390, 480):
        guest.set_viewport_size({'width': width, 'height': 844})
        for button in (seat, first, second):
            button.press('Tab')
            guest.keyboard.press('Shift+Tab')
            expect(button).to_be_focused()
            assert button.evaluate("e => e.matches(':focus-visible') && parseFloat(getComputedStyle(e).outlineWidth) >= 2")
        assert guest.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), (lang, width)

    def post_to(block):
        return lambda response: response.request.method == 'POST' and urlparse(response.url).path.endswith('/' + block)

    with guest.expect_response(post_to('shuttle')) as joined:
        seat.press('Space')
    assert joined.value.status == 200 and joined.value.request.post_data_json['busId'] == route['id']
    expect(seat).to_have_attribute('aria-pressed', 'true')
    expect(seat).to_be_focused()
    with guest.expect_response(post_to('hotels')) as booked:
        first.press('Enter')
    assert booked.value.status == 200 and booked.value.request.post_data_json['hotelId'] == original['id']
    expect(lodging.get_by_role('status')).to_have_text(receipt)
    expect(lodging.get_by_role('heading', name=lodging_title, exact=True)).to_be_focused()

    second.press('Enter')
    expect(second).to_contain_text(move)
    other_token = other.evaluate("localStorage.getItem('tt_guest_token')")
    assert other_token
    request(owner, tokens, 'POST', f'/join/{other_token}/hotels', 200,
            data={'hotelId': target['id']}, key=str(uuid4()))
    with guest.expect_response(post_to('hotels')) as refused:
        second.press('Enter')
    assert refused.value.status == 409 and refused.value.json()['error']['code'] == 'hotel_full'
    expect(lodging.get_by_role('alert')).to_have_text(error)
    expect(second).to_contain_text(full)
    expect(second).to_be_focused()
    guest_token = guest.evaluate("localStorage.getItem('tt_guest_token')")
    hotels = request(owner, tokens, 'GET', f'/join/{guest_token}/hotels', 200)
    assert {hotel['id'] for hotel in hotels if hotel['mine']} == {original['id']}
    for page in (guest, other, owner):
        page.context.close()


def verify_offline_actions(browser, errors):
    tokens = FIXTURE['offlineOwner']
    owner = page_for(browser, errors, tokens)
    future = str(date.fromisoformat(FIXTURE['today']) + timedelta(days=45))
    wedding = request(owner, tokens, 'POST', '/weddings', 201,
                      data={'partnerName': 'Партнёр SC-018', 'date': future,
                            'city': {'name': 'Уфа', 'region': 'Башкортостан'}})
    path = '/weddings/' + wedding['id']
    request(owner, tokens, 'POST', path + '/logistics/buses', 201,
            data={'name': 'Рейс SC-018', 'seats': 3})
    request(owner, tokens, 'POST', path + '/logistics/hotels', 201,
            data={'name': 'Отель SC-018', 'rooms': 3})
    request(owner, tokens, 'PUT', path + '/menu-poll', 200,
            data={'options': [{'name': 'Овощи SC-018'}]})
    guest, _ = invite(owner, path, browser, errors, confirmed=True, tokens=tokens)
    guest.get_by_role('button', name='Открыть приглашение').click()
    guest.get_by_role('button', name='Изменить ответ').click()
    plus_one = guest.get_by_role('button', name='С +1')
    expect(plus_one).to_have_attribute('aria-pressed', 'false')
    plus_one.focus()
    guest.keyboard.press('Space')
    expect(plus_one).to_have_attribute('aria-pressed', 'true')
    diet = guest.locator('#main-rsvp').get_by_role('button', name='Другое', exact=True)
    expect(diet).to_have_attribute('aria-pressed', 'false')
    diet.focus()
    guest.keyboard.press('Space')
    expect(diet).to_have_attribute('aria-pressed', 'true')
    note = guest.get_by_role('textbox', name='Ограничения по еде')
    guest.keyboard.press('Tab')
    expect(note).to_be_focused()
    assert note.evaluate("""el => el.matches(':focus-visible')
        && getComputedStyle(el).outlineStyle !== 'none'
        && parseFloat(getComputedStyle(el).outlineWidth) > 0""")
    guest.keyboard.type('Орехи')
    for width in (320, 390, 480):
        guest.set_viewport_size({'width': width, 'height': 844})
        assert note.evaluate("""el => el.getBoundingClientRect().right <= innerWidth
            && document.documentElement.scrollWidth <= innerWidth"""), f'RSVP overflows at {width}px'
    controls = [guest.locator('#main-rsvp').get_by_role('button', name='Приду с радостью'),
                guest.get_by_role('button', name='Овощи SC-018'),
                guest.get_by_role('button', name=re.compile('^Рейс SC-018')),
                guest.get_by_role('button', name=re.compile('^Отель SC-018'))]
    for control in controls:
        expect(control).to_be_enabled()
    writes = []
    guest.on('request', lambda req: writes.append(req.method)
             if '/api/' in req.url and req.method not in ('GET', 'HEAD', 'OPTIONS') else None)
    guest.context.set_offline(True)
    expect(guest.get_by_text('Нет связи с сервером', exact=True)).to_be_visible()
    for control in controls:
        expect(control).to_be_disabled()
    guest.context.set_offline(False)
    for control in controls:
        expect(control).to_be_enabled()
    expect(plus_one).to_have_attribute('aria-pressed', 'true')
    expect(diet).to_have_attribute('aria-pressed', 'true')
    expect(note).to_have_value('Орехи')
    assert not writes, writes
    guest.context.close()
    owner.context.close()


if __name__ == '__main__':
    main()
