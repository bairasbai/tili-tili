import base64
import json
import os
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


UI = 'http://127.0.0.1:3000'
FIXTURE = json.loads(Path(os.environ['E2E_FIXTURE_FILE']).read_text(encoding='utf-8'))['wp01Pdf']
PDF = base64.b64decode(FIXTURE['bytes'])
LABELS = {
    'ru': ('Редакции и согласование', 'Прикрепить PDF до 10 МиБ', 'Нужен PDF размером до 10 МиБ', 'Скачать PDF'),
    'en': ('Versions and approval', 'Attach a PDF up to 10 MiB', 'Choose a PDF up to 10 MiB', 'Download PDF'),
}


def tab_to(page, target):
    expect(target).to_be_visible()
    for _ in range(60):
        if target.evaluate('el => el === document.activeElement'):
            break
        page.keyboard.press('Tab')
    expect(target).to_be_focused()


def choose(page, field, filename, mime, content):
    tab_to(page, field)
    assert field.evaluate("el => el.parentElement.matches(':focus-within')")
    with page.expect_file_chooser() as chooser:
        page.keyboard.press('Enter')
    chooser.value.set_files({'name': filename, 'mimeType': mime, 'buffer': content})


def verify(browser, lang, errors):
    fixture = FIXTURE[lang]
    region_name, file_name, error, download_name = LABELS[lang]
    deal, document = fixture['dealId'], fixture['documentId']
    attachments = f'/api/deals/{deal}/documents/{document}/attachments'
    context = browser.new_context(viewport={'width': 390, 'height': 844}, accept_downloads=True)
    context.add_init_script(f"""localStorage.setItem('tt_auth', JSON.stringify({json.dumps(fixture['owner'])}));
      localStorage.setItem('tt_onboarded', '1');
      localStorage.setItem('tt_wedding_id', JSON.stringify({json.dumps(fixture['weddingId'])}));
      localStorage.setItem('tt_lang', {json.dumps(lang)});""")
    try:
        page = context.new_page()
        page.on('pageerror', lambda fault: errors.append(type(fault).__name__))
        page.bring_to_front()
        page.goto(UI + '/wedding/documents?document=' + document)
        region = page.get_by_role('region', name=region_name)
        field = region.get_by_label(file_name, exact=True)
        grants = []
        page.on('request', lambda request: grants.append(request)
                if request.method == 'POST' and urlparse(request.url).path == attachments else None)
        choose(page, field, 'wrong.txt', 'text/plain', b'synthetic non-PDF')
        expect(region.get_by_role('alert')).to_have_text(error)
        expect(region).to_be_focused()
        assert not grants
        for width in (320, 390, 480):
            page.set_viewport_size({'width': width, 'height': 844})
            assert field.evaluate('el => el.parentElement.getBoundingClientRect().right <= innerWidth')
        with page.expect_response(lambda res: res.request.method == 'POST' and urlparse(res.url).path == attachments) as issued:
            with page.expect_response(lambda res: res.request.method == 'POST' and urlparse(res.url).path.startswith(attachments + '/')
                                      and urlparse(res.url).path.endswith('/complete')) as checked:
                choose(page, field, 'source.pdf', 'application/pdf', PDF)
        assert issued.value.status == 201 and checked.value.status == 200
        assert checked.value.json()['state'] == 'ready'
        assert len(grants) == 1
        download = region.get_by_role('button', name=download_name, exact=True)
        expect(download).to_be_visible()
        expect(region.get_by_role('alert')).to_have_count(0)
        expect(region).to_be_focused()
        content_path = attachments + '/' + issued.value.json()['uploadId'] + '/content'
        tab_to(page, download)
        assert download.evaluate("el => el.matches(':focus-visible') && parseFloat(getComputedStyle(el).outlineWidth) >= 2")
        with page.expect_download() as saved, page.expect_response(lambda res: urlparse(res.url).path == content_path) as read:
            page.keyboard.press('Enter')
        assert read.value.status == 200 and read.value.headers.get('cache-control') == 'private, no-store'
        assert saved.value.suggested_filename == 'contract.pdf'
        assert sha256(Path(saved.value.path()).read_bytes()).digest() == sha256(PDF).digest()
        expect(download).to_be_focused()
    finally:
        context.close()


def main():
    errors, passed = [], []
    with sync_playwright() as playwright:
        channel = os.environ.get('E2E_CHROMIUM_CHANNEL')
        browser = playwright.chromium.launch(headless=True, **({'channel': channel} if channel else {}))
        try:
            for lang in LABELS:
                verify(browser, lang, errors)
                passed.append('private-pdf-keyboard-' + lang)
            assert not errors, errors
        finally:
            browser.close()
    result = Path(os.environ['E2E_RESULT_DIR']) / 'wp01-private-pdf-result.json'
    result.parent.mkdir(parents=True, exist_ok=True)
    result.write_text(json.dumps({'passed': passed, 'page_errors': errors}), encoding='utf-8')
    print('WP01 passed: ' + ', '.join(passed))


if __name__ == '__main__':
    main()
