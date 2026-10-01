# WP03 / T006: Scoped HTTP И Интерфейс Сдвига

2026-09-30. Локальный промежуточный этап, не приёмка всего WP03 или WP00–WP16.
Код незакоммичен/не опубликован; production не затронут. Провайдеры не выбраны.

## Реализация

- POST `/weddings/{weddingId}/timeline/shift/preview` принимает явную область
  `{kind:day,date}` или `{kind:event,eventId}` и ненулевые целые минуты -240…240.
  Event date/timeZone берутся из собственной строки БД, day использует пояс
  свадьбы. Чужой/неизвестный event даёт одинаковый 404, неизвестный контекст 422.
  Это не fallback или реконструкция мероприятия по названию блока.
- Reader `backend/src/timeline/snapshot.ts` читает полный planning graph;
  разные booked/paid_deposit/done deals одного vendor получают общий resource
  key. Vendor user и назначенный member с тем же user ID тоже общий ресурс.
  Исключения fixed/past/undated/other-day/other-event и конфликты dependencies,
  participants, unknown duration, explicit travel/buffer выдаются без записи.
- Preview содержит фактический ETag/sourceVersion, before/after, exclusions,
  conflicts, affected references/movements/recipients и подписанный token.
  Token привязан к user/session/wedding/version/digest, имеет отдельные audience,
  typ и производный ключ; срок 600 секунд от PostgreSQL clock_timestamp().
  При пустом/конфликтном плане canConfirm=false и token=null.
- POST `/timeline/shift` теперь только подтверждение previewToken: обязательны
  исходный If-Match и Idempotency-Key <=128 символов. Строгая schema требует
  token; legacy minutes распознаются только для отказа. Missing version legacy
  даёт 428, ноль 422 empty_shift; legacy с версией/extra force/minutes даёт 422.
  attachValidation позволяет сохранить явные отказы, не разрешая старую запись.
- В одной транзакции после wedding lock повторно проверяются живой доступ,
  аккаунт/сессия/роль, версия, срок/подпись token, фактическое время и digest
  пересчитанных последствий. Начавшийся за время ожидания блок не двигается.
  Старый/изменившийся/конфликтный plan даёт 409 без частичной записи.
- Блоки, новая revision/actor/time, timeline_shifts, broadcasts, адресный vendor
  update, notification rows и idempotency receipt сохраняются атомарно.
  Уведомления получают commanders и реально затронутые members/vendor users;
  actor исключён. Это in-app записи, не доказательство отправки push/SMS.
- Replay сначала проверяет текущий доступ и исходную сессию, возвращает именно
  сохранённый body/ETag, не сдвигает и не уведомляет второй раз. Другой preview
  на том же ключе получает idempotency_key_reused. Failed transaction не
  оставляет ключ и допускает повтор того же логического подтверждения.
- /dayx: Dialog с focus trap/restore и запретом закрытия во время запроса;
  выбор дня/реального мероприятия, минуты, пояс, последствия, исключения,
  конфликты, explicit confirm. RU/EN. Первый open берёт уже загруженную дату;
  последующие refresh/reopen не заменяют пользовательский ввод или preview ETag.
  Изменение полей/новый preview явные. Network retry сохраняет token/version/key;
  4xx блокирует confirm до нового preview. Success только после server receipt.
  Отказ GET events показан словами сервера, не пустым списком; 403 без retry CTA.
- Контракт 0.56.0: source YAML и штатная генерация, 154 пути / 204 операции /
  101 схема. Общий DayXBroadcast сохраняет совместимость с plan B; optional
  guest count не подменяется нулём или undefined.

## Доказательства

Каталог: `C:/Тили-тили/.unlazy/wp03-shift-20260930/`.

