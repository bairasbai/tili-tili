# Проверка 020 — семейные приглашения / clean integration

Дата: 2026-09-28.

## Merge-кандидат

Ветка: `integration/020-clean-main-20260928`.
Проверочный кодовый HEAD: `661d2ae98c2a6feb03da7553dcb2f1ad294ce73b`.

Старая source-линия 020 не используется как merge-кандидат целиком: она выросла из прежней 019-базы. В clean-ветку перенесена только дельта этапа 020, конфликтные общие файлы сведены с текущим main, а generated contract пересобран из итогового OpenAPI.

## T031 — real browser E2E ✅

GitHub Actions run: `36365055383`.
Artifact: `family020-clean-evidence`, id `10947465988`.
Artifact SHA-256: `a914dcd8854aa2a9645ce3f0a562df5f3feaf6a7371aef0fb9dbc044f8514a13`.

Перед browser flow на одноразовой PostgreSQL выполняется migration rehearsal:
1. применить все миграции;
2. откатить только 020;
3. создать legacy guest с `plusOne=true`, menu/bus/hotel/invite/gift состоянием;
4. снова применить 020;
5. проверить сохранение family identity и ресурсов.

Реальный Chromium/Vite/Fastify flow прошёл целиком:
- семья создана через UI пары;
- членов семьи: **2**;
- семейных invite links: **1**;
- независимых menu votes: **2**;
- занятых bus seats: **2**;
- hotel rooms: **1**;
- family gift reservations: **1**;
- JavaScript page errors: **0**.

## T032 — полный CI ✅

GitHub Actions run: `36365055384` — success.

- Frontend: **78 passed files / 1023 passed tests**.
- Backend: **106 passed files / 1178 passed tests**.
- PostgreSQL migrations: success, включая `1761600000000_family_guest_parties`.
- TypeScript: success.
- ESLint: success.
- Frontend Vite production build: success.
- Backend TypeScript production build: success.

## Дополнительная проверка

Source-ветка после тех же финальных test-harness corrections также зелёная:
- CI `36364877609` — success;
- Family browser `36364877628` — success.

Два последних исправления не меняли product behavior:
- Playwright locator перестал вставлять Cyrillic через JSON `\\uXXXX` в XPath;
- CSV regression ожидает новую колонку `Family` вместо legacy `+1`.

## Итог

T001–T033 этапа 020 закрыты как clean merge-candidate. Временный workflow clean-browser удаляется финализационным коммитом. Следующий gate — PR на актуальный `main`, затем post-merge CI. Этап 021 до этого не начинается.


## PR / main acceptance · 2026-09-28 ✅

- PR: **#12** `integration/020-clean-main-20260928 → main`.
- PR head: `d865ef45557314b54dc01ff017dfadfd99055d37`.
- PR CI: `36365523795` — success.
- Offers 019 browser regression: `36365523816` — success.
- Task planning browser regression: `36365523769` — success.
- Merge commit: `3b2dbabd26701b33da372126fa33b2e4caad4b82`.
- Post-merge main CI: `36365783985` — success.

Этап 020 слит и проверен на итоговом main. Следующий product stage — 021. Production deployment этими gates не подтверждается.
