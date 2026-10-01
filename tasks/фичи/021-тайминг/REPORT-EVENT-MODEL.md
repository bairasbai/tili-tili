# WP03 / T006: реальная модель мероприятий

2026-09-30. Промежуточный локальный этап на стыке WP03/WP04, не приёмка пакетов.
WP00–WP16 остаются полным активным объёмом. Прикладной код незакоммичен и не
опубликован, GitHub в этом этапе не запрашивался; production не затронут.

## Реализация

- Миграция 1762100000000 создаёт wedding_events и обязательную связь
  timeline_events.program_event_id. Существующая свадьба получает ровно одно
  основное мероприятие с прежними date/tz/venue. Блоки не дробятся по названию,
  sort или предположению о церемонии. Их ID, время, planning/origin, отношения,
  версия/автор/время изменения сохраняются. Неизвестные date/tz остаются прежними.
- Composite FK связывает блок только с мероприятием своей свадьбы. Удаление
  мероприятия не каскадирует блоки; main и populated event удалить нельзя.
  Полное удаление свадьбы сохраняет штатный каскад. Main identity неизменяема,
  его date/tz/location синхронизированы с фактической строкой свадьбы.
- GET/POST/PATCH/DELETE events используют общий timeline snapshot и ETag.
  Читают разрешённые члены команды; команды доступны только couple. Запись
  требует If-Match, проверяет версию и повторно проверяет актуальные права после
  ожидания wedding lock. Автор берётся из сессии, время из PostgreSQL.
- Проверяются UUID, принадлежность, название, вид, дата, часовой пояс ICU и
  PostgreSQL. Технический предел 50 мероприятий защищён и БД; он не является
  тарифным правилом. Чужое/неизвестное мероприятие в PUT даёт одинаковый 422.
- Main-date PATCH использует существующий транзакционный reschedule. Перенос
  основной даты двигает только main blocks, независимо датированное мероприятие
  не переезжает. Изменение date/tz/location отдельного мероприятия меняет контекст
  и версию, но НЕ переставляет часы блоков автоматически: будущий preview/confirm
  должен показать и подтвердить последствия.
- GET/PUT/autogen команды сохраняют eventId. Пропущенное поле старого клиента
  оставляет связь существующего блока; новый блок получает main. toTimelineDraft
  теперь переносит eventId, и редактор/full-list действия не теряют его.
- Legacy гостевой день отдаёт только разрешённые main blocks без eventId и
  planning. Само создание мероприятия НЕ приглашает туда всех гостей. Это
  промежуточное ограничение до индивидуальных приглашений WP04, не их реализация.
- Контракт 0.55.0: штатно пересозданы backend generated и frontend schema.
  Получено 153 пути / 203 операции / 98 схем; сверка входит в полный gate.

## Миграция И Откат

Метаданные backfill не считаются действием человека; modified_at исторического
main остаётся NULL. Если у старого интервала уже был NOT VALID CHECK, миграция
в своей транзакции временно снимает только этот CHECK и восстанавливает его
точное определение после backfill. Недопустимый интервал не исправляется догадкой,
новые invalid writes по-прежнему запрещены. Исторический неизвестный timezone
сохраняется при изменении имени; новый/изменённый неизвестный timezone запрещён.

Safe down допускается только для нетронутых backfilled main. Down/up сохраняет
прежние строки, но создаёт новые ID контейнеров мероприятий: это не сохранение
новой идентичности через удалённую схему. Повторный up без down сохраняет event IDs.
Любое управляемое мероприятие/изменение защищает down от потери данных; отказ
атомарен, migration tracking остаётся. Production история не исследовалась.

## Доказательства

Все источники в `C:/Тили-тили/.unlazy/wp03-shift-20260930/`.

| Проверка | Источник | Результат |
|---|---|---|
| До event API | server-before-events.log | Девять новых тестов упали на отсутствующих routes, прежние 41 прошли |
| Первая реализация | server-events.log | 49/50; unknown timezone отвечал 500 вместо 422 |
| После исправления validation | server-events-validation.log | 50/50; поздняя правка DB history guard требовала свежей БД |
| Текущие сервер/миграция | server-events-current.log, migrate-events.log | Свежая tili_codex_events_20260930_test; 55/55, конкурентный POST 201/409, recheck PUT и GET/POST/PATCH/DELETE events после отзыва членства |
| Клиент до/после сохранения eventId | client-before-event-retention.log, client-event-retention.log | До: один failed / семь passed; после восемь passed |
| Корректная история | event-valid-v1-result.json, event-valid-v1-*.log | Семь migration checks: complete history/context, down/up/repeat, constraints, transaction rollback, default/cascade, unknown historical zone, protected down |
| Недопустимая история | event-bad-v1-result.json, event-bad-v1-*.log | Восемь checks, дополнительно exact NOT VALID interval preservation и new-write rejection |
| Первый полный gate | full-events.log | Остановился на TS-ошибках двух новых клиентских fixtures; это не runtime failure приложения |
| Полный итоговый gate | full-events-types.log | init.sh exit 0: 82 frontend files / 1112 tests, 111 backend files / 1362 tests; skipped нет, типы/линт/сборки прошли |
| Реальный редактор с event link | browser-evidence-events1/timeline-browser-result.json | Восемь проверок: API fixture, editor/accepted snapshot retention, stale context во второй сессии, explicit reopen, три ширины, autogen/apply; page_errors пуст |

Прирост backend относительно origin/calculator: 1362 - 1348 = 14 (девять event
tests, один concurrent POST и четыре дополнительных access-wait варианта).
Frontend: 1112 - 1110 = 2 новых converter tests. Два migration drill используют
разные новые БД, не повторяются на сохранённых fixtures. Browser screenshots
mobile320/mobile390/desktop1440 просмотрены; нет горизонтального page overflow.
Браузерный runner завершён, API/Vite children остановлены, private fixture удалён.

## Покрытие Требований

| Требование | Текущее доказательство / оставшееся |
|---|---|
| FR-035 / WP04 | DB/API/date/tz/location/typed events и стабильная связь реализованы; UI управления, индивидуальные приглашённые/RSVP ещё отсутствуют, FR не принят |
| FR-036 | Event context инвалидирует точную программу, stale/concurrent/access refusal и client retention проверены; окончательная приёмка всего WP03 впереди |
| FR-038 | Pure consequences calculator остаётся неподключённым; canonical vendor resources, реальный scoped reader, ознакомление точной версии ещё нужны |
| FR-039 / T006 | Main reschedule не двигает independent blocks; legacy shift всё ещё wedding-wide, выбранный day/event preview/confirm и coordinator resolution НЕ реализованы |
| FR-040 / T009 | Новая scoped offline/access cleanup приёмка отсутствует |
| SC-008/017/018, NFR | Частичные ID/stale/tenant/browser доказательства не заменяют весь набор сценариев, физических устройств, нагрузку, restore и пилот |

## Следующий Шаг

Авторизованный DB reader полного снимка: реальные event date/tz и нормализация
разных booked deals одного vendor в один ресурс. Затем HTTP scoped preview и
идемпотентное подтверждение точного исходного снимка с актуальным временем,
access/version recheck, отказом без частичных записей/уведомлений и устранением
legacy bypass. UI выбора day/event, consequences/conflicts и explicit confirm,
адресные приглашения/трансферы и ручное решение координатора остаются обязательны.
После этого T007–T011, выпуск полного WP03 отдельным feature-коммитом/push/main
и все остальные WP. Полный объём не сокращён.
