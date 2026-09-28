#!/usr/bin/env python3
"""Real browser acceptance for stage 020 against PostgreSQL + real Fastify API."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright, expect

BASE = "http://127.0.0.1:3000"
API = "http://127.0.0.1:3001"
FIXTURE = Path(os.environ["E2E_FIXTURE_FILE"])
OUT = Path(os.environ["E2E_RESULT_DIR"])
OUT.mkdir(parents=True, exist_ok=True)
fixture = json.loads(FIXTURE.read_text())
PRIMARY = "Анна Семья E2E"
SECOND = "Борис Семья E2E"


def member_card(page, name: str):
    return page.get_by_text(name, exact=True).first.locator(
        "xpath=ancestor::div[.//button[normalize-space()='Приду'] and .//button[normalize-space()='Не смогу']][1]"
    )


def member_resource(block, name: str, button_text: str):
    # The member name is a direct child of its resource row. Do not embed
    # json.dumps(button_text) into XPath: Cyrillic becomes literal \\uXXXX
    # escapes, which XPath does not decode, so valid buttons are never found.
    del button_text
    return block.get_by_text(name, exact=True).first.locator("xpath=parent::div")


def checked(response, status: int, label: str) -> Any:
    if response.status != status:
        raise AssertionError(f"{label}: expected {status}, got {response.status}: {response.text()}")
    return response.json() if response.body() else None


result: dict[str, Any] = {"steps": [], "pageErrors": []}

with sync_playwright() as p:
    browser = p.chromium.launch()
    pair = browser.new_context(viewport={"width": 390, "height": 844})
    pair.add_init_script(
        f"""localStorage.setItem('tt_auth', {json.dumps(json.dumps(fixture['owner']))});
