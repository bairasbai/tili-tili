# Инструкция Для Claude: Продолжение022

## Поручение Владельца И Точка Остановки
Владелец разрешил полный объём WP00–WP16, последовательные проверенные
поставки и публикацию/слияние в main. Последнее поручение Codex: закончить
текущий этап, передать подробную инструкцию Claude и остановиться. Поэтому
Codex заканчивает персональный состав дополнительных приглашений, не начинает
следующую реализацию RSVP. Не выдавать эту остановку за завершение всего ТЗ.

Рабочая папка Windows: `C:/Тили-тили`.
Основной Git checkout: `C:/Тили-тили/Тили-тили_код_и_документация`.
Remote: https://github.com/bairasbai/tili-tili.git.
Поставка: PR26 https://github.com/bairasbai/tili-tili/pull/26,
ветка `feature/event-rsvp-20261001`; код коммита
`cc8a31b4077dfdc676415750b8fd28f1acf72efd`, основа main
`04a8355182467a93d9c10499bf4a11dbd6de3d6b` (ранее влитый PR25).
Эта инструкция добавляется отдельным docs-коммитом в тот же PR26.
На границе её коммита PR ещё открыт: CI/merge нельзя объявлять заранее.
Фактический результат публикации после выполнения поручения находится в
`C:/Тили-тили/.unlazy/wp04-event-invitations-20261001/PUBLICATION-CONFIRMED.md`
и в самом PR26. Проверить их перед новой работой. При отсутствии локального
подтверждения прочитать статус PR, не предполагать слияние или актуальность main.

## Порядок Старта
1. Прочитать `CLAUDE.md`, применимые `AGENTS.md`/инструкции владельца,
   `session-handoff.md`, первые записи `tasks/todo.md`, последние `ERRORS.md`.
2. Прочитать исходные `tasks/wedding-platform-master-plan/spec.md`, `plan.md`,
   `tasks.md`, `baseline.md`, затем `delivery.md`. Первые четыре канонических
   документа не переписывать ради сокращения требований или отметок прогресса.
   В этой поставке они неизменны относительно `c2dea5a4`.
3. Прочитать в `tasks/фичи/022-мероприятия/`: `spec.md`, `plan.md`, `tasks.md`,
   `REPORT.md` и `REPORT-INVITATIONS.md`. Старая CRUD поставка — PR25,
   персональные приглашения — PR26; отдельный RSVP/deadline ещё не реализован.
4. До backend изменений прочитать `BACKEND-PLAN.md`, актуальный OpenAPI,
   `Тили-тили/Тили-тили_Бизнес-логика_и_бэкенд.md`; для UI — карты экранов/
   кнопок и цикл `Тили-тили/Тили-тили_Спека_фичи.md`.
5. Проверить `git status --short --branch`, ветку/HEAD и локальную историю.
   Чужие изменения сохранять. Не использовать reset --hard/checkout --/force
   push. После разрешённого fetch сравнить main/origin/main. Только затем
   новая feature-ветка для T012; PR26 не переиспользовать, если уже влит.
6. До существенной работы создать новый внешний GATES.md по CLAUDE §6,
   с проверяемыми CHECK/EXPECT/CWD и списком OWNS. Предыдущие гейты не
   доказывают новый код. При изменении source заново full/browser/source freeze.

## Что Уже Реализовано
- `backend/migrations/1762500000000_event_invitations.cjs`: таблица
  `guest_event_invitations`, PK event/person, составные wedding FK, main-row
  exclusion, неизменная идентичность, wedding lock и общий revision trigger.
  Пустой down/up допустим, populated down отказывается терять приглашения.
  Не переименовывать применённую миграцию.176220 уже занят,176250 следует176240.
- `backend/src/routes/events.ts`: GET/PUT
  `/weddings/:weddingId/events/:eventId/invitations`. Только couple; весь
  roster состоит из guestId/name/invited. PUT полного массива guestIds с
  captured If-Match, атомарно; no-op не меняет версию. Дубли/чужие ресурсы/
  main/stale/access changes отказывают. DELETE event с приглашениями получает
  409event_in_use, не каскадирует их молча.
- `backend/src/wedding/access.ts`: специальное ONLY_COUPLE правило перед
  общим events-правилом; использовать существующие fresh locked access helpers,
  не доверять только request.member из preHandler.
