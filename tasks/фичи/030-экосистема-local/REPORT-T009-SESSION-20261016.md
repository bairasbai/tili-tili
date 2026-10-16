# T009 · исходная сессия предложений и действий позиции · 16 октября 2026

Текущая поставка продолжает merged PR70/main `773b8bd690a88d217f0c1f916d4d82c4229cb76b` в отдельном дереве `wp04-t009-session-20261016`, ветка `codex/wp04-t009-session-20261016`. Полный T009/WP остаётся открыт. Production не затрагивается. Все старые FAILED, аудит, кластеры и чужие dirtytrees сохраняются.

## Поведение и границы

Исходная локальная session/actor, свадьба, slot/request/offer/entries, наблюдённые дата/часовой пояс/права и lifetime формы теперь передаются через существующие wrappers/store в `Options.assertCurrent` настоящего API client. Старая попытка останавливается перед refresh/retry и после позднего ответа, её callback/error/finally не обновляет новую форму. Permanent `closed` принадлежит конкретному reader, поэтому StrictMode setup не открывает старую попытку снова. Источники: `Тили-тили/app/src/lib/useLegacyActionScope.ts:8,25`, `components/OfferRequestComposer.tsx:37,60,86`, `components/OfferAcceptance.tsx:29,45,56`.

Затронуты offer request/accept, vendor package/custom/decline, SlotView cancel/external create/invite/delete/prebooked unmark, shortlist remove и section-private GET SlotCandidates/Compare(slot)/VendorOfferRequests/роль prebooked. Источники: `pages/Wedding.tsx:190,231,246,331,349,370,381`, `pages/Smart.tsx:172,185,190`, `pages/VendorExtras.tsx:94,148,225`, `pages/Search.tsx:1162`; forwarding в `lib/api/{offers,vendor,slots,shortlist}.ts` и `lib/store.tsx:544`.

Штатный refresh с теми же sub/sid сохраняет исходные path/body/key. Ручная uncertainty неизменных offer-команд сохраняет ключ; новая цель/редактируемое тело его не наследует. Slot wrappers сохраняют прежний protocol: ключ на ручной вызов POST, DELETE без ключа; новая manual-loss dedup для них не заявляется. Серверные цены, ACL, event/day resolver, контракт и общий refresh client не изменены. Local guard не отменяет уже совершённый серверный COMMIT; серверный ACL bypass этими тестами не установлен.

OPEN: общие StoreProvider bootstrap/listMyWeddings/getWedding/getSlots/favorites, Compare без slot, остальные разделы и whole privacy; дополнительный legacy_day и смешанные booking/date пути; whole T009/WP. Их готовность не выводится из этой поставки. Старый StoreProvider one-promise StrictMode oracle сохранён.

## RED → GREEN и независимое SOURCE

E=`C:/Тили-тили/.unlazy/wp04-t009-session-20261016`.

- До product edits: `RED-SOURCE.json` и `target-017a1b5d-1f9f-419c-9510-921ff2bceeef`, actual **288 = 157 PASS + 131 FAIL, 0 skip**, exit1/EOF2. Старые134 все PASS, новые154=23PASS+131FAIL. Независимый разбор `RED-CAUSE-REVIEW.md` SHA `E0D622FB1619A99E0D7FF1336340369606EB34C291A621B6546CFF1F81237133` отделяет первые достигнутые assertions от недостигнутых хвостов.
- Held original401 после смены сессии воспроизводил refresh токенов B и повтор старого POST; held200 — старый callback. Контролируется fetch настоящих wrappers/client, не server ACL. Synthetic JWT/DTO не доказывают серверные права.
- Промежуточный `target-2286e34d-417b-45cb-813d-5c149b0154c2`: **286PASS+2 старые FAIL**. Собственный q.reload менял canRequest/key и стирал результат Composer. Временная readiness вынесена в disabled, observed permission остаётся в identity. Tests не ослаблены. Independent SOURCE-v1 также нашёл Compare stale capture после смены selected deal: deps GET дополнены capture.
- Итоговый `GREEN-SOURCE-v2.json` и `target-58242df2-4dfe-470b-a428-8b7a3a751709`: **288PASS/0skip**, exit0/EOF2; прежние134+новые154. Три новых файла сохраняют исходные RED SHA: offersOriginFence `C4670F497FBA08E3F716ADA44BE1FD42DFD79B68941040B7BAE20024E9345AC1`, WeddingLegacyOrigin `8C4EDF8DC5F5D70619C21AC0CC74BD42043A218D371AE06AD04B531B0E834227`, VendorOfferOrigin `1270BB055D313F73531A901051FC4CF721ABF420DB9305578869289BB792A92A`.