localStorage.setItem('tt_onboarded', '1');
localStorage.setItem('tt_wedding_id', JSON.stringify({json.dumps(fixture['weddingId'])}));
localStorage.setItem('tt_wedding_date', JSON.stringify({json.dumps(fixture['date'])}));"""
    )
    pair_page = pair.new_page()
    pair_page.on("pageerror", lambda exc: result["pageErrors"].append(f"pair: {exc}"))
    pair_page.goto(f"{BASE}/wedding/guests", wait_until="domcontentloaded")
    expect(pair_page.get_by_text("Гости", exact=True).first).to_be_visible(timeout=15_000)
    pair_page.get_by_role("button", name="Добавить гостя").click()

    primary_input = pair_page.get_by_placeholder("Имя гостя или семьи")
    primary_input.fill(PRIMARY)
    pair_page.get_by_role("textbox", name="Второй человек семьи").fill(SECOND)
    add_card = primary_input.locator("xpath=ancestor::div[contains(@class,'card')][1]")
    add_card.get_by_role("button", name="Добавить", exact=True).click()
    expect(pair_page.get_by_text(PRIMARY, exact=True).first).to_be_visible(timeout=15_000)
    expect(pair_page.get_by_text(SECOND, exact=True).first).to_be_visible(timeout=15_000)
    pair_page.screenshot(path=str(OUT / "01-family-created.png"), full_page=True)
    result["steps"].append("pair-created-two-person-family-through-ui")

    auth_headers = {"authorization": f"Bearer {fixture['owner']['accessToken']}"}
    api = p.request.new_context(base_url=API, extra_http_headers=auth_headers)
    guests = checked(api.get(f"/weddings/{fixture['weddingId']}/guests"), 200, "guest list")
    family = [g for g in guests if g.get("name") in {PRIMARY, SECOND}]
    assert len(family) == 2, family
    party_ids = {g["partyId"] for g in family}
    assert len(party_ids) == 1, family
    primary = next(g for g in family if g["name"] == PRIMARY)
    companion = next(g for g in family if g["name"] == SECOND)
    assert primary["isPrimary"] is True and companion["isPrimary"] is False

    link = checked(
        api.post(f"/weddings/{fixture['weddingId']}/guests/{primary['id']}/invite-link"),
        200,
        "family invite link",
    )
    code = link["url"].rstrip("/").split("/")[-1]
    guests_after_link = checked(api.get(f"/weddings/{fixture['weddingId']}/guests"), 200, "guest list after link")
    family_after_link = [g for g in guests_after_link if g.get("partyId") == primary["partyId"]]
    assert sum(1 for g in family_after_link if g.get("inviteUrl")) == 1
    result["steps"].append("one-family-invite-link-issued")

    guest = browser.new_context(viewport={"width": 390, "height": 844})
    guest_page = guest.new_page()
    guest_page.on("pageerror", lambda exc: result["pageErrors"].append(f"guest: {exc}"))
    guest_page.goto(f"{BASE}/i/{code}", wait_until="domcontentloaded")
    guest_page.wait_for_url("**/invite", timeout=15_000)
    expect(guest_page.get_by_role("button", name="Открыть приглашение")).to_be_visible(timeout=15_000)
    guest_page.get_by_role("button", name="Открыть приглашение").click()

    first = member_card(guest_page, PRIMARY)
    second = member_card(guest_page, SECOND)
    first.get_by_role("button", name="Приду", exact=True).click()
    first.get_by_role("button", name="Без ограничений", exact=True).click()
    first.get_by_role("button", name="Нужен трансфер", exact=True).click()
    second.get_by_role("button", name="Приду", exact=True).click()
    second.get_by_role("button", name="Вегетарианское", exact=True).click()
    second.get_by_role("button", name="Нужен трансфер", exact=True).click()
    guest_page.get_by_role("button", name="Сохранить ответы семьи", exact=True).click()
    expect(guest_page.get_by_text("Что будете есть E2E?", exact=True)).to_be_visible(timeout=15_000)
    guest_page.screenshot(path=str(OUT / "02-family-rsvp.png"), full_page=True)

    guest_token = guest_page.evaluate("localStorage.getItem('tt_guest_token')")
    assert guest_token and len(guest_token) > 10
    guest_api = p.request.new_context(base_url=API)
    rsvp = checked(guest_api.get(f"/rsvp/{guest_token}"), 200, "family RSVP")
    by_name = {m["name"]: m for m in rsvp["members"]}
    assert by_name[PRIMARY]["status"] == "yes"
    assert by_name[SECOND]["status"] == "yes"
    assert by_name[PRIMARY].get("diet") is None
    assert by_name[SECOND].get("diet") == "vegetarian"
    result["steps"].append("per-person-rsvp-saved")

    menu_block = guest_page.get_by_text("Что будете есть E2E?", exact=True).locator(
        "xpath=ancestor::div[contains(@class,'rounded-[24px]')][1]"
    )
    first_menu = member_resource(menu_block, PRIMARY, "Стейк E2E")
    first_menu.get_by_role("button", name="Стейк E2E", exact=True).click()
    expect(menu_block.get_by_text(PRIMARY, exact=True)).to_be_visible(timeout=10_000)
    second_menu = member_resource(menu_block, SECOND, "Паста E2E")
    second_menu.get_by_role("button", name="Паста E2E", exact=True).click()

    shuttle_block = guest_page.get_by_text("Трансфер", exact=True).locator(
        "xpath=ancestor::div[contains(@class,'rounded-[24px]')][1]"
    )
    first_bus = member_resource(shuttle_block, PRIMARY, "Автобус семьи E2E")
    first_bus.get_by_role("button", name=re.compile("Автобус семьи E2E")).click()
    expect(shuttle_block.get_by_text(PRIMARY, exact=True)).to_be_visible(timeout=10_000)
    second_bus = member_resource(shuttle_block, SECOND, "Автобус семьи E2E")
    second_bus.get_by_role("button", name=re.compile("Автобус семьи E2E")).click()

    hotel_block = guest_page.get_by_text("Где остановиться", exact=True).locator(
        "xpath=ancestor::div[contains(@class,'rounded-[24px]')][1]"
    )
    hotel_block.get_by_role("button", name=re.compile("Отель семьи E2E")).click()
    expect(hotel_block.get_by_text("Вы здесь", exact=True)).to_be_visible(timeout=10_000)
    guest_page.screenshot(path=str(OUT / "03-family-resources.png"), full_page=True)
    result["steps"].append("two-menu-votes-two-bus-seats-one-family-room")

    menu_state = checked(guest_api.get(f"/join/{guest_token}/menu-vote"), 200, "menu state")
    options = {o["name"]: o["id"] for o in menu_state["options"]}
    menu_members = {m["name"]: m["chosenOptionId"] for m in menu_state["members"]}
    assert menu_members[PRIMARY] == options["Стейк E2E"]
    assert menu_members[SECOND] == options["Паста E2E"]

    shuttle = checked(guest_api.get(f"/join/{guest_token}/shuttle"), 200, "shuttle state")
    shuttle_members = {m["name"]: m["myBusId"] for m in shuttle["members"]}
    assert shuttle_members == {PRIMARY: fixture["busId"], SECOND: fixture["busId"]}
    route = next(r for r in shuttle["routes"] if r["id"] == fixture["busId"])
    assert route["taken"] == 2

    hotels = checked(guest_api.get(f"/join/{guest_token}/hotels"), 200, "hotel state")
    target_hotel = next(h for h in hotels if h["id"] == fixture["hotelId"])
    assert target_hotel["mine"] is True and target_hotel["booked"] == 1

    guest_page.get_by_role("button", name="Подарки и складчина", exact=True).click()
    guest_page.wait_for_url("**/gifts", timeout=10_000)
    gift_name = guest_page.get_by_text("Подарок семьи E2E", exact=True)
    expect(gift_name).to_be_visible(timeout=15_000)
    gift_card = gift_name.locator("xpath=ancestor::div[contains(@class,'card')][1]")
    gift_card.get_by_role("button", name="Подарю", exact=True).click()
    gift_card.get_by_role("button", name="Подтвердить", exact=True).click()
    expect(guest_page.get_by_text("Вы зарезервировали этот подарок", exact=True)).to_be_visible(timeout=10_000)
    guest_page.screenshot(path=str(OUT / "04-family-gift.png"), full_page=True)

    gifts = checked(guest_api.get(f"/gifts/{guest_token}"), 200, "guest gifts")
    target_gift = next(g for g in gifts["gifts"] if g["id"] == fixture["giftId"])
    assert target_gift["reserved"] is True and target_gift["mine"] is True
    pair_wishlist = checked(api.get(f"/weddings/{fixture['weddingId']}/wishlist"), 200, "pair wishlist")
    pair_gift = next(g for g in pair_wishlist["gifts"] if g["id"] == fixture["giftId"])
    assert pair_gift["reserved"] is True
    assert guest_token not in json.dumps(pair_wishlist, ensure_ascii=False)
    result["steps"].append("one-shared-family-gift-reservation")

    assert result["pageErrors"] == [], result["pageErrors"]
    result["verified"] = {
        "familyMembers": 2,
        "inviteLinks": 1,
        "menuVotes": 2,
        "busSeats": 2,
        "hotelRooms": 1,
        "familyGiftReservations": 1,
    }

    (OUT / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    api.dispose()
    guest_api.dispose()
    pair.close()
    guest.close()
    browser.close()

print(json.dumps(result, ensure_ascii=False))