- `backend/src/routes/guests.ts` GET RSVP: wedding/party/member locks,
  повторная проверка токена обязательно к тому же pinned weddingId/partyId.
  `backend/src/guests/event-invitations.ts` возвращает main и явно разрешённые
  дополнительные события, guestIds только людей этой семьи. Нет чужих имён,
  ID, состава, ответов, контактов или бюджета; неизвестные поля события null.
- Прежний POST RSVP не превращён в ответы на все события. Основной состав
  переходно равен прежним реальным гостям; их identity/token/ответы сохранены.
  Новые мероприятия и новые члены семьи не получают extra-invite автоматически.
- `app/src/pages/EventInvitations.tsx`: реальный маршрут
  `/wedding/events/:eventId/invitations`, вход из строки WeddingEvents,
  checkbox по персонам, captured snapshot/version/draft, role/offline/shape
  gates. Conflict/неясная сеть сохраняют черновик, без autoretry/rebase;
  только явное открытие свежей версии. Accepted shape/IDs проверяются до успеха.
  Double-click/late old-wedding result защищены. Main read-only со ссылкой Guests.
- `app/src/pages/Invite.tsx`: приватный список событий своей семьи;
  старый RSVP явно «Ответ на основную программу». Не обещает extra-event RSVP.
- OpenAPI0.63.0:161paths/212operations/111schemas; backend generated
  paths/schemas/api и frontend schema обновлены штатными генераторами.
  Generated файлы руками не править; audit55 сохраняет точную проверку версии.

Здесь `backend/` и `app/` означают подпапки `Тили-тили/` основного checkout.

## Подтверждённые Проверки
Источник подробностей: `REPORT-INVITATIONS.md` и сохранённые локальные логи.
- Full `full-invitationsfull3.log`:99frontend files/1452passed,
  117backend files/1762passed, без skips; все8этапов init.sh, exit0.
- Focused backend `invitations-final3.log`:9files289passed, включая29новых
  реальных PG случаев, старые family/access/timeline/contract/serial и audit55.
  Front `invitationsui-final2.log`:8files182passed, включая22новых UI случая.
- Migration second drill: старые guest/party/event/wedding rows/RSVP/tokens
  не изменились; собственный empty down/up проходит, populated down отказ,
  wedding cascade проходит. Это actual PostgreSQL, не parser/SQL string test.
- Browser `browser-evidence-invitationsfinal3/timeline-browser-result.json`:
  actual production-build preview+API+PG,9checks/zero page_errors; все10PNG
  просмотрены RU/EN320/390/1440. Нет HTTP mocks/production/real SMS claim.
-574SHA256 source/test/config entries совпадают после full/browser/коммита;
  text EOL нормализован, docs/env/dist/deps исключены. Это не хеш всей машины.

Логи full/focused:
`C:/Тили-тили/.unlazy/wp03-shift-20260930/`.
Миграции/browser/GATES/check-evidence:
`C:/Тили-тили/.unlazy/wp04-event-invitations-20261001/`.
Manifest:
`C:/Тили-тили/.unlazy/wp03-publication-20261001/event-invitations-source-manifest.json`.
Внешний .unlazy не входит в GitHub. На другой машине логи не считать
доступными/повторёнными; выполнить собственные проверки и сохранить результат.

## Окружение И Повторение На Этом Компьютере
Фактический Node25.9.0, а не Node22 из планового стека. Зависимости только
pnpm по CLAUDE; npm install здесь известен повреждением node_modules.
Retained disposable PostgreSQL16 —127.0.0.1:15432, user codex_test,
каталог `C:/Тили-тили/.unlazy/sync-audit-20260930/pgdata`; Redis тестовый DB13.
Не удалять PG каталог/старые тестовые БД, не возвращаться молча к55432 и
не читать/печать секреты .env. Сначала убедиться, что это тестовые службы.
Браузерный runner завершает свои API/preview children и удаляет private fixture;
PG остаётся. Веб-URL3000 после завершения теста не является работающим сервером.

При наличии этих внешних runner'ов запускать из основного checkout в PowerShell.
Ниже `claudeverify1` — пример нового тега; проверить, что такого *_test DB
ещё нет, иначе выбрать новое имя. Не переиспользовать evidence как свежий прогон.

