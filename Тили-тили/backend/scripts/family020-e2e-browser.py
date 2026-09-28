import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = os.environ.get("E2E_BASE_URL", "http://127.0.0.1:3000")
OUT = Path(os.environ.get("E2E_RESULT_DIR", "/tmp/family020-browser"))
OUT.mkdir(parents=True, exist_ok=True)
posted = []

page_body = {
  "partyId": "11111111-1111-4111-8111-111111111111",
  "guestName": "Марина",
  "status": "pending",
  "members": [
    {"guestId": "22222222-2222-4222-8222-222222222222", "name": "Марина", "status": "pending", "diet": None, "transfer": None},
    {"guestId": "33333333-3333-4333-8333-333333333333", "name": "Илья", "status": "pending", "diet": None, "transfer": None},
  ],
  "wedding": {"title": "Марина и Илья", "date": "2027-06-14", "city": {"name": "Уфа"}, "inviteThemeId": 0}
}

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 390, "height": 844})
    context.add_init_script("localStorage.setItem('tt_guest_token','family-token')")
    page = context.new_page()

    def rsvp(route):
        if route.request.method == "POST":
            posted.append(route.request.post_data_json)
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"members": route.request.post_data_json.get("members", [])}))
        else:
            route.fulfill(status=200, content_type="application/json", body=json.dumps(page_body))
    page.route("**/api/rsvp/family-token", rsvp)
    page.route("**/api/join/family-token/**", lambda route: route.fulfill(status=200, content_type="application/json", body="[]"))

    errors = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.goto(BASE + "/invite", wait_until="networkidle")
    page.get_by_role("button", name="Открыть приглашение").click()
    page.get_by_text("Ответьте за каждого человека в приглашении отдельно").wait_for()

    attending = page.get_by_role("button", name="Приду")
    declining = page.get_by_role("button", name="Не смогу")
    attending.nth(0).click()
    declining.nth(1).click()
    save = page.get_by_role("button", name="Сохранить ответы семьи")
    assert save.is_enabled(), "family save must enable after every person answered"
    save.click()
    page.wait_for_timeout(500)

    assert len(posted) == 1, posted
    members = posted[0].get("members")
    assert members and len(members) == 2, posted[0]
    assert members[0]["guestId"].startswith("2222") and members[0]["status"] == "yes"
    assert members[1]["guestId"].startswith("3333") and members[1]["status"] == "no"
    assert not errors, errors
    page.screenshot(path=str(OUT / "family-rsvp.png"), full_page=True)
    result = {"passed": ["shared family link renders two people", "each person answers independently", "single save sends two guestIds"], "errors": errors, "payload": posted[0]}
    (OUT / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    browser.close()
