# WP03 / T006–T008: Подписанные Читаемые Последствия

2026-09-30. Локальный промежуточный этап. Полный WP03/WP00–WP16 не принят,
код незакоммичен/не опубликован. Production не затронут.

Позднейший backend legacy-update access этап имеет отдельный итоговый full
1146/1394 и browser vendoraccess1: REPORT-VENDOR-ACCESS.md. Числа ниже относятся
к captured-effects checkpoint, не заменяют последующую проверку текущего кода.

## Реализация

- Контракт 0.57.0 добавляет обязательные `blockDetails`, `referenceDetails` и
  `affectedGuests`. Генерация штатная: 154 paths / 204 operations / 103 schemas;
  source YAML, backend types/paths/runtime schemas и frontend types совпадают.
- `readShiftPlan` под существующим авторизованным wedding lock получает
  названия блоков/мероприятий, реальные даты/IANA-пояса/места и известные
  интервалы. Composite join по wedding/event не подставляет чужой контекст.
  Общий `planningEnd` использует ту же известную запись/точную длительность,
  что и pure calculator; отсутствующее окончание/длительность не угадываются.
- Имена ссылок разрешаются только в этой свадьбе: живое подходящее членство,
  guest ID или действительно booked/paid_deposit/done deal. Каталожное имя
  берётся из vendors.name; свой подрядчик без аккаунта из external_name.
  Нет fallback к телефону, чужому аккаунту или финансовому названию пакета.
  DTO ссылок: kind/id/name/assignments, гостей: id/name. Null имя остаётся null.
- Assignments перечисляют реальные affected block IDs и responsible/participant.
  Guest names соответствуют существующей main RSVP yes / explicit guest
  проекции. Это ещё не индивидуальные event invitations/RSVP WP04.
- Новые данные входят в существующий signed digest. Подтверждение заново
  читает план: изменение отображённого имени подрядчика даже без изменения
  timeline revision даёт shift_preview_changed/409 без сдвига. Session/access/
  actual-clock/version/atomic replay protection сохранены.
- Dialog показывает captured block/event names, известные полные даты/начала/
  окончания «до/после» в собственном поясе каждого блока, включая milliseconds.
  Parent refresh не заменяет названия или context подписанного preview.
  Исключения показывают сохранённые интервалы; конфликт сравнивает AFTER
  сдвигаемого блока с captured интервалом неподвижного, а не оба BEFORE.
- Видны именованные участники/подрядчики, роль назначения и связанный блок;
  раскрываемый список реально затронутых RSVP guests. Неизвестные имена/пояса/
  окончания обозначены явно. HTML-подобные строки рендерятся как текст.
  Старый API без обязательного captured context не допускает confirm.
- Manual travel/buffer показывает оба плановых времени начала блока. Legacy
  beforeArrival/afterArrival в pure calculator равны этим началам, не реальному
  прибытию рейса: контракт и UI прямо называют их плановыми началами.
  Связи настоящих рейсов/пассажиров ещё не реализованы и не заменены этим UI.
- RU/EN, вертикальный responsive layout и штатный Dialog scroll/focus сохранены.
  GuestsAffected — существующие записи, не доказательство доставки push/SMS.

## Доказательства

Каталог `C:/Тили-тили/.unlazy/wp03-shift-20260930/`.

- `server-before-effects.log`: один новый fixture ошибочно прислал comment в
  POST guest. Исправлен на реальную запись comment в изолированной БД; это не
  behavioral witness. `server-before-effects-valid.log`: три new failed / 74
  old passed: DTO отсутствует и label mutation реально допускает старый shift.
- `ui-before-effects.log`: четыре failures были locator отсутствующих новых
  markers, они не считаются самостоятельной поведенческой приёмкой.
  `ui-before-effects-content.log`: пять content failures / 102 old passed:
  отсутствуют окончания, captured имена/context, manual plan times/unknown zone.
- `server-effects-projection.log`: первый этап 77/77. Дополнительный сценарий
  independent event/unknown user name и role grant/denial включены позднее.
- `ui-effects-complete.log`: 110/110 до дополнительных fixed-context полей.
  `ui-before-fixed-context.log`: один new content failure / 110 passed —
  неизменённый конфликтующий блок не имеет видимого интервала.
  `ui-effects-fixed-context.log`: 111/111 после captured graph intervals.
- `full-effects-first.log`: новый English test ожидал несуществующее Program
  version вместо реального Schedule version. Исправлен locator, не словарь.
  `full-effects-final.log`: фронт 1145 passed, lint обнаружил три unused
  destructuring variables в новом тесте старого API. Исправлено удалением
  optional свойств fixture, правило линта не выключалось.
- `full-effects-lint-final.log`: 1145 frontend passed, backend 1384 passed /
  1 failed из-за старой exact-version assertion 0.56.0. Assertion обновлена
  строго на source 0.57.0, не ослаблена. `full-effects-current-final.log`
  1145/1385, exit 0 — исторический промежуточный результат ДО поздних graph
  interval/контрактных правок, не заменяет итоговый.
- `full-effects-graph-final.log`: итоговый текущий init.sh exit 0, 84 frontend
  files / 1146 tests, 111 backend files / 1385 tests, skipped нет, типы/линт/
  сборки/contract audits прошли. После него application/schema код не менялся.
  Прикладной код после этого прогона не менялся; позднее менялись только
  внешние браузерные проверки и документы.
- `browser-evidence-effects1/timeline-browser-result.json`: 17 passed,
  page_errors пуст. Повтор `browser-evidence-effects2/timeline-browser-result.json`:
  18 passed, page_errors пуст; дополнительная проверка сравнивает реальный
  AFTER сдвигаемого блока и неизменённый fixed interval, включая milliseconds.
  Реальные API создают RSVP yes guest, own contractor и назначения; проверены
  captured names после parent refresh, отказ helper/назначение coordinator,
  stale 409, same-key replay после потери ответа и ручное разрешение конфликта.
  Browser timezone UTC, реальные event zones Ufa/Moscow. Просмотрены top/bottom
  dialog screenshots mobile320/mobile390/desktop1440 и conflict390: текст
  переносится, горизонтального переполнения/наложений не обнаружено.
  Это headless Chromium, не физические устройства. Runner exit 0, временные
  API/Vite/Python завершены, private fixture удалён. Новая effects2 test DB
  сохранена; повтор не должен переиспользовать это имя.

Прирост к DayX: frontend 1146 - 1137 = 9 новых UI tests; backend 1385 - 1381 =
4 новых real DB/API tests. Role grant/denial/private projection дополнительно
включены в первый новый server scenario. Pure end calculation вынесен без
изменения семантики; прежние 21 pure shift regression входят в полный gate.

## Оставшееся

T006 не закрыт: индивидуальные приглашения/RSVP независимых мероприятий и
реальные связанные transfers должны участвовать в последствиях/версиях.
T007 точное ознакомление/отзыв, event-management UI и оставшийся T008, T009
полный versioned offline/access cleanup, T010 SC/NFR и T011 feature commit/
push/main остаются обязательными. Другие WP00–WP16 не сокращались.
Физические устройства/нагрузка/restore/пилот/реальные провайдеры не проверялись.