```powershell
$env:TILI_DISPOSABLE_PG_PORT = '15432'
node C:/Тили-тили/.unlazy/wp03-shift-20260930/verify.mjs setup claudeverify1 claudeverify1
node C:/Тили-тили/.unlazy/wp03-shift-20260930/verify.mjs migrate claudeverify1 claudeverify1
node C:/Тили-тили/.unlazy/wp03-shift-20260930/verify.mjs full claudeverify1 claudeverify1
```

Проверять exit каждой команды; не запускать full после неуспешных setup/up.
Runner предварительно проверяет, что все текущие миграции реально применены;
full запускает `bash init.sh`, задаёт тестовые DB/Redis и пустой SMS_PROVIDER.
Focused mode invitations/invitationsui не включает будущие тесты T012:
обязательно расширить новый гейт. Старый manifest/check-evidence относится
только к PR26, не перезаписывать его для объявления нового кода проверенным.

На другом компьютере: PostgreSQL16+Redis7, новая disposable БД, тестовые
TEST_DATABASE_URL/TEST_REDIS_URL, actual migration up, затем `bash init.sh`.
Не запускать destructive fresh против чужой БД и не давать skip за успех.
Local full и browser выполнять последовательно, не одновременно: общая БД,
OTP/locks/quota иначе дают ложные отказы. CI использует Node22/Linux — это
отдельная проверка, не доказательство Node22 на локальной Windows.

Browser повторение текущей поставки с уникальным `claudebrowser1`:

```powershell
$env:TILI_DISPOSABLE_PG_PORT = '15432'
node C:/Тили-тили/.unlazy/wp03-versions-20260930/browser-check.mjs claudebrowser1 eventinvitations
```

Проверить JSON, все снимки, отсутствие своих listeners/privatefixtures.
Для T012 нужен новый сценарий, текущие9checks не доказывают deadline/RSVP.
Не копировать private fixture/token в repo или handoff.

## Следующая Реализация: T012
Основание исходного ТЗ: FR-027–031/035, частичная SC-006, не полная SC/NFR
приёмка. T012 находится в `tasks/фичи/022-мероприятия/tasks.md`; существующий
план «После Состава: Отдельный RSVP И Deadline» — отправная точка.

Утверждено человеком: один общий срок на мероприятие, до конца выбранного
календарного дня в часовом поясе этого мероприятия. Точного пользовательского
часа и отдельных семейных сроков нет. Срок хранит календарную дату; закрытие
наступает в начале следующего локального календарного дня, не UTC23:59:59
и не фиксированные24часа. Неизвестный пояс не становится Moscow; активация
срока требует известного пояса. Проверить поддерживаемую IANA-зону/DST.

До кода уточнить контракт/модель/сценарий в spec/plan/tasks и новом GATES:
1. Отдельный ответ person/event: не наследовать yes от main. Не переписать
   старые main RSVP/guest identity/token/party и связанные резервы при миграции.
2. До срока представитель отвечает только за приглашённые персоны своей
   семьи. В одной транзакции повторно проверить exact token resource, current
   roster/event/deadline после ожидания locks. Снятие invite/архив/отмена/
   tokenrotation/изменение deadline/zone не обходятся старым pre-check.
3. После срока — отдельный запрос организатору, без изменения принятого
   ответа. Конкретную форму запроса/решения/отказа описать до реализации;
   если требуется продуктовое решение, спросить владельца опросом. Не считать
   неотправленный вопрос отвеченным и не объявлять сообщение доставленным.
4. Пара корректирует ответ с provenance «внесено организатором»; не расширять
   права coordinator/helper автоматически за пределы действующей ACL.
5. Extra-event no не удаляет main bus/hotel/meal/seat и не меняет main yes.
   Основные побочные эффекты прежнего RSVP проверить отдельно. Привязки
   логистики к event — последующее обязательство, не обещать их в этом RSVP.
6. UI пары/гостя: реальные ответы/срок/зона/закрытие/request/provenance;
   unknown/loading/error/offline/access роли отличимы от пусто/нет/успех.
   Captured draft/version, no autoretry, понятный серверный отказ, RU/EN,
   narrow/desktop screenshots и keyboard. Никаких mock successes.
