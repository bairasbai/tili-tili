# T009 · дополнительные бронирования и согласованный перенос · 23 октября 2026

Статус: продукт и браузер проверены; финальный полный CI, независимая приёмка браузерных доказательств и поставка ещё ожидаются. Основа main95e2f85/PR77 повторно подтверждена fetch 23.10. Это отдельный этап; полный T009 остаётся OPEN. Production запрещён. Старые FAILED/audit/данные и чужие dirty worktrees сохраняются.

## Поведение этапа

Дополнительный selected slot с известными собственными DATE/TZ использует точный event context для book/offer/external/first-COMMITTED. Нормализованный заголовок входит в idempotency intent; неверный/чужой/устаревший контекст не получает main fallback. Запрос цены хранит неизменяемый снимок семи полей события; исполнителю показывается собственная фактическая дата, приёмка сравнивает текущие факты отдельно от старого снимка.

Перенос дополнительного мероприятия хранит исходное полное состояние и предложенные DATE/TZ/location. Каждый затронутый заказ требует собственного прочитанного материала и отдельных согласий действующей пары и владельца компании. Последнее согласие не применяет перенос. Только отдельная команда пары после проверки всей актуальной области публикует все новые heads, затем снимает старую занятость в одной транзакции. Цена, оплаты, фиксированные сроки платежей и другие события сохраняются. Отмена предложения сохраняет историю и действующую бронь.

Первоначально поддержаны tracked catalog OPEN roots одного дополнительного события с известным и точно представимым amount. Неизвестная цена и выход за technical safe-integer range не становятся нулём или новой ценой; весь scope получает явный отказ. Известный0 допустим. External/resource/unknown/done/multi-event/активные timed/program/staff/guest обязательства отказывают целиком до истории; они не объявляются пустой областью. Main и прежние terminal правила остаются самостоятельными путями. Полный T009/Stage374/undated-extra не закрыт.

## Изменения и проверяемые источники

- Миграция90 `1763880000000_offer_event_context` — nullable immutable event snapshot без backfill.
- Миграция91 `1763890000000_event_move_agreements` — immutable proposals/roots/receipts/effects, native completeness и preserving down. После применения её файл заморожен наC3A101.
- Forward92 `1763900000000_event_move_snapshot_operators` — четыре пары скобок в одном JSONB validator, literal restore только на пустой истории. PinEC1635, история не переписывается.
- API/domain: `backend/src/orders/event-moves.ts`, `event-move-token.ts`, `routes/eventMoves.ts`, `deals/day-scope-write.ts`; public wire в `Тили-тили_API_openapi.yaml` и штатных generated copies.
- UI: `app/src/pages/WeddingEventMoves.tsx`, `RootEventMove.tsx`, `components/EventMoveReview.tsx`, private discovery в карточках заказов. Отдельные read/accept/apply/cancel; late401/source/session и same-intent retry покрыты rendered tests.

## Фактическая приёмка на checkpoint

Полный frontend:3036PASS/143физическихфайла/0skip, types/lint exit0/EOF2. После обнаружения двух пропущенных локальных импортов выполнена новая сборка:374входа=353src+6public+13root+2build, все exact;95dist побайтно совпали с full3. Независимые ACTUAL reviews `E/FRONT-FULL3-INDEPENDENT-ACTUAL-REVIEW.md`C7C89472 и `E/FRONT-BUILD374-INDEPENDENT-ACTUAL-REVIEW.md`6BC7163C. Сохранены stderr diagnostics и chunk warning. tsc использует общий junction cache .tmp; отсутствие записей в его target не заявляется.

Focused native после92:8validator+23move PASS/0skip; все5native стадий0/EOF2 в `run-migration92-targets-ab4bce7b-be15-45c7-8e82-d2cd0f34fd68`, independent ACTUAL973EA110. Реальные COMMIT/rollback/wait/retry/privacy/material assertions входят в23. Current full92v2 отдельно подтвердил новые activation50/validator8/move23, но весь full был FAILED и не назван зелёным.

Whole preserving v3 прошёл8native стадий0/EOF2 на новой DB65720;246входов exact. Применённые90/91/92 неизменны. Прежний принятый v2/DB53285 сохранён отдельно со всеми112таблицами literalexact. Независимая ACTUAL приёмка `E/DRILL92v3-INDEPENDENT-ACTUAL-REVIEW.md`2AFC35CB подтвердила29новых CLI controls, настоящий AX55P03 и preserving OID/catalog/raw. После этого изменён только HTTP cache hook и одна проверка заголовка; миграции, model и drill неизменны. Повторный current preserving drill обязателен в финальном CI.