Первоначальные тесты:76 offer +48 Wedding +30 vendor=154. Проверены original401/body200, actor/session и наблюдённая queued ABA, смена target/date/permission, unmount, uncertainty/manual key, положительный same-session refresh и pending новой попытки. Граница покрытия: два Wedding body-теста DELETE используют synthetic200, контрактный204 ими не доказывается; compiled HTTP проверяется отдельно. Acceptance terminal UX после перечитывания не принимается одним SOURCE.

После initial full Root и reviewer нашли пропущенный P2: raw edit `foo`→`foo ` сохраняет тело request/vendor reply, но терял uncertain key. SOURCE finding `NORMALIZED-KEY-SOURCE-REVIEW.md` SHA `02EC886AF9CD51CAE3BFAA201842D4E6F113451474B9F47C73DB198675B24C14`; прежний SOURCE-v2 не переписан. Ровно2 новых теста добавлены suffix к сохранённым byte-exact оригиналам. Первое RED-bd4185:288PASS+1 meaningful key FAIL+1 fixture FAIL; последняя требовала отсутствующую «Ответить», когда форма уже открыта. Исправлен только новый suffix, старый FAILED сохранён. RED-53d23038: **290=288PASS+2 final key FAIL**, оба дошли через второй POST и exact path/body/actor/refresh0. `NORMALIZED-KEY-RED-QUALIFICATION-v2.json`.

Root выделил прежнюю нормализацию тела в единые pure builders, используемые проверкой/отправкой/fingerprint. Layout отзывает key tuple при другом serialized body или invalid draft; raw edit по-прежнему закрывает старый reader/busy. Эквивалентное тело сохраняет прежний key, реальное изменение тела/цели не оживляет старую попытку. Итоговый target-2eb46b6c: **290PASS/0skip**, новые77+48+31=156 и прежние134. `GREEN-SOURCE-v3.json`; fresh SOURCE/full-v2 обязательны, initial full не подменяет их.

## Полные CPU gate

Итог после normalized retry fix: `checks-cff51cda-9977-4926-a3a1-0f332b49bfc9`, actual **2907/2907 в136файлах/0skip**; FE types/lint/Vite production build и текущие BE types/build — все6 exit0/EOF2. Расчёт:2751 прежних+156 новых=2907. `FULL-SOURCE-before-v2.json`/`FULL-QUALIFICATION-v2.json`, Root receipt e97392:811 inputs unchanged, dist91/270 exact. `SOURCE-INTEGRATED-REVIEW-v3.md` PASS_SOURCE_ONLY SHA `45ACD0308C5BDE6EA2E4AB82BD62B9B9A27B0C644113875083B46EA2357072F0`, Root прочитал весь отчёт; оба pure builders и original testprefix подтверждены. Предыдущие SOURCE/RED/FAILED/full сохранены отдельно.

Исторический initial `checks-149e8ed6-b6cc-460c-b620-6e1e35320cf8`: шесть стадий, каждая exit0/EOF2 — frontend types, **2905/2905 тестов в136файлах/0skip**, lint, Vite production build, backend types и build. Расчёт роста: прежние2751 +154 первоначальных=2905. Неизменённый backend full suite локально заново не объявляется пройденным.

`FULL-SOURCE-before-v1.json`/`FULL-QUALIFICATION.json`:811 inputs не изменились между запуском и проверкой; production assets91 и backend dist270 закреплены текущими raw SHA. Итоговый compiled runner требует тот же exact full811, включая два versioned .env.example и .gitattributes. Ранний отдельный `CURRENT-COMPILED-SOURCE.json`810/`COMPILED-SOURCE-BINDING.json` — сохранённый промежуточный view, его count не подставляется в admission.

Независимый `SOURCE-INTEGRATED-REVIEW-v2.md` **PASS_SOURCE_ONLY**, SHA `0B93B323CD2A64ADF78D74E9C02B20017D1AC60581C31C435753FAC85E5A75C8`: все17 scoped pins и811 current inputs совпали, оба P2 v1 закрыты. Root прочитал полный отчёт; SOURCE не заменяет compiled/native или independent ACTUAL.

`.gitattributes` дополнена только `text eol=lf` для существующей migration86. На fresh Windows checkout raw CRLF `E32C2F6F59CEB1FDEE2F91EAC014E1B6BDDF224DACA92A2BEF47DC3074037BF2`; ровно CRLF→LF даёт frozen `7AD0E2BCB420BA2350B587282E62EE6E95DD1CA4F59B59BDC20077B5573490D4`. Original сохранён в E; `CHECKOUT-EOL-QUALIFICATION.json`. Canonical backend/migration SQL не менялись, новой миграции нет.

## Compiled/native и уборка

