# План локальной реализации экосистемы

Статус: план будущих этапов. База `9628d0b22711782dec121fa4596119e5fb7cce6a`; clone `C:/Тили-тили/ecosystem-local-20260930`, без remote. Связанные [требования](spec.md), [задачи](tasks.md), [основной план](../../wedding-platform-master-plan/plan.md).

## Изоляция и владение

Основной каталог другой сессии не редактируется и не коммитится. Inherited WP03 имеет отдельное происхождение; наш delta оценивается относительно зафиксированного снимка. Snapshot не доказывает приёмку WP03. На каждом интеграционном checkpoint сохранить исходный SHA, manifest изменённых файлов, контракты зависимостей и результаты. Изменения другой сессии не копируются автоматически.

Root-agent — единственный владелец общего OpenAPI, миграций/номеров, generated и интеграционных решений. Генераторы запускаются штатно после согласованной contract delta; generated руками не редактируются. Агенты работают только в явно закреплённых файлах. Общие карты/журналы/источники правды интегрирует root. Локальные feature-коммиты делает root после проверок. main, push, GitHub, production запрещены последней инструкцией пользователя.

WP03-owned зависимости: `backend/src/timeline/**`, program reader/ack/history/digest, events prerequisites, shift/dayx preview/confirm, связанные UI, offline lifecycle и их тесты/миграции. Их не строить заново. Новые commands читают event/timeline identity/version через существующий canonical reader. Содержательные изменения scoped ack обсуждаются на checkpoint; старые подписи или receipts не переписываются в новый смысл. `routes/day.ts`, `Smart.tsx`, основной контракт и shared документация имеют конфликтующие интересы, изменения в них интегрируются root последовательно.

БД/Redis для испытаний изолировать именами/instance от другой сессии: [CLAUDE §3](../../../CLAUDE.md). Не запускать fixture reset или full suite на её среде. Перед первым test/server root фиксирует конфигурацию стенда без секретов и сверяет занятость портов. Ожидание другого checkpoint не препятствует независимой подготовке.

## Архитектурные контракты

Это семантические контракты, не второй OpenAPI или отдельная физическая схема. Точные DTO/столбцы/URL вносит root в существующие источники правды перед соответствующим кодом.