7. Permanent tests:3персоны/разные events/семейные права, чужие wedding/person,
   near cutoff/DST/offset/null/изменения во время actualPGwait, rollback/no
   partialwrite, main preservation/резервы, версии/гонки/удаления/late result.
   Новые shared-table DDL/LOCKTABLE tests включить в serial inventory audit53.
8. Actual migration rehearsal, fresh full без skips, actual built-browser
   scenario и просмотр PNG, source freeze/check, карты/report/JOURNAL/ERRORS/
   полный handoff. Затем greenCI/PR/main/local sync, не до проверки.

## Решения И Блокеры Которые Нельзя Выдумывать
- Опрос об основной дате не отвечен: сохраняется прежний перенос через `/us`.
- Политика отзыва уже принятого reminder batch не отвечена; не выдавать новую
  политику отмены за утверждённую. Текущие pre-dispatch проверки сохранять.
- Внешние providers не выбраны; тестовые аккаунты не предоставлены.
  Цена/валюта/период/платные функции/возвраты/retention ещё ждут владельца.
- Production запрещён. Только локальные тесты и GitHub code publication.
  Не запускать deployment, реальные SMS/push/платежи/хранилища.
- WP04/master T010 и остальные WP00–WP16/SC/NFR остаются. Не менять исходное
  ТЗ так, чтобы частичная поставка стала якобы «всё реализовано».

## Сохранённые Неудачи И Уроки
Не стирать failed evidence и не подсчитывать unselected skips как прохождение.
Token reassignment before:1failed/28filtered skips, synthetic SQL fixture
вернула200 другой семьи; исправлена exact pinned resource revalidation.
Это не доказательство публичного exploit или утечки production.
Full1: dictionary entry отсутствовала; full2: audit55 exact old0.62.1 literal.
Теперь canonical0.63.0 и strict invariant, не ослабленная проверка.
Browser320h1 clipped исправлен локально22px, не глобальной сменой chrome.
Неверные тестовые URL/button/403-text исправлялись как observer ошибки;
первая migration down1 попала на другой этап и не принята как rollback refusal.
Final1 browser9checks имел guest PNG во время opening scene; после ожидания
computed opacity0 и проверки region bounds fresh final3 прошёл. Дробный
scroll y=-0.15625px учтён1CSS px допуском, не скрытием целой строки.

## GitHub Без Частого Опроса
Перед remote:

```powershell
node C:/Users/Bayra/.claude/hooks/github-api-guard.js --status
```

ПАУЗА означает stop remote. Сначала локальные git history/diff/код.
Все GitHub requests строго последовательно, между writes минимум1секунда.
Нельзя gh run watch/gh pr checks --watch/watch/циклы gh+sleep. CI читать
не чаще раза в2–3минуты, без постоянного опроса.403/429/rate limit/abuse/
submitted too quickly/Bad credentials: stop, сообщить человеку, не обходить
и не повторять. Не менять branch protection ради слияния. Созданный PR
прикреплять доступным инструментом приложения; merge только после actual CI.
После merge fetch main, fast-forward локального main, сверить HEAD/origin/main,
чистоту дерева/source. Не автоматически деплоить production.

Авторизованный параллельный чат:01a0f198-4c17-7cd1-8931-516ff056d1a6,
«Проверь статус параллельной сессии», clone ecosystem-local-20260930.
Не импортировать его app.ts/users/schema/migrations целиком и не принимать
заявление о всехWP без независимых первичных тестов. Новые чаты не создавать
без прямого поручения владельца.

## Короткий Стартовый Запрос Для Claude
«Продолжи полный план WP00–WP16 в C:/Тили-тили/Тили-тили_код_и_документация.
Сначала прочитай CLAUDE.md, session-handoff.md и
tasks/фичи/022-мероприятия/CLAUDE-CONTINUE.md. Проверь фактический merge PR26,
локальный main и сохранённые результаты, затем выполняй T012: отдельный
RSVP person/event, общий календарный deadline по event-zone, поздний запрос
и organizer provenance, сохраняя main RSVP и резервы. Уточняй продуктовые
вопросы опросом, не угадывай. Production не трогать; GitHub строго по стражу
и без частого опроса. Доводи каждую поставку до реальных тестов, full/browser,
документов и greenCI/main; не объявляй всё ТЗ завершённым без его приёмки».
