import json
import os
import re
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


def page_for(browser, errors, tokens=None):
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    if tokens:
        context.add_init_script(f"""if (!localStorage.getItem('tt_auth')) {{
          localStorage.setItem('tt_auth', JSON.stringify({json.dumps(tokens)}));
          localStorage.setItem('tt_onboarded', '1');
        }}""")
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


def invite(owner, path, browser, errors, *, confirmed):
    tokens = FIXTURE['owner']
    guest = request(owner, tokens, 'POST', path + '/guests', 201,
                    data={'name': 'Подтвердивший гость' if confirmed else 'Гость без ответа'})
    guest_path = f"{path}/guests/{guest['id']}"
    if confirmed:
        request(owner, tokens, 'PATCH', guest_path, 200, data={'status': 'yes'})
    link = request(owner, tokens, 'POST', guest_path + '/invite-link', 200)['url']
    page = page_for(browser, errors)
    page.goto(UI + urlparse(link).path)
    expect(page).to_have_url(UI + '/invite')
    return page


def open_plan(page):
    page.goto(UI + '/wedding/planb')
    page.get_by_role('button', name=re.compile('Дождь или непогода')).click()


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
    confirmed = invite(owner, path, browser, errors, confirmed=True)
    pending = invite(owner, path, browser, errors, confirmed=False)
    wait_guest_day(confirmed, reload=False)
    wait_guest_day(pending, reload=False)
    configure(owner)
    assert request(owner, owner_tokens, 'GET', path + '/planb', 200)['activatedAt'] is None

    open_plan(coordinator)
    coordinator.get_by_role('button', name='Предпросмотр Плана Б').click()
    preview = coordinator.get_by_role('region', name='Предпросмотр Плана Б')
    expect(preview.get_by_text(ADDRESS, exact=True)).to_be_visible()
    expect(preview.get_by_text(f'{ACTION} · {COORDINATOR}')).to_be_visible()
    expect(preview.get_by_text(WARNING)).to_be_visible()
    expect(preview.get_by_text('Автоматическое оповещение гостей недоступно.')).to_be_visible()
    expect(preview.get_by_text('Подтвердивший гость', exact=True)).to_be_visible()
    expect(preview.get_by_text('Гость без ответа', exact=True)).to_have_count(0)
    expect(preview.get_by_text(CONTACT, exact=True)).to_have_count(0)
    preview.get_by_role('button', name='Снять выбор').click()
    recipient = preview.get_by_role('checkbox', name=f'{HELPER} · Команда')
    recipient.click()
    expect(recipient).to_be_checked()
    with coordinator.expect_response(lambda reply: reply.request.method == 'POST'
                                     and urlparse(reply.url).path.endswith('/planb/activate')) as activated:
        coordinator.get_by_role('button', name='Подтвердить', exact=True).click()
    response = activated.value
    assert response.status == 200
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
    helper.goto(UI + '/notifications')
    notice = helper.get_by_role('button', name=re.compile(NOTICE))
    expect(notice).to_have_count(1)
    expect(notice.get_by_text('Не прочитано', exact=True)).to_be_attached()
    with helper.expect_response(lambda reply: reply.request.method == 'POST'
                                and urlparse(reply.url).path.endswith('/read')) as read:
        notice.click()
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
                run(browser, errors)
                passed.append('planb-activation-and-guest-visibility')
                verify_pickup_history(browser, errors)
                passed.append('current-shuttle-pickup')
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
    passenger = invite(owner, path, browser, errors, confirmed=True)
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


if __name__ == '__main__':
    main()