Full92v2:4060=3860PASS+14FAIL+186pending/170файлов, native28228 exit1/EOF2, все475входов после прогона exact. Два historical beforeAll не допускали92; остальное — устаревший pending-код и fixtures, меняющие immutable quote/committed event. Исправлены только пять тестовых файлов с сохранением финансовых/rollback assertions и новым native23514 control. Target324/5файлов/0skip прошёл, все4native0/EOF2; independent ACTUAL B171C882. Затем full3 дал4058PASS/2FAIL из-за20s source-receipt timeout; данные65719/13167audit сохранены под FAILED. Без изменения assertions и timeout full4 с `--maxWorkers=4` прошёл4060/170/0skip, types/lint/build и92UP, все9native0/EOF2. Независимая ACTUAL8F84BBD4 относится именно к sourceC529. Причина прежней задержки CPU/IO не измерена.

Настоящий compiled HTTP обнаружил потерю `private`: общий onSend переписывал preHandler header в `no-store`. Добавленная проверка private дала meaningful RED M1 на GET200; прежние FAILED сохранены. Тот же scoped header перенесён в child onSend с возвратом payload. Изменены только `routes/eventMoves.ts` и одна строка `additionalEventMove.test.ts`; current475 manifest6678C9EA. Все23case, types/lint/build прошли. Первый post отказал при autovacuum; последовательность остаётся FAILED. Повторён только неизменённый read-only observer:0EOF2, все69112старых строк/12680audit сохранены, добавлены171audit+1own resource. БД не объявляется пустой. Независимые SOURCE A624669D и ACTUAL5821ADD6 приняты; обязательный full итогового SHA выполняется CI, прежний4060 не выдаётся за full нового source.

Compiled retry на свежей87501:13/13PASS,0skip,130настоящихHTTP request/EOF; все65ответов move-proposals/event-moves содержат private,no-store. Старый неудачный compiled83373 сохранён переименованием;112таблиц/10audit literalexact. Реальный API buildApp без overrides,286dist; FE95dist на374входах. В браузере RU/EN/320/390/480: отдельные GET material, checkbox/keyboard и4реальных согласия на2заказа; после четвёртого дата16июля/effect0. Отдельный apply200 изменил на18июля/EuropeMoscow/effect1. Все16финансовыхтаблиц exact в3native snapshots; основное мероприятие literalexact. Созданы additional event20июля и позиция черезUI; каталог использует20июля, а не основную14июля. Бронирование этой третьей позиции черезUI не заявляется.

Контроль потери ответа: genuine POST201 черезroute.fetch, затем обрыв клиенту; явный retry с тем же ключом вернул201/тот жеID, вnative snapshot ровно1позиция с этимlabel. Первый interceptor ошибся APIResponse.allHeaders после настоящегоPOST; отдельный FAILED сохранён, тест повторён на другом синтетическомlabel с headers(). Product не менялся. `E/COMPILED-CACHE2-BROWSER-ACTUAL.json`, `COMPILED-CACHE2-BROWSER-ROOT-COMPARISON.json` и3просмотренныхPNG сохраняют actual. Scoped cleanup native39296/0EOF2 восстановил non-audit baseline и сохранил audit; own вкладка закрыта, Web9620/API18724 штатно nonce-closed0EOF2, обаPID absent/57297+57298free в `COMPILED-CACHE2-CLOSED-OS.json`. Независимая ACTUAL всего compiled/browser набора ещё ожидается.

Meaningful RED F0/M0 до реализации, UI18=10PASS8FAIL, firstmove23=1PASS22FAIL до proposal, S0native22P02 сохранены. Новая failedmove1 DB27834 содержит все111non-audit таблиц literalexact и66retained audit; новая GREEN33002/schema92 используется отдельно. Три прежние FAILED own cluster16384/20202/24018 повторно прочитаны после восстановления: все108таблиц/журналы/аудиты literalexact. Старый отдельный PG cluster предыдущего этапа не запускался.

## Открытые гейты этого этапа

- Обязательный полный current-head CI: frontend/backend/types/lint/build, preserving drill и isolated native49, без скрытых skips.
- Независимая ACTUAL приёмка сохранённых current compiled TCP/browser/cleanup доказательств.
- Scoped commit/attachedPR/current-head CI/fresh main/обычное слияние и финальная проверка сохранности/уборки.

E=C:/Тили-тили/.unlazy/wp04-t009-additional-20261021. Точные команды/native exits/raw JSON/source pins лежат там; старые протоколы не переписаны. После завершения дополнить этот checkpoint фактическими финальными результатами; pending не означает выполнено.