| Проверка | Источник | Результат / граница |
|---|---|---|
| До HTTP | server-before-http.log | Девять новых failures / 55 прежних passed; legacy command выполнялся без preview/version, preview route отсутствовал |
| Reader после первого подключения | server-http-initial.log, server-http-column.log | В SQL ошибочно owner_id вместо фактического vendors.user_id; после исправления 64/64 |
| Integrity / адресаты | server-command-integrity.log, server-command-integrity-baseline.log | Первый запуск 72/74: два неверных предположения о пустом vendor_updates после preceding PUT; исправлен baseline-снимок, 74/74 без ослабления адресности/rollback |
| UI protocol | ui-dialog-first.log, ui-dialog-context.log, ui-dialog-regressions.log | Поздняя дата initial state исправлена; старые regression tests переведены на preview/confirm, 101/101 на этом этапе |
| Отказ reader | ui-event-denial-before.log, ui-event-denial-after.log | Новый regression упал при потерянном forbiddenText; после исправления 102/102 в пяти файлах |
| Полный gate до последних UI/контрактных правок | full-contract-strict.log | 1122 frontend / 1381 backend, типы/линт/сборки прошли, exit 0; не заменяет итоговый повтор |
| Итоговый gate | full-final-scoped.log | init.sh exit 0; 83 frontend files / 1123 tests, 111 backend files / 1381 tests; skipped нет, типы/линт/сборки/contract audits прошли |
| Настоящий browser | browser-evidence-shift2/timeline-browser-result.json | Десять passed, page_errors пуст; API scopes, три ширины, подтверждение, role denial/grant, stale, lost committed response/replay, manual coordinator resolution |
| Browser текущего кода | browser-evidence-shift3/timeline-browser-result.json | Десять passed после последних правок, page_errors пуст; screenshots 320/390/1440 просмотрены, Dialog без horizontal overflow; runner/API/Vite завершены, private fixture удалён |

74 = 55 прежних event tests + 9 начальных HTTP scenarios + 10 integrity/access
scenarios. Новые проверки включают canonical same-vendor overlap, выбранных и
незатронутых recipients, RSVP change без revision change, expired signed token,
другую настоящую DB session, actual-clock eligibility, fault после настоящего
INSERT notification и три ожидания lock с отзывом роли (preview/confirm/replay).
SQL fixtures не объявляются проверкой booking workflow или production history.
Прирост от event foundation: frontend 1123 - 1112 = 11 новых UI tests;
backend 1381 - 1362 = 19 (9 protocol + 10 integrity/access). Изменения API/UI
после final full/browser не вносились; следующий код требует нового прогона.
Внешний GATES.md после evidence update: status/approve вернули ALL MET (5 met)
только для данного protocol этапа. Это не закрывает T006/WP03 или всю цель.

## Что Не Завершено

- T006 остаётся открытым: персональные invitations/RSVP независимых мероприятий
  WP04 ещё не реализованы. Main public blocks используют фактических wedding
  RSVP yes; private/independent blocks — только явно назначенных guest refs.
  Это совместимая промежуточная проекция, не окончательная событийная модель.
- Movements показывают записанные location/travel/buffer. Связи с настоящими
  рейсами/пассажирами, event-scoped transport и их изменениями ещё отсутствуют.
  Имена affected references пока не выводятся, UI показывает kind/ID; полный
  human-readable consequences и интервалы начала/окончания нужно завершить.
- Точная версия ознакомления подрядчика T007, оставшийся UI T008, расширенный
  versioned offline/cleanup T009, полная SC/NFR приёмка T010 и публикация T011
  остаются обязательными. Существующий vendor update не считается exact-version ack.
- Найден остаток существующего /dayx: started/current в Smart.tsx не проверяет
  endsAt, а time() использует пояс браузера. На desktop1440 screenshot этой
  фикстуры известный законченный block 2020 года помечен LIVE; часы основного
  списка отличаются от правильно разрешённого пояса preview. Исправить с
  отдельными регрессиями в T008; зелёный protocol gate не доказывает корректность
  всего родительского экрана.
  Последующий локальный этап исправляет этот остаток с отдельными отрицательными
  regressions и ETag context coherence: актуальное доказательство — REPORT-DAYX.md;
  исторический protocol gate выше не подменяется этой поздней проверкой.
- Browser/headless не заменяют физические устройства, нагрузку, restore, пилот
  и настоящие интеграции. Остальные WP00–WP16 не сокращались и не приняты.