| Область | Контракт и совместимость |
|---|---|
| Composable order | Deal остаётся финансовым/договорным корнем с исходными состояниями. Типизированные части timed service/supply/rental/deliverable/appointment комбинируются; category/profile не определяют единственную часть. Общие actor, event, version, contact, terms, price reference, history. У каждого типа валидируемые значения; произвольный JSON без version/validation не заменяет модель |
| История | Old package/offer snapshot сохраняется как legacy terms с честным unknown там, где отсутствует структура. Не угадывать количество/срок/работника по includes. Старые чтение/бронь/отмена остаются работающими; новый write не стирает legacy snapshot |
| Availability | Явная политика ресурса: личное время/назначенный сотрудник/комплект или согласуемая мощность поставки. Intervals используют event timezone, setup/teardown/manual travel и boundaries. Неизвестное время/ёмкость не становится разрешением. Legacy vendor+date не освобождается без безопасного пересчёта. Импорт не снимает confirmed app booking |
| Несколько назначений | Уникальна конкретная позиция назначения, а не вся категория. Existing slot сохраняет identity. Одна deal может покрывать несколько assignments, отмена scope не снимает чужую работу. Offers/accept/book сохраняют snapshot и конкурентную защиту конкретного назначения |
| Event person | Invitation/RSVP/menu/trip/placement относятся к person/event, family остаётся коммуникационной областью. Legacy data явно относятся к main, без копирования согласия во второй день. Инварианты вместимости сохраняются |
| Terms | Draft/proposed/accepted versions, party actor/time/source, optimistic concurrency. Значимая поправка не наследует consent. Display current/prior separately. Готовность и ознакомление не означают принятие цены |
| Fulfillment | Fact включает origin actor, authority, timestamp, applicable checkpoint и version. Coordinator observation не vendor assertion. No confirmation означает unknown; clock не даёт done. Delivery handed over, received, reviewed, accepted раздельны по применимости |
| Settlement | Actual refund/correction append history/reason/source/idempotency; due/promised/received/disputed различаются. Money contract сохраняет копейки/валюту. Cancelled wedding допускает узкий settlement доступ сторон без восстановления guest/staff operational права |
| DayX | Concrete PlanB event/version/actions/location/owners/preview/recipients и atomic system task init. Выключение или изменение плана не делает действия выполненными. Idempotent operation receipt отдельно от delivery receipts |
| Notifications | Domain event/type, assignment/event scope, significance, principal, dedup/coalescing key, expiry, routing policy. Inbox/store не provider delivery. Выделить push decision из самого хранения; recipient prefs/quiet + explicit emergency override. При delivery повторно проверить доступ/назначение |
| Outbox | Transactional insert с доменной мутацией; claim/lease/attempt/provider accepted/per-provider delivered/user acknowledged не смешиваются. Retry bounded, stale payload suppressed, crash recovery, duplicate provider attempt учитывается честно. Цена fallback выключена без owner limit |
| UX mode | Серверная настройка wedding routing и личные recipient prefs совместимы; режим не authority. Accepted coordinator/backup/handoff, fallback к паре, distinct escalation vs decision. Изменение режима не рассылает историю и не меняет обязанности подрядчика |
| Lifecycle | End-of-celebration вычисляется по последнему выбранному event с известными границами/timezone; unknown остаётся unknown/явное завершение авторизованным человеком. Open outputs/rentals/settlement переживают конец праздника. Guest access не возобновляется |

Legacy `notify()` считает `critical` и день свадьбы обходом quiet/limit. Изменение U10 требует пересмотра основного продуктового правила с записью последней авторизации; нельзя просто переименовать boolean и сохранить blanket bypass. In-app запись не должна исчезать только потому, что push preference выключен. Coalescing допускается для одной обязанности/типа обновления: денежные согласования/разные инциденты сохраняются отдельно. Realtime/badge соблюдают те же scopes.

## Этапы и входные зависимости

Порядок 020–029 из master plan сохраняется для зависимых продуктовых работ. Независимая техническая подготовка WP01 и новое добровольное поведение режима выполняются как изолированные части этого поручения; это не переименование готовности других WP. Если реализация требует изменения порядка, root фиксирует причину и прямую авторизацию в журнале до изменения.

| Этап | Состав и вход | Выходной контракт | Acceptance |
|---|---|---|---|
| S0 | Snapshot, источники/конфликтующие файлы, manifest WP03, baseline и isolated test plan | Root-владение shared; полный реестр открытых критериев | Каждый A/U имеет владельца, dependency и evidence field |
| S1 | Независимые WP01 outbox/capabilities и режимы на текущих Quiz/settings/notify | Durable routing prefs, honest statuses, no blanket quiet bypass, совместимое legacy чтение | U01–05/10, A14; внешняя доставка отдельно |
| S2 | WP04 checkpoint events/person; WP03 canonical identity/version | Person-event participation, multi category assignments, main legacy mapping | A03/08; U07 recipient dependency |
| S3 | WP05 после S2 | Typed policies/resources/intervals/capacity, safe concurrent booking | A01/02; SC010 |
| S4 | WP06 после S3, WP07 prerequisites, files capability | Composable order + all35 briefs, actual staff/scoped duties, versions/fulfillment | A05/06/07/18, U11/12/13 |
| S5 | WP09/10 после S1/S2/S4 и stable WP03 | Applicable priorities/duties, адресная доставка, coalescing/escalation, concrete PlanB | A11/12/13, U06–09/14/15 |
| S6 | WP12/13 с S4 terms | Count once, corrections/refunds/cancel settlement, rentals/deposits/items | A04/15/16; A06 rental |
| S7 | WP14 с S2/S4; WP15 с S6 + event end | Trips/rooms/dates/diet scopes; post-last-event closure/results | A09/10/11/17/18 |
| S8 | WP03 offline dependency + all local stages | Full contract/types/lint/build/DB/Redis/browser evidence, role/negative/failure/race coverage | A19 и SC017/018; release delta local commit |
| S9 | Только при наличии owner/provider/device/pilot inputs | Real device/pilot/restore evidence, простота по наблюдениям | A20/U16, NFR005/009/012; не выдумывать completion |