Root actual `session-5dec51aa-a132-44ee-977f-d7565c533d59`, launcher `ui-launch-846958e7-b61e-4c8b-96b2-7adca6a7dfb3`: exit0/EOF2, **9=8 положительных действий+1 ожидаемый отказ**. Запрос основной photo позиции→ответ компании пакетом→принятие→отмена; внешний специалист→приглашение→DELETE204; снятие prebooked204. Девятое действие — реальная отправка из оставшегося открытым редактора компании после закрытия запроса:409/request_closed, сообщение «Запрос уже закрыт», прежнее body и новый key. Все105 таблиц до/после отказа raw-exact, включая idempotency/audit. Production assets фронта, development backend с настоящими JWT/sid/consent в отдельном новом кластере, без Redis/jobs/провайдеров.

**228 browser requests завершены**,69 UI API запросов связаны с native HTTP по actor/path/status/request+response bytes/hash,9 writes и9 просмотренных Root PNG. Page/capture/external errors0; raw console1 — только точный ожидаемый resource409 девятого действия. Других non2xx/auth/aborts нет. До/после каждого действия сохранены105 таблиц; независимый resource order второго мероприятия той же категории, assignment/part/plan/terms/receipts/allocations, даты/история/нулевые платежи сохранены. Не доказываются ненулевые платежи, compiled held401/session-switch/manual-loss, PWA, внешний гостевой вход, общие StoreProvider reads или весь T009/WP.

`ROOT-ACTUAL-QUALIFICATION.json` SHA `D86E4E9FC0741E482EC04CF4E2E2E788C9834E5210B49E4256531AA66B4E54B7`, toolab2f28:104 non-audit таблицы после удаления только собственных fixtures равны baseline, прежние15 audit rows сохранены; всего30=15 прежних+15 новых setup rows. Схема86/105 и811 source/dist91+270 закреплены admission-v2; product code после full2907 не менялся.

Исторический первый `session-eb7990b5-7845-42e0-a655-207a8e1093d3` остаётся FAILED, даже при8 выполненных действиях: redundant goto прервал refresh GET, один finished-body capture failed. Новые отдельные run/browser/ui-v2 ожидают mounted состояние и закрытый capture ledger; старые ошибки не исключены из приёмки. Для буквального G4 добавлен девятый реальный отказ. Независимый SOURCE оснастки-v3 `21E5245BC301A0AB89C93F0106E54C39374CE7D886336E1179DF710A22D35611` принят до запуска. Original source/admission/FAILED, исходный audit15 и все предыдущие тестовые отказы сохранены.

Кластер sysid7697238247262825488/target OID16388 создан отдельно от старых БД. Исходный pg_ctl start остался FAILED из-за EOF=false; текущий сервис принят отдельной read-only adoption-v2 после7 native reads/ROLLBACK, exit0/EOF2. Raw reset после собственного end сохранён отдельной диагностикой по закреплённому driver contract; первая adoption FAILED не переименована. Причина удержания труб старта не подтверждена.

Приложение, браузер и PostgreSQL остановлены. Стоп-launcher также сохранён FAILED: быстрый pg_ctl exit0/EOF2 завершился прежде полного CIM exe/command. Повторного stop или force не было. Отдельные fresh Root OS и PostgreSQL log подтверждают shutdown own PID41744. `ROOT-FINAL-PROCESS-CLEANUP.json`, toole64393:290 записанных identities, собственных живых0/неясных0,5 портов15432/54203/54235/63476/63510 свободны, оба браузерных профиля удалены. Три reused PID с другой birth identity оставлены; кластер и30 audit rows сохранены на диске. Неполный utility witness не объявляется PASS; фактическая уборка доказана отдельно.

## Независимая приёмка и публикация

Свежий independent ACTUAL **PASS_ACTUAL_ONLY**, `INDEPENDENT-ACTUAL-REVIEW.md` SHA `68656AADD2866388CC8EF1B4D738E6715AB93574C5852150C7335B07A281C6AE`, Root прочитал полностью. Отдельно проверены58 refs,23×105 снимков,216 hex/SHA проверок,69 API multiset,9 PNG, source811/build91+270/full2907 и составное доказательство уборки. Не заявляется независимый live CIM или полная OS identity короткого pg_ctl; сохранён observed Root readback boundary.290 identity records содержат259 разных PID, reused3 records/3PID.

Scoped commit/attached PR, CI точного SHA, ordinary merge и fresh main proof фиксируются отдельно в E/PUBLICATION.json. Single fetch453e99 подтвердил неизменный main773b8bd до публикации; guard — без паузы. Production не разрешён. Полный T009/WP остаётся OPEN; следующий ограниченный шаг — защита общих StoreProvider bootstrap/read paths с отдельным RED и планом.
