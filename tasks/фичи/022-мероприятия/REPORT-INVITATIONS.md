# 022: Персональный Состав Приглашённых

## Граница
Продолжение полного WP00–WP16 от main04a8355182467a93d9c10499bf4a11dbd6de3d6b
(PR25, фактический merge2026-10-01T12:00:51Z/all7CI SUCCESS/local clean/source569).
Ветка feature/event-rsvp-20261001. Эта поставка реализует персональный состав
дополнительных мероприятий и его приватный показ семье, не весь022/WP04.
Дедлайны, отдельные ответы/обращения после срока, организаторский источник
правки, адресные логистические связи и полная FR/SC/NFR-приёмка остаются.
Ответы владельца записаны в spec: один срок на мероприятие, до конца
выбранного календарного дня в его часовом поясе. Deadline не включается
полуфабрикатом без полного сценария; неизвестный пояс не угадывается.
Основная дата пока только через `/us`; ответа на отдельный опрос нет.

## Реализация
- `backend/migrations/1762500000000_event_invitations.cjs`: добавочная таблица
  guest_event_invitations с составными FK свадьба/event и свадьба/person.
  Идентичность строки не меняется, main-строки запрещены, все изменения
  блокируют свадьбу и меняют общую версию программы. Новое событие пустое;
  новый член семьи не наследует чужое дополнительное приглашение.
- Основной состав переходно равен существующим реальным гостям; старые
  RSVP, party IDs, гостевые токены, ссылки и приватные резервы не переписаны.
  DELETE person снимает только его дополнительные приглашения; populated
  event получает409 event_in_use. Down отказывается терять populated roster.
- `backend/src/routes/events.ts`: couple-only GET/PUT event invitations.
  Единый snapshot event/people/invited/ETag; PUT полного набора с captured
  If-Match. Дубли/чужие персоны/event, устаревшая версия и недоступная роль
  отказывают без частичной записи. Непоменявшийся набор не меняет версию.
  Fresh lockGuestReadAccess/lockSeatingAccess и финальный JWT после запросов.
- `backend/src/routes/guests.ts` + `guests/event-invitations.ts`: GET RSVP
  закрепляет wedding/party/персон, повторно подтверждает тот же token resource
  после ожидания. events содержит только main и явно разрешённые события,
  guestIds только людей собственной семьи. Нет полного roster/чужих ID/имён/
  ответов/контактов/бюджета; неизвестные метаданные event остаются null.
- Канонический OpenAPI0.63.0:161paths/212operations/111schemas по выводам
  gen-contract/gen-schemas; generated backend paths/schemas/types и front
  schema пересобраны штатными генераторами, не ручной правкой.
- `app/src/pages/EventInvitations.tsx`: `/wedding/events/:eventId/invitations`,
  вход из строки события. Персоны-checkbox, роль/shape/version/offline gates,
  captured roster/draft, конфликт/неясная сеть не повторяются автоматически.
  Fresh opening явно заменяет черновик; подтверждается только принятый
  состав, затем reread. Main read-only со ссылкой на прежний список гостей.
  Двойное нажатие и поздний результат другой свадьбы не дают вторую запись
  или ложный успех. RU/EN, длинные имена переносятся, локальный h1=22px.
- `app/src/pages/Invite.tsx`: разрешённые мероприятия/свои персоны/метаданные;
  legacy RSVP явно подписан «Ответ на основную программу». Он не записывает
  отдельный ответ на дополнительное событие, и интерфейс этого не обещает.

## Проверено Сейчас
Внешние файлы находятся в `C:/Тили-тили/.unlazy/`, не входят в repo.
- `wp03-shift-20260930/invitations-final3.log`:9files289passed с actual PG;
 29new cases в eventInvitations022.test.ts. Отдельно старые family/timeline/
  guest read/write/contract/schema/serial guard; нет unselected full acceptance.
- `wp03-shift-20260930/invitationsui-final2.log`:8files182passed;
 22new UI cases + server-down route inventory, dictionary/contrast/shell.
- `wp04-event-invitations-20261001/migration-drill-second-*.log`: baseline
 176240 → actual176250, прежние строки people/parties/events/wedding unchanged;
  own empty down/up succeeds, populated down refuses, wedding cascade succeeds.
- Контролируемый SQL token-reassignment before witness:1failed/28unselected
  skipped, новая проекция вернула200 другой семьи вместо401. Это синтетическое
  переназначение в тестовой БД, не доказательство публичного exploit/утечки
  production. После проверки exact pinned party/wedding regression passed.
