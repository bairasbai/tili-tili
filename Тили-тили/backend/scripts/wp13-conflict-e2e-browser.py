import json
import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


UI = 'http://127.0.0.1:3000'
FIXTURE = json.loads(Path(os.environ['E2E_FIXTURE_FILE']).read_text(encoding='utf-8'))


def save(page, button, expected):
    with page.expect_response(lambda response: response.request.method == 'PUT'
                              and urlparse(response.url).path.startswith('/api/weddings/')) as pending:
        page.get_by_role('button', name=button, exact=True).click()
    assert pending.value.status == expected, f'Expected {expected}, got {pending.value.status}'
    return pending.value


def verify_conflict(first, second, *, route, add, title_label, edit, submit, extra_fields=None):
    first.goto(UI + route)
    first.get_by_role('button', name=add).click()
    title = first.get_by_label(title_label, exact=True)
    initial, remote, draft, merged = ('Исходная карточка', 'Правка второй вкладки', 'Локальный черновик', 'Проверенная правка')
    title.fill(initial)
    if extra_fields:
        extra_fields(first)
    created = save(first, submit, 200).json()
    expect(first.get_by_role('heading', name=initial, exact=True)).to_be_visible()
    second.goto(UI + route)
    first.get_by_role('button', name=f'{edit} · {initial}', exact=True).click()
    second.get_by_role('button', name=f'{edit} · {initial}', exact=True).click()
    title.fill(draft)
    second.get_by_label(title_label, exact=True).fill(remote)
    assert save(second, submit, 200).json()['version'] == created['version'] + 1
    rejected = save(first, submit, 409).json()
    assert rejected['error']['code'] == ('stale_wedding_purchase' if route.endswith('/purchases') else 'stale_wedding_item')
    expect(title).to_have_value(draft)
    expect(first.get_by_role('button', name=submit, exact=True)).to_be_disabled()
    expect(first.get_by_text('Черновик остался в форме.', exact=False)).to_be_visible()
    first.get_by_role('button', name='Загрузить актуальную версию').click()
    expect(title).to_have_value(remote)
    title.fill(merged)
    saved = save(first, submit, 200).json()
    assert saved['id'] == created['id'] and saved['version'] == created['version'] + 2
    expect(first.get_by_role('heading', name=merged, exact=True)).to_be_visible()


def main():
    errors, passed = [], []
    output = Path(os.environ['E2E_RESULT_DIR']) / 'wp13-conflict-result.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with sync_playwright() as playwright:
            channel = os.environ.get('E2E_CHROMIUM_CHANNEL')
            browser = playwright.chromium.launch(headless=True, **({'channel': channel} if channel else {}))
            try:
                context = browser.new_context(viewport={'width': 390, 'height': 844})
                tokens = FIXTURE['owner']['tokens']
                context.add_init_script(f"""if (!localStorage.getItem('tt_auth')) {{
                  localStorage.setItem('tt_auth', JSON.stringify({json.dumps(tokens)}));
                  localStorage.setItem('tt_onboarded', '1');
                  localStorage.setItem('tt_wedding_id', JSON.stringify({json.dumps(FIXTURE['weddingId'])}));
                }}""")
                first, second = context.new_page(), context.new_page()
                for page in (first, second):
                    page.on('pageerror', lambda error: errors.append(type(error).__name__))
                verify_conflict(first, second, route='/wedding/purchases', add='Добавить покупку',
                                title_label='Название покупки', edit='Изменить покупку', submit='Сохранить покупку',
                                extra_fields=lambda page: page.get_by_label('Единица измерения').fill('шт.'))
                passed.append('purchase-draft')
                verify_conflict(first, second, route='/wedding/item-sets', add='Добавить вещь',
                                title_label='Название вещи', edit='Изменить вещь', submit='Сохранить')
                passed.append('item-draft')
                assert not errors, errors
            finally:
                browser.close()
    finally:
        output.write_text(json.dumps({'passed': passed, 'page_errors': errors}), encoding='utf-8')
    print('WP13 passed: ' + ', '.join(passed))


if __name__ == '__main__':
    main()
