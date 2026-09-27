# Проверка 019 / фаза 6: privacy, export и финальное закрытие

Дата: 2026-09-28. Статус: **✅ этап 019 закрыт на feature-ветке**. Main и production не изменялись.

## Проверенный снимок

- База второй поставки: `776d61fef00c05625f7382988baaded8604d9476`.
- Кандидат исходников после T039/T040: `58a5b56a00e325bb26e0ab701f4c18459855f85c`.
- Финальный feature-коммит создаётся атомарно из этого проверенного кода плюс только документационные отметки T042;
  временный workflow проверки в feature-коммит не входит.

## T039 — hard erase и приватность

Проверено на PostgreSQL, без моков:

- подрядчик: публичное DELETE → искусственно пройденные 31 день → штатный `cleanup`;
- один участник пары: тот же hard-erase путь при живом втором партнёре, свадьба и 019-история остаются ему;
- открытый request → `closed/vendor_erased`, `vendor_id=null`; shortlist/request становятся tombstone;
- непринятые offers удаляются;
- принятая deal сохраняет точную цену, package title и includes, но не настоящее имя стёртого подрядчика;
- OTP-Pii очищается, stale-account вход внутри 30-дневного окна проверяется реальным OTP API;
- поиск UUID, телефона, имени и уникального непринятого текста идёт во всех text/varchar/json/jsonb колонках
  как поиск подстроки; исключён только намеренный audit log;
- отдельная детерминированная гонка reply ↔ erase доказывает отсутствие request↔parent deadlock;
- privacy-проверки сериализованы с другими cleanup-тестами, чтобы глобальная уборка базы не давала ложных гонок.

Найден и исправлен ERR-0329: прежний erase сохранял настоящее имя подрядчика в `deals.external_name`.
Теперь остаётся только общая метка «Удалённый подрядчик», договорённые условия — в immutable snapshot.

## T040 — export

`GET /users/me/export` дополнен:

- паре: shortlist, offerRequests, offers по её свадьбам;
- подрядчику: только vendorOfferRequests и vendorOffers собственного vendor id;
- helper не получает 019 shortlist/request/offer через export;
- посторонний подрядчик не получает чужие requests/offers.

## Автоматическая приёмка

### Стандартный CI — run 36352964776

- Frontend: **78 файлов / 1056 тестов — passed**.
- Backend: **106 файлов / 1217 тестов — passed**.
- Backend выполнялся с PostgreSQL/Redis и применёнными миграциями.
- TypeScript, ESLint, frontend production build и backend TypeScript build — success.

### Независимый full gate + browser — run 36352964812

- Профильный `accept019.test.ts`: **1 файл / 25 тестов — passed**.
- Полный `bash init.sh`: frontend **1056/1056**, backend **1217/1217**, types/lint/build — success,
  итог `OK — фронт и бэк`.
- Browser T041: Playwright/Chromium, реальный API и отдельная PostgreSQL DB.
- Browser checks: **5/5 passed**, `errors=[]`:
  1. два кандидата добавлены из карточек подрядчиков;
  2. один batch создаёт два настоящих запроса;
  3. две независимые vendor-сессии отвечают своими условиями;
  4. сравнение принимает ровно одно исходное предложение;
  5. reload + API пары/подрядчика сохраняют одну бронь, точную цену и immutable package contents.

Артефакт run 36352964812: `offer019-finalization-evidence`, ID **10942139253**,
5 файлов, SHA-256 `578e400f3cc106355efbcd8f3be1866ef2b2ff472a3a2444bb2e06f36f1cedd9`.

## Итог

- [x] T039
- [x] T040
- [x] T041
- [x] T042
- ✅ **019 завершён полностью.**
- 020 не начат.
