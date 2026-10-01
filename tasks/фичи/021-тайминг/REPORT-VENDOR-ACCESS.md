# WP03 / T007: Отзыв Доступа К Старым Карточкам

2026-09-30. Локальный prerequisite этап, не весь T007 и не весь WP03.
Legacy «Учтено» по-прежнему означает получение карточки, не ознакомление
с конкретной версией разрешённой программы. Exact-version reader/ack/UI,
очистка offline и остальные WP остаются обязательными. Production не затронут.

## Реализация

- GET /vendor/updates включает карточку только при существующей committed
  сделке той же свадьбы/подрядчика (booked/paid_deposit/done), живых аккаунте
  и сессии, неизменном владельце анкеты и не archived/cancelled свадьбе.
  Старая сохранённая карточка сама по себе не даёт доступа.
- POST ack транзакционный: wedding share lock, затем повторные проверки
  wedding/account/session/vendor ownership/committed deals с row locks,
  затем update по update/vendor/wedding. Порядок wedding-first совпадает
  с cancelDeal. Отказ не записывает ack_at. Повторное разрешённое получение
  сохраняет прежний ack_at. Сохранившаяся вторая бронь той же свадьбы
  сохраняет доступ, отмена одной сделки не отменяет другую.
- Никакой формы/API schema/миграции или UI не менялось. Нет claims о версии,
  real push/SMS или автоматической очистке уже загруженной страницы.
  Cached card при отказе показывает actual404; reload убирает карточку.

## Доказательства

Каталог C:/Тили-тили/.unlazy/wp03-shift-20260930/:

- vendor-before-live-access.log: три новых real DB/API failures /21 прежний
  passed. После настоящего POST slots/cancel список содержал старую карточку,
  ack возвращал204 и записывал ack_at. Archive/cancel wedding уже скрывали GET,
  но прямой ack всё ещё возвращал204 и записывал время.
- vendor-live-access.log: четыре файла /30 passed. Прирост30-21=9:
  cancellation1, archived/cancelled2, surviving booking+retry1,
  реальные waiting-lock revocations5 (deal/session/account/archive/cancel).
  Race tests наблюдают реальный locking query, не подставляют SQL ответы;
  блокирующая транзакция фиксирует отзыв до получения handler share lock.
- full-vendor-access-current.log: init.sh exit0, frontend84files/1146tests,
  backend111files/1394tests, skipped нет, типы/линт/сборки/contract audits
  прошли. Прирост серверных к captured-effects:1394-1385=9. Прикладной код
  после прогона не менялся; schema/API shapes/migrations не менялись.
- C:/Тили-тили/.unlazy/wp03-vendor-access-20260930/
  browser-evidence-vendoraccess1/timeline-browser-result.json:9 actual
  Chromium/API checks, page_errors пуст. Настоящие profile publication/
  booking/timeline edit/cancellation, desktop/mobile dashboard, direct404,
  cached UI отказ и real reload removal. Просмотрены vendor320/vendor390/
  vendor1440/vendor-denied1440 screenshots, overflow/overlap не обнаружены.
  Runner exit0, API/Vite/Python children завершены, private fixture удалён.
  Это не physical devices/providers/exact-version acknowledgment. Fresh DB
  vendoraccess1 уже существует; повтор с тем же именем запрещён.

## Остаток

T007 exact-version program snapshot/ack и новое ожидание при редакции, безопасная
vendor projection и интерфейс ознакомления; T006 event invitees/transfers,
T008 event management, T009 full offline/access cleanup, все SC/NFR и WP00–WP16.
Legacy карточка не заменяет эти требования. Feature-коммит/push/main ещё нет.