S1 не закроет всё поведение маршрутизации без scoped duties S4/S5. S2/S3 не называются готовыми при отсутствии проверки старого book/accept/offers. При частичной поставке выводить реализованную границу, не процент полной экосистемы.

## Миграции и данные

Для каждой новой миграции: новая уникальная версия, legacy snapshot fixtures, чистая установка, upgrade с inherited base и populated data, повтор backfill, сравнение identities/counts/money/occupancy/receipts, bad-history fixtures и rollback/forward-fix. Не менять уже применённые migrations. Сохранять исходные источники согласия и доступов; не создавать accepted staff/program/room confirmations из отсутствующей истории.

Инварианты денег/мест/интервалов защищаются constraints/locks и реальными конкурентными тестами; stale write проверяется версиями. После ожидания lock снова проверить wedding/vendor/staff account/session/assignment. Отзыв scopes инвалидирует queue/facts write/cache, сохраняя разрешённую историю. Export/erase/archive охватывают добавленные данные/files/jobs; сроки хранения не изобретать. Если destructive transform нужен, сохранность должна быть проверена до отключения legacy reader.

## Проверки каждого этапа

До изменений root сверяет ERRORS и основные документы области. При API delta root выполняет текущие `gen:contract`, `gen:schemas`, `gen:types` из package scripts; не дублировать их параметры в отдельной системе. Tests включают настоящие DB/API negative witnesses: чужая свадьба/персона/сотрудник, stale consent/version, revoked while waiting, повтор запроса и response loss, concurrent last slot/resource/payment, fail/crash/retry.

UI: RU/EN, загрузка отдельно от пустого результата, отказ/неизвестная величина/нет сети/конфликт без потери черновика и фиктивной зелёной галочки; существующие screen/button maps; 320/390/480 CSS px, keyboard/focus/labels, relevant browser API flows. Full `bash init.sh` — на изолированных PostgreSQL/Redis; никаких server load рядом с full suite. Evidence на exact resulting snapshot/SHA, failures/skipped записываются честно.

UX acceptance: ведущий нормальной программы без существенных изменений проходит работу с 0 обязательных отчётов; подробный режим пары этого не меняет. Сценарий десяти последовательных правок одной обязанности имеет одно актуальное ожидающее уведомление (выбранный тестовый профиль, не гарантия количества всех событий). Old history остаётся; независимое денежное решение не сливается. Pair/coordinator/vendor tests проверяют действие получателя и сохранение права принятия.

## Ворота и ограничения

Намеренных исключений CLAUDE §5/R-01…R-15 нет; новые продуктовые правила ненавязчивости фиксируются в основных источниках root-agent. Local commit — обратимый reviewable результат, не release/merge. Тексты этой feature-папки не являются evidence успешных проверок.

Реальная внешняя отправка/доставка/хранение и restore требуют выбранных провайдеров/конфигурации. Owner задаёт тарифы, платные fallback лимиты и сроки хранения. Новую подписку этот пакет не реализует; существующий WP11 остаётся отдельно. Physical phones и human pilot не заменяются headless. Требования сохраняются открытыми, независимый локальный код продолжается; невозможность их подтвердить отражается в handoff. Не обещать безопасность или идеальность без границ доказательств.