- `wp03-publication-20261001/event-invitations-source-manifest.json`:574
  normalized SHA256 source/test/config entries, без docs/env/dist/deps.

## Полный Прогон И Браузер
`wp03-shift-20260930/full-invitationsfull3.log`: fresh migrated PostgreSQL16
на127.0.0.1:15432, Redis13, SMS_PROVIDER пустой, Node25.9.0. Все8этапов
init.sh прошли, exit0;99frontend files1452passed/117backend files1762passed,
без skips. Это scoped проверка текущего дерева, не приёмка всего WP04.
`wp04-event-invitations-20261001/browser-evidence-invitationsfinal3/`:
реальная production-сборка в локальном preview с actual API/PG,9checks,
zero page_errors; все10PNG просмотрены RU/EN320/390/1440. Проверены реальный
выбор/сохранение/reload, private family subset, прежние yes/no main RSVP,
populated DELETE409, stale409/draft/no auto retry/fresh opening, helper403/
anonymous401, clear[], ENsave и геометрия нового экрана/гостевого списка.
Гостевые снимки сняты после исчезновения вступительной сцены. Это не
production deploy, физический телефон или реальная внешняя доставка.
После full/browser574source hashes совпадают; own browser services/private
fixture очищены, disposable PG сохранён. Манифест исключает docs/env/dist/deps.
Проверяющий скрипт `wp04-event-invitations-20261001/check-evidence.mjs`
проверяет все8этапов init.sh, pass-only summaries, текущий source и неизменность
исходных master spec/plan/tasks/baseline против c2dea5a4. Negative control
отвергает сохранённые failed full logs, включая invitationsfull1/2.

## Сохранённые Неудачи
- Backend first:3failed/257passed: foreign PUT fixture без актуального ETag,
  wrong member URL и serial inventory без фактического global-lock witness.
  Исправлены canonical path/version и actual later-table JWT wait, без
  ослабления сторожа. Second261pass, final2 с reassignment262pass.
- Migration first down1 попал на external_program_current, а не новый этап;
  не объявлялся успехом refusal. Существующий176220 timestamp был занят.
  Новый176250 следует всей цепочке; second fresh drill target verified.
- UI first/second178pass/1fail:403 observer ожидал alert/общий текст вместо
  настоящего server refusal. Third179pass, final180pass, final2 с dictionary
 182pass. Это observer failures, не три дополнительных дыры приложения.
- Browser invitations1: wrong «Отправить ответы» вместо существующей кнопки
  «Сохранить ответы семьи»;2 реальных сценария уже прошли. Invitations2:
 4scenario +320h1 clipped (ERR0423). Invitations3:8scenario/zero pageerrors,
  весь RU/EN roster geometry прошёл; затем wrong «Open invitation» observer
  вместо существующего «Open the invitation». Неудачные результаты/PNG kept.
- Fresh full1:1451frontpass/1dictionaryfail на «Гостей пока нет»; backend
  ещё не запускался. Добавлен EN перевод/guard; это не full success (ERR0425).
- Fresh full2:1452frontendpass; backend1761pass/1fail — старый audit55
  ожидал0.62.1 вместо нового canonical0.63.0. Точный invariant не ослаблен:
  обновлён literal/название проверки и audit55 добавлен в focused backend.
  Полный fresh full3 прошёл заново; full2 не принят.
- Browser final1 прошёл9checks, но визуальный просмотр выявил съёмку гостя
  во время вступительной анимации. Harness теперь ждёт computed opacity0
  сцены, прокручивает к списку и проверяет его границы/текст. Final2 остановлен
  на observer tolerance: scrollIntoView дал y=-0.15625px. Допуск1CSS px
  учитывает дробную геометрию. Fresh final3 прошёл9checks; все10PNG просмотрены.
  Repo source при этих корректировках harness не менялся.

## Публикация
Публикация этой новой поставки ещё не объявлена. После actual push/green CI/
merge/main sync источник статуса: attached PR и внешний
`C:/Тили-тили/.unlazy/wp04-event-invitations-20261001/PUBLICATION-CONFIRMED.md`.
Production, реальные SMS/push/платежи/хранилища не затронуты. Провайдеры
не выбраны, правила тарифов/хранения не предоставлены. Нельзя считать все
дыры закрытыми, отдельный RSVP готовым или полный WP04/WP00–WP16 принятым.
