# Активная поставка: FR012 · 2026-10-07

- [ ] [FR012: честные обозначения отметок и документов](wedding-platform-master-plan/wp00-fr012/tasks.md). Базаmain8ccb9ea/PR52; ветка codex/wp00-payment-evidence. Реализация/генерация/типы/линт и targeted завершены: UI151PASS + native198PASS; начальный RED24FAIL/6PASS сохранён. Последующий порядок: review→full→browser→CI→merge. Общие сервисы только root; новая инструкция о качестве и скорости применяется.
- [x] FR011 опубликован и объединён: [PR52](https://github.com/bairasbai/tili-tili/pull/52),7CI SUCCESS, main8ccb9ea, локальная сверка/ALL MET8. Ни отдельная фича, ни число тестов не означает завершение WP; полных пакетов0/17.

## Исторические границы

# FR011 · текущая граница · 2026-10-07T16:08:20.316Z

Checkout C:/Тили-тили/tili-orchestrate-publish-20261003; branch codex/wp00-payment-corrections; исходная интеграционная база main322a73632d6a72ddebdb1399f995813072608698/[PR51](https://github.com/bairasbai/tili-tili/pull/51). Featuread07324 и merge6bf9fcc сохранены; финальный коммит ещё ожидается. Полный init.sh: 2262 frontend + 3345 backend = 5607 тестов, 0 failures/skips; все 8 этапов типов, тестов, lint и сборки прошли. Собранные UI/API через nginx: 6 сценариев, 115 запросов и 115 завершений; HTTP>=400, console/page/request errors — 0, журнал Python пуст. Шесть изображений RU/EN при ширине320/390/480 просмотрены root. Native-проверка сохранила payment ID, квитанцию, сделку и состояние ресурсов; две правки100000→125000→NULL и одна правка этапа записаны в истории. Cleanup сохранил 89 прежних audit rows и вернул исходные counts; providers0. Исходники и обе сборки до/после совпали.

Допуск C04/C05 закрыт на ровно83 прежние и85 текущие миграции. Старый список83 сохранён; две новые миграции закреплены по имени и SHA256. Перед чтением файлов валидатор сверяет весь переданный список с закреплённым. Настоящий GitHub job получает85; локальный83 допуск на текущем85 каталоге отклоняется до БД. Обязательные исходники включают регрессионный тест; исходные19 worker cases и остальные native guards сохранены. Целевые18 tests прошли; замечания независимого ревью v1 закрыты v2. Реальный isolated native lane будет подтверждён GitHub CI этой поставки.

Полных WP **0/17**; 17=16−0+1. FR011 — часть WP00, остальные критерии FR/SC/NFR/A/U, M01/WP11, провайдеры, устройства и решения владельца сохраняются. Публикация проверенных фич разрешена пользователем; на границе этого снимка final commit/push/PR/CI/merge ещё ожидаются. Production deployment этой поставкой не выполнялся.

Следующий шаг: проверенный final commit → push/PR → exact-head CI → разрешённое merge/fetch/tree/source equality. Не повторять вопрос о разрешении публикации. Root — единственный владелец PG15432/Redis12/API/browser/GitHub; guard перед GitHub, CI-запросы не чаще3мин,403/429/rate/auth→стоп. Heartbeat30 PAUSED; отчёт вручную каждые30мин активной работы.

Источники: [full](C:/Тили-тили/.unlazy/wp00-fr011-20261007/full-v7.json), [browser](C:/Тили-тили/.unlazy/wp00-fr011-20261007/browser-qualified-v3.json), [native](C:/Тили-тили/.unlazy/wp00-fr011-20261007/browser-be877291-df26-4a1e-ae84-4b1377a02321/native-verified.json), [cleanup](C:/Тили-тили/.unlazy/wp00-fr011-20261007/browser-be877291-df26-4a1e-ae84-4b1377a02321/cleanup.json), [просмотренные изображения](C:/Тили-тили/.unlazy/wp00-fr011-20261007/browser-be877291-df26-4a1e-ae84-4b1377a02321/viewed-images.json), [PWA](C:/Тили-тили/.unlazy/wp00-fr011-20261007/pwa-integrated-qualified-v2.json), [допуск CI](C:/Тили-тили/.unlazy/wp00-fr011-20261007/c04-c05-current-preflight-v2.json), [ревью допуска](C:/Тили-тили/.unlazy/wp00-fr011-20261007/C04-C05-FR011-ADMISSION-REVIEW-v2.md), [гейты](C:/Тили-тили/.unlazy/wp00-fr011-20261007/GATES.md).

## Историческая граница FR002 · 2026-10-07T10:37:12.462Z

Пользователь возобновил весь WP00–WP16. Контакт внешней договорённости реализован и локально принят: [задачи](wedding-platform-master-plan/wp00-fr002/tasks.md), [отчёт](wedding-platform-master-plan/wp00-fr002/REPORT-20261007.md). Checkout C:/Тили-тили/tili-orchestrate-publish-20261003, branch codex/wp00-external-agreements, базаmain459b820188ccd35d23a3afadf1eb1fe5c576f6e4/PR49.

Полный init.sh: frontend 2192 + backend 3278 = 5470 тестов; ошибок/пропусков0, все8 этапов types/tests/lint/build прошли. Actual compiled Chromium/nginx/API: 5 сценариев, 304/304 запросов завершены, HTTP>=400/console/page/request failures0;6 PNG RU/EN320/390/480 просмотрены root. Native fixture сохранила существующие платежи/снимки/receipt; исполнитель не подтверждал условия. Cleanup восстановил baseline counts, сохранил69 прежних audit rows, итог72; provider calls0. Source/build до и после совпали. Это проверка тестового стенда, не production/физического устройства или installed/offline PWA.

Источники: [full](C:/Тили-тили/.unlazy/wp00-fr002-20261007/full-v3.json), [browser qualification](C:/Тили-тили/.unlazy/wp00-fr002-20261007/browser-qualified-v1.json), [raw browser](C:/Тили-тили/.unlazy/wp00-fr002-20261007/browser-ac1aed8c-5bb4-4ff5-8390-0f6fcba190f0/browser-result.json), [native](C:/Тили-тили/.unlazy/wp00-fr002-20261007/browser-ac1aed8c-5bb4-4ff5-8390-0f6fcba190f0/native-verified.json), [cleanup](C:/Тили-тили/.unlazy/wp00-fr002-20261007/browser-ac1aed8c-5bb4-4ff5-8390-0f6fcba190f0/cleanup.json), [production review](C:/Тили-тили/.unlazy/wp00-fr002-20261007/REVIEW-v1.md), [final source delta review](C:/Тили-тили/.unlazy/wp00-fr002-20261007/REVIEW-v2.md).

Следующий шаг: feature commit/push/PR → exact-head CI → разрешённый merge/fetch/сверка main; на этой границе публикация ещё не выполнена. Root единолично управляет PG15432/Redis12/browser/GitHub. Schema83/существующие тестовые БД сохраняются, DDL/drop/reset нет.

Полные WP0/17 (17=16−0+1); FR002 contact не закрывает пакет. Следующий source-confirmed пробел — FR011 correction/visible history, без void/провайдерских переводов. M01/WP11/provider/device/human и все прочие критерии общего реестра сохраняются. Публикация проверенных фич разрешена, production deployment — нет. Heartbeat30 фактически PAUSED, инструмент не подтвердил update; отчёты вручную во время работы. [Ledger](C:/Тили-тили/.unlazy/wp00-fr002-20261007/GATES.md).

## Историческая граница 2026-10-07T08:46:46.260Z

- [x] FR018 403/404: исправлены Home/WeddingTeam/Budget и определение владельца анкеты.
- [x] Проверка 2026-10-07T08:46:46.260Z: frontend 2186 + backend 3247 = 5433 тестов, без ошибок и пропусков; все восемь этапов types/tests/lint/build прошли. Chromium V14 2cab6b03-97e1-45f1-b265-bd22f8c501a3: 7 сценариев, 6 раскладок RU/EN 320/390/480, 12 PNG; browser HTTP403/404 = 0, лишних vendor/profile запросов = 0, helper budget/tips запросов = 0. Строгий прежний классификатор console прошёл; ожидаемый 409 устаревшего предложения проверяется по фактическому запросу. Сохранены 66 immutable audit rows; 16 mutable fixture counts = 0, provider calls = 0. Source/build до и после совпали.
- [x] История V11/V12/V13/full failures сохранена; карты экранов и кнопок обновлены.
- [ ] Проверить фактическую публикацию codex/fr018-browser-access, CI конкретного head и main merge. Этот документ фиксируется перед feature commit.

Полные WP00–WP16: 0/17. Широкая работа и heartbeat30 на паузе; следующий этап после текущей поставки — уточнение продолжения остальных WP.

Источники: [полный запуск](C:/Тили-тили/.unlazy/codex-planb-20261003/fr018-browser-fix-evidence-v7/full.json), [фактическая браузерная квалификация](C:/Тили-тили/.unlazy/codex-planb-20261003/wp00-fr018-pwa-v14-qualified-root.json), [независимый source review](C:/Тили-тили/.unlazy/codex-planb-20261003/wp00-fr018-pwa-sc004-v14-fresh-review-v1/REVIEW.md).

## Исторические записи ниже

# Текущий план

Одна активная задача за раз. Пункты отмечать по ходу, не в конце.
Готово = типы + тесты + линт + сборка прогнаны, вывод показан.

## Актуальная граница · Codex, 2026-10-03

Новое поручение: продолжить весь WP00–WP16 end-to-end, поэтапно проверять, документировать и публиковать в main. Свежий fetch: main `58349e0`, черновик Claude `de414fa` (модуль уже добавлен в `93028a2`). Работа идёт в отдельной `codex/030-380-inventory-completion`, исходные checkout/ветка сохранены.

- [x] Найти актуальную работу Claude и сверить remote с локальными передачами.
- [x] Создать/установить собственный tili-orchestrate, реальная native multi-agent fixture106pass; отдельный635c9f6, PR35/7CI SUCCESS, maina18695b.
- [x] Воспроизвести отрицательные SQL/cascade сценарии, исправить380 до полного наката, затем confirmed repointed-day gap отдельной381. Targeted74/74; source-only независимое review381; nativeupgrade сохранил прежние строки102таблиц.
- [x] Final preserving drill20:24own migrations through381,128SQL/19CLI refusals, обе actualmixedmanual/cascade race orders committed; [отчёт](фичи/030-экосистема-local/REPORT-INVENTORY-20261003.md).
- [x] Проверить модуль/миграции 030/380+381, preserving migration drill и SQL-отказы по [контракту](фичи/030-экосистема-local/c380-inventory-contract.md).
- [x] Целевые PostgreSQL-тесты, полный init.sh, типы/линт/сборки, анализ замков/каскадов, локальный отчёт.
- [x] Финальный init.sh после исправления phone fixture: front112/2105, backend146/3135, без пропусков; типы/линт/сборки прошли. Все680 файлов manifest совпали после прогона. Источник: full-codex381-final.log. Прежние failures сохранены.
- [x] Inventory PR36: exact d936458 local full112/2105+146/3135=5240/no skips/types/lint/build,680source hashes current;7CI SUCCESS; actual merge2ef67b5 fetched. Original Claude PR32 reports MERGED with unchanged headde414fa; original checkout cleanbde3e40.
- [ ] Продолжить WP10/A13 и 371–374/остальные WP. Plan B red:17failed/11pass; new28+audit6=34passed. Fresh review завершён, full planb-full1:2105+3163=5268passed/no skips/types/lint/build,681 hashes совпали. Current whole nginx PWA/6PNG accepted:9checks/10consumed waits/raw6 expected6 unexpected0;7failed runs retained. Nginx отдельно опубликован/7CI SUCCESS/merged PR37 (efb4f7e); отдельная поставка A13/CI/main pending; T023 key schema и A12 обязательны.

Исторические границы ниже не заменяют текущую проверку.

Наша ограниченная поставка 030 уже в main через PR №27. Продолжение Клода вошло в PR №29–31; проверенный коммит — `4f6381d`. Повторная приёмка: 2105 тестов фронтенда / 3067 сервера, без пропусков, типы/линт/сборки; браузерная замена HTTP 409/200 и RU/EN 320/390/480. `wt/pa` уже отсутствует, повторное удаление не требуется.

Текущая задача этой сессии — опубликовать итоговые документы, проверить CI, подтвердить merge и остановиться. Источники и полная инструкция: [REPORT-CLOSE](фичи/030-экосистема-local/REPORT-CLOSE-20261003.md) и [CLAUDE-CONTINUE](фичи/030-экосистема-local/CLAUDE-CONTINUE.md), раздел 15. Следующий 380 — непринятый черновик: remote `6a0e6a3` новее local `bde3e40`; модуль и репетиция не закончены. Широкие WP/A/U остаются открытыми.

## История поручений WP00–WP16 · записи ниже сохранены для контекста

Следующие записи отражают состояние на момент их написания. Их «текущие задачи», pending-публикации и команды очистки не являются действующим планом; актуальная граница указана выше.

Текущая задача (2026-10-03, Claude): хвосты §3 из `C:/Тили-тили/.unlazy/tz-full-20261002/HANDOFF-NEW-CHAT.md` по порядку, новое не начинать; потолок расхода ~95% (решение владельца «А»). Работа — на GitHub, затем ПК приводится к GitHub 1 в 1. T012 (PR #29), PR #30, PR #31 (хвосты 3/4/6), PR #33 (плавающий clickstorm) — в main.
- [x] №1 worktree `C:/Тили-тили/wt/pa` удалён локальной сессией (junction без `/s`, `git worktree remove` без `--force`).
- [ ] №2 этап 370 — ветка `feature/030-370-legacy-inventory`, PR #32: модуль + миграция + тест 60/60, регрессия 376; осталось: репетиция миграций (drill17/18, `inventoryForwardFixture`), полный прогон, независимое ревью, CI, merge.
- [x] №3 T012: пояс гостю словами, без «Имя · Имя» у пары (PR #31).
- [x] №4 CI: уникальные имена browser-проверок (PR #31); [ ] сделать их обязательными в защите main — действие владельца (админ).
- [ ] №5 браузерные оракулы 030 — после 370.
- [x] №6 deep-link под nginx: 404 не воспроизвёлся, белая страница на адресе со слешем исправлена (PR #31, ERR-0427).
- [ ] ПК 1 в 1: после 370 и №5 — основной checkout на main (через локальную сессию).
Следующий шаг: репетиция миграций 370 → полный прогон → ревью → PR #32 зелёный → влить; затем №5.

Текущая задача (2026-10-02, Claude): публикация T012 из 022 → затем 030 этапы 370–374 → остальные WP. Ведомость драйвера: `C:/Тили-тили/.unlazy/tz-full-20261002/PLAN.md`. 030 опубликован: PR https://github.com/bairasbai/tili-tili/pull/27, merge2026-10-02T06:31:56Z(aa85f88), CI7/7, включая фикс «двойное «Сохранить» первой анкеты» (LOCAL-030-31). T012 (персональный RSVP/дедлайн дополнительных мероприятий) реализован и проверен локально: контракт0.70.0/6операций(0da3e23), targeted4files/68tests, весь фронт111/2085, backend T012131+regression266 на свежей полной БД, после независимого Opus-ревью155+quiet/notify318 на dev-БД, migration drill22own/12T012refusals+1guarded down, browser9/9/zeroerrors RU/EN320/390/1440 — факты и ревью-фиксы в REPORT-RSVP.md, правила в ERRORS.md. PENDING: полный `bash init.sh` на финальном дереве, CI, merge владельцем — следующий шаг.
Прежняя задача: [022: персональный состав приглашённых](фичи/022-мероприятия/REPORT-INVITATIONS.md), не весь WP04. CRUD UI опубликован/влит PR25 (main04a8355/all7CI SUCCESS/local clean/source569match). Продолжение в feature/event-rsvp-20261001: person/event roster, private family projection, реальный выбор в UI; legacy RSVP остаётся основной программой. Дедлайн утверждён: общий для события, до конца выбранного дня по его часовому поясу. Опрос об основной дате всё ещё без ответа. Production запрещён.
Последнее поручение владельца: закончить эту поставку/проверить CI/влить PR26, передать полную инструкцию Claude и остановиться. Новую T012 в Codex сейчас не начинать. Инструкция: [CLAUDE-CONTINUE.md](фичи/022-мероприятия/CLAUDE-CONTINUE.md); actual merge/main/local sync подтверждается внешним PUBLICATION-CONFIRMED.md и PR26 после выполнения.
Новый scoped full прошёл1452frontend/1762backend/no skips/init0; actual production preview invitationsfinal3:9checks/zeroerrors/all10PNG inspected/source574match. Источник: REPORT-INVITATIONS.md. На границе этого коммита следующий шаг — scoped commit/push/CI/main; actual remote статус только во внешнем `.unlazy/wp04-event-invitations-20261001/PUBLICATION-CONFIRMED.md` и attached PR после публикации. Затем отдельные RSVP по person/event, этот календарный deadline, обращение после срока и организаторский источник коррекции. Master T010/WP04 и остальные WP00–WP16/SC/NFR остаются открыты; старые pending-публикации ниже исторические.

Current reminder claim scope,2026-10-01:
Latest continuation after PR23:
- [x] PR23 merged after7displayed GitHubSUCCESS, main9cf734f local/fetched0/0/clean/source565match. Production untouched.
- [x] Actual HTTP200 sent1/failed1 with controlled adapter, old UI hides failure; corrected permanent8before2:3failed/5passed. Initial EN expectation typo and Windows external fixture URL error retained, not product defects.
- [x] Display failed as Not sent/Не отправлено in RU/EN, separate from skips/HTTP refusal; role=status. Focused5files56pass/types/scopedlint0.
- [x] Fresh resultfull1 full1401front/1733back/no skips/types/wholelint/build/init0/source566hashmatch.
- [x] Actual production resultafter1 browser10checks/zeroerrors/all7PNG inspected RU/EN320/390/1440/nav geometry; source566hashmatch, no own listeners/privatefixtures. Maps/report updated.
- [ ] Scoped result commit/push/CI/main; accepted-batch/real-provider/allWP acceptance unchanged.
- [ ] Accepted-batch survey/providers/events/RSVP/transfers/delegation/SC/NFR/allWP remain; no real SMS or production.

- [x] PR22 actual7/7GitHubSUCCESS merged, main ce3bc97 local/fetched0/0, source564hashmatch. Earlier pending-publication records below historical.
- [x] Next external actual PG probe8/8 stale reminder claim200/controlled sender1/mark written after access withdrawal, source38feafb. No real SMS.
- [x] Permanent15before2:13fail/2pass incl actual SELECT1/0 stale claim/old failure erasing newer mark; logs retained. Focused after10files292pass +guard5/type/lint0.
- [x] Correct transactional claim/recipient selection/current access/finalJWT, dispatch only after commit, reset only own failed claim/exact PGprecision. Accepted-batch withdrawal policy remains separate/pending owner survey.
- [x] reminderfull1 fresh full1393front/1733back/no skips/types/wholelint/build/init0. Actual reminderui3 Chromium8checks/zeroerrors/all4PNG inspected320/390/1440/actual nav bounds; source565hashmatch, no own listeners/privatefixtures. ui2 smooth-scroll measurement failure retained and harness corrected without product changes.
- [x] Reminder claim scoped commit0ec52f4/PR23/green CI/main9cf734f; failed-counter UI continuation above. All WP obligations preserved, production forbidden.

Публикация и продолжение,2026-10-01:
- [x] PR21 влит после7/7 GitHub checks SUCCESS, main локально/remote f9ccfa1,0/0. Оба набора кода сохранены; merged full1393front/1678back, guest9/payment5 Chromium. Payment migration drill genuine CI failure исправлен и проверен, production untouched.
- [x] GET guests/tables actual39before34fail/5pass; current transactional read access/role projection/finalJWT, cancelled wedding history preserved. Focused after2:219pass; serial/shared-table observer correction and audit53 strengthened. REPORT-GUEST-READ-ACCESS.md retains failed after1.
- [x] Current guestreadfull1 full1393front/1718back/no skips/types/wholelint/build/init0. Actual production readguest1 nine/readseating1 fourteen checks,zeroerrors/all16PNG inspected; source564hashmatch. No listeners/privatefixtures, PG15432 retained.
- [x] Scoped guest read published/merged PR22 with green CI, main ce3bc97 boundary recorded above. Reminder claim continued; owner stop-on-withdrawal survey pending. All event/RSVP/transfers/delegation/SC/NFR/WP obligations remain; no provider delivery claimed.

Локально проверен scoped guest write access,2026-10-01:
- [x] Actual before58cases52fail/6pass; stale access/role/privacy/expiry and premature family201 reproduced. Transactional fresh access/projection/final JWT and post-COMMIT response fixed, same ACL/family/import semantics.
- [x] Expanded actual PG after3:180passed=72new+60seating+22family+26consent. Real interrupted after2 retained as failure; same retained PG recovered15432, no data deletion/production env changes.
- [x] Pre-layout full fresh1385front/1674back/no skips/types/wholelint/build/contracts/init0; actual guestafter2:7checks/zeroerrors/all3PNG inspected. Wrong proxy-response observer failure retained, then corrected.
- [x] Mobile heading clipped: actual guestlayoutbefore7checks then geometry failure, compact accessible Invite action fixed.126 entries but new Wedding.tsx hash; first manifest retained separately. Final guestwrite3 full1385/1674/no skips/types/lint/build/contracts/init0; actual guestfinal1:9checks/zeroerrors/all5RUEN PNG inspected/geometry/navigation/hashmatch, scoped docs/gates only, not whole-WP acceptance.
- [ ] Next: actual guest/table GET privacy after waits and reminders bookkeeping/consent, then event invitations/RSVP/transfers/agreed delegation and all SC/NFR/WP.

Исторический125 checkpoint CORS,2026-10-01:
- [x] Original before-fix HTTP3fail/7pass, actual Chromium corsbefore1:8 checks/3CORS failures/no SQL changes. Isolated methods allowlist; HTTP10pass, corsafter1:9 checks/private401/403/stale409 preserved, all3PNG inspected. No wholeclone app.ts import.
- [x] Full fresh1385front/1602back/no skips/types/wholelint/build/contracts/init0; final actual corsafter2:9checks/zeroerrors/all3PNG inspected/current125hashes. REPORT-CORS-WRITES.md, scoped docs/manual gates, not wholeT009/WP00-WP16.124 below historical.
- [ ] Следующий этап: actual witnesses для остальных guest doors/reads и commit-before-response; затем event invitations/RSVP/transfers и agreed delegated integration/SC/NFR/full WP. Static review не объявляет неподтверждённые дефекты исправленными.

Локально проверен seating live write access,2026-10-01:
- [x] Реальные PG blocker/wait before2:44failed/48passed =5doors×8access+2phone-write+2private projection; реальные поздние expiry200 вместо401. Fix2:104passed включая held locks. Новые atomic vendor-update/version rollback/allowed controls ещё проверяются.
- [x] Scoped transactional access/sole consent reader/locked-role privacy/final expiry rollback, unchanged ACL/person capacity. Focused108/full fresh1385front1592back/no skips/types/lint/build/contracts; actual Chromium seating5:14checks/all11PNG inspected/zeroerrors,124hashes. REPORT-SEATING-LIVE-ACCESS.md; scoped docs/gates ниже не равны entireT009.
122-source lifecycle inventory ниже исторический;124 current до следующих source edits.

Локально проверен T009 lifecycle hardening,2026-10-01, full scope не сокращён:
- [x] Before-fix5 failures: late old wedding overwrote copy, abandoned reader persisted; lifetime/latest request/ref guard и DayX cleanup. Focused222 Seating /22 update+SW, bounded-stream before-fix witness также сохранён.
- [x] Exact scope-owned static SW caches; не читать/удалять чужие app/subpath caches. Waiting new worker/explicit dialog/cancel, old cold shell до approval/new offline shell после; body drain до ожидания всех headers, fail-closed complete installation.
- [x] Final full-hardening-final3:1385front/1532back без skipped/types/lint/build/contracts, fresh migrated actual PG/Redis13. Actual pair3 production upgrade10:9checks/all8PNG inspected; seating4:14checks/all11PNG inspected; zero page_errors. REPORT-OFFLINE-LIFECYCLE.md,122-source hashes; final docs/gate status ниже не заменяет целую фичу.
Предыдущие117/106-source manifests исторические;122 current только до следующих source edits.
- [x] Seating write principal/consent/phone-role after actualPG waits проверен новым отчётом выше. Другие guest doors/reads ещё не охвачены этим helper.
- [ ] Следующий scoped этап: отдельно reviewed CORS patch и actual cross-origin write; затем other guest doors/reads, events/delegation/SC/NFR/full WP.

Локально проверен T009 seating/cold critical routes,2026-10-01; не весь T009:
- [x] Actual PostgreSQL: separate named primary/secondary one-seat assignment; compatibility plusOne повтор не вставляет скрытого человека вместо существующего named second; legacy placeholder follows primary, отдельная посадка и atomic capacity refusal. Before-fix4fail/16pass (два уточнения неверной fixture expectation сохранены), after-fix22pass.
- [x] До изменения4 frontend failures: physical family rows3/2 вместо2/2,1person2/2 вместо1/2, mutators offline/no snapshot; после исправления16lifecycle+23projection+6build/SW cases, regressions215pass.
- [x] Минимальный seating snapshot после обоих успешных чтений/согласованных assignments и actual member role; captured device times отдельно, без atomic/version/retention/чувствительных полей; optional actual DayX preparation до посещения рассадки.
- [x] Offline read-only/no mutation/replay, cleanup известных refusal/session/consent/cancel/list-membership, generation guards; fresh reconnect/reset editor и409 сохраняет ошибку/форму.
- [x] Build-derived critical static assets, actual cold route/SW14checks/zeroerrors/all11PNG inspected320/390/1440; fresh migrated full1373frontend/1532backend no skips/types/lint/build/contracts. REPORT-OFFLINE-SEATING.md;117source hashes, scoped gates проверяются после docs. Delegated/events/SC/NFR/all WP остаются.
- [x] Pending seating preparation/SW scope и upgrade проверены новым локальным lifecycle checkpoint выше; это не whole T009.
- [ ] Реальные stale authorization после waits, event invitations/RSVP/transfers и actual согласованная delegation интеграция остаются.

Проверен локальный T009 registered/external contractor reader, не весь T009:
- [x] Реально воспроизвести исчезновение разрешённой программы valid session/link при offline:2failed до реализации.
- [x] Валидированный минимальный program snapshot, отдельный namespace для зарегистрированной сессии и SHA256 внешней ссылки; без raw token/read proof/служебных полей.
- [x] Read-only readers/list navigation, observed receipt отдельно от current server, reconnect fresh/no checkbox/POST/chat replay; known refusal/session/consent/cancel cleanup и late response guard.
- [x] Focused163/full fresh migrated1328frontend/1526backend no skips/types/lint/build/contracts; actual production SW/Chromium offlineprogram3:15checks/all12PNG inspected320/390/1440, report/maps/errors updated. Scoped manual gates status/approve ALL MET4, не весь T009. Delegated/cold critical routes/рассадка всё ещё обязательны.
- [x] Следующий локальный участок seating/cold opening описан выше и в REPORT-OFFLINE-SEATING.md; прежнее отсутствие seating кода историческое, не текущее. Это не full T009 acceptance.

Проверен локальный T009 DayX lifecycle, не весь T009.
- [x] До исправления: копия после HTTP404/смены сессии, LIVE после offline event; отдельный reconnect404 status witness и два реальных PG invitation commit/rollback witness.
- [x] Session-bound минимальный снимок с версией и captured event zones; fallback только при недоступности, read-only действия, очистка при известных отказах/выходе/смене сессии, запрет восстановления поздним ответом; HTTP201 приглашения после COMMIT.
- [x] Focused160frontend/173backend; fresh migrated full1269front/1526back без skipped/types/lint/build/contracts, Chromium offlineday8:13checks/eightPNG inspected — REPORT-OFFLINE-DAY.md.
- [x] Report/maps/business/JOURNAL/ERRORS/handoff/coordination updated; scoped manual gates status/approve ALL MET4. Manifest101 SHA256 sent to user-authorized parallel task, no source integration/remote operations.
- [ ] Принять все T009 readers: registered/external/delegated lifecycle, cold critical routes/рассадка/остальные offline сценарии, финальные SC/NFR. Один warm DayX не закрывает полный T009.
Следующий шаг: offline рассадка/остальные критичные маршруты и cold-route сценарии, затем event invitations/RSVP/transfers и согласованная delegation интеграция. Registered/external snapshots проверены в REPORT-OFFLINE-PROGRAM.md; полный WP00-WP16 сохранён.

Проверенный checkpoint: external team receipt (не завершение WP03).
- [x] Atomic explicit current-link pointer при выдаче; миграция без выдуманной исторической очередности.
- [x] Team summary exact current link/deal/version/digest, anonymous source label/history, no old-link green fallback.
- [x] Actual DB119/frontend71, full1219/1483 no skipped/types/lint/build/contracts, migration14 и Chromium externalteam2:17checks/eight regions+viewport320 reviewed — REPORT-EXTERNAL-TEAM-ACK.md.
- [x] Reports/maps/business/JOURNAL/ERRORS/handoff/scoped gates status/approve ALL MET5; CRLF diff check exit0. Не весь WP03.
Текущий checkpoint: full legacy external cabinet/chat rights after waits. Параллельная
аудит-сессия работает изолированно; [границы](wedding-platform-master-plan/COORDINATION-20260930.md), весь исходный объём сохранён.
- [x] Reproduce legacy cabinet/messages read/write after cancelled deal:3failed/119pass before fix, exact source REPORT-EXTERNAL-LEGACY-ACCESS.md. No fake historical binding.
- [x] Same-TX actual live access/expiry after waits, atomic refusal/no write/chat/accepted/notification side effects; targeted160pass/41new incl27actualwaits and committed publish/SQLrollback.
- [x] Fresh full1219front/1524back no skipped/types/lint/build/contracts (actual migration preflight), Chromium externallegacy2:11checks/eightPNG inspected. Docs/maps/errors updated; full failure history retained. Это не весь T007/WP03.
- [x] Scoped legacy gates status/approve ALL MET4, CRLF diff exit0/handoff updated. Затем full T009 versioned offline/access cleanup и согласованные delegated/event contracts.
Следующий шаг: полный T009 offline snapshot/access lifecycle, не только unmount;
затем интеграция company/event contracts с изолированной сессией. Все SC/NFR/WP00–WP16 остаются обязательными.

Текущий этап: external program UI (не завершение WP03).
- [x] Общий captured-version reader и реальные anonymous API wrappers; без старого timezone-дубля.
- [x] Отказы/отзыв/офлайн убирают программу и чат; reconnect и смена ссылки требуют нового чтения/checkbox.
- [x] Targeted56, fresh full init.sh1210frontend/1460backend no skipped и actual Chromium externalui2 UI14/sevenPNG — REPORT-EXTERNAL-PROGRAM-UI.md.
- [x] Документы/maps/report/handoff и scoped UI gates status/approve ALL MET4; CRLF diff check exit0. Затем current external receipt/history в сводке команды.

- [ ] Реализовать и принять весь объём: [программа и решения](wedding-platform-master-plan/delivery.md). WP03 версии/planning/events foundation/shift/DayX/effects, registered/external acknowledgment/team, legacy server live rights, DayX и contractor offline checkpoints проверены локально. Последний full1328frontend/1526backend no skipped/types/lint/build/contracts; actual Chromium offlineprogram3:15checks — [REPORT-OFFLINE-PROGRAM](фичи/021-тайминг/REPORT-OFFLINE-PROGRAM.md). Далее critical/cold offline/рассадка, delegated actors и event invitees/RSVP/transfers/management. T006/T007/T008/T009/WP03 и весь WP00–WP16 не завершены. Прикладной код не опубликован этой сессией; production не трогать.
## Исправления аудита 021 · 2026-09-30

- [x] Убрать раскрытие private/finance_members сумм через slot/pay и legacy-флаг в vendor aggregates; закрепить обе двери и старые строки регрессией.
- [x] Показать неполноту известных сумм в аналитике, списке и карточке сделки подрядчика; синхронизировать OpenAPI 0.52.1 и generated types.
- [x] Подключить vendor-visible историю оплат и скачивание подтверждений; проверить отказ, повтор и пустую историю.
- [x] Прогнать типы, тесты с PostgreSQL, линт, сборки и browser E2E; обновить карты и передачу сессии. После rebase локально: frontend 1097; backend 1275 + 15 Redis-skips. GitHub CI кода `9e05381`: frontend 1097, backend 1290 без пропусков; browser 018 14/14 и 021 5/5, page_errors=[]; Task Planning и Offers 019 — success.
- [x] Подготовить отдельный [PR #20](https://github.com/bairasbai/tili-tili/pull/20) в main с результатами проверок.

Исторический следующий шаг был review/merge PR20. Fetch2026-10-01 подтвердил
merge2b77687; обе функциональности объединяются с текущим WP03 checkpoint.

## Синхронизация и проверка приватности · 2026-09-30

Подэтап T007 legacy vendor updates revocation проверен локально: full1146/1394
без skipped, девять новых server tests и девять real browser checks. Источник:
[REPORT-VENDOR-ACCESS](фичи/021-тайминг/REPORT-VENDOR-ACCESS.md). Следующий шаг:
versioned разрешённый program reader/ack/UI и новое ожидание при редакции;
legacy «Учтено» не считается FR-038 ознакомлением. Прикладной код не опубликован.

Подэтап T007 versioned server: разрешённая projection по назначениям действующих
сделок; read proof version/content/user/session, durable history и новый pending
после редакции. Full1146/1414 на fresh ackfresh DB и migration8 прошли;
[REPORT-PROGRAM-ACK-HTTP](фичи/021-тайминг/REPORT-PROGRAM-ACK-HTTP.md).

Проверенный checkpoint: registered vendor program UI (не весь T007).
- [x] Список с cursor pagination и отдельный reader/checkbox/exact-version ack.
- [x] Captured proof/ETag, stale/refusal/expiry, network retry, RU/EN и offline unmount.
- [x] Actual browser programui2:14 checks, zero page_errors, desktop/mobile screenshots reviewed.
- [x] Full init.sh на fresh programuifinal DB:1168frontend/1414backend, no skipped,
  types/lint/build/contracts passed — [REPORT-PROGRAM-UI](фичи/021-тайминг/REPORT-PROGRAM-UI.md).
- [x] Итоговые журналы/handoff и scoped gates: server6/UI4 ALL MET10,
  не весь T007/WP03. CRLF-aware diff --check exit0. Локальный preview3000/3001
  на disposable programui2 DB, healthok/UI200; production/GitHub не трогались.
Следующий шаг после приёмки подэтапа: обратная видимость ознакомления паре/команде,
external/delegated actors, полный T009 offline lifecycle и прочие задачи WP03.
Код не опубликован; весь WP00–WP16, сценарии, release gates и feature delivery обязательны.

Проверенный checkpoint T007: сводка ознакомления пары/helper/coordinator.
- [x] Общая разрешённая projection/digest, current owner/version/content status и actual actor/time.
- [x] API права/live after-lock checks, external unsupported/unavailable/unassigned, история без ложного current ack:68subsetpassed,18new DB/API cases.
- [x] UI coherent с показанной timeline version, RU/EN/refusal/network/refresh:62subsetpassed,17summary+2vendor403 new cases.
- [x] Real DB/API tests68, actual browser teamack2 16checks vendor->team->edit->pending, full1187/1432 no skipped/types/lint/build/contracts; six region screenshots and viewport320 reviewed. REPORT-TEAM-ACK.md, full feature remains open.
- [x] Scoped team ledger status/approve ALL MET5; CRLF diff check exit0, handoff updated. Preview isolated teamack2 DB healthok/UI200, actual listener commands inspected. Только этот этап, не весь T007/WP03.
- [x] T007 external server stage: новая bound ссылка/assigned-only reader/read proof/exact-version ack/history/retry/live afterwait. Historical binding не выдумана. Legacy global timeline/who bypass закрыт и reproduced; actual issuance time/live owner checks.
- [x] Full1187frontend/1460backend no skipped/types/lint/build/contracts на fresh externalverifyPG+Redis13;28new DB/API cases, migration13 и actual Chromium/HTTP8checks/twoPNG reviewed. Failed Redis suite/isolated10pass recorded, historical cause not confirmed — [REPORT-EXTERNAL-PROGRAM-HTTP](фичи/021-тайминг/REPORT-EXTERNAL-PROGRAM-HTTP.md).
- [x] External server scoped ledger status/approve ALL MET5, CRLF diff check exit0, docs/handoff/preview checked. External UI/team/delegated/T007/WP03 не приняты целиком.
- [x] Current external team summary проверен локально (REPORT-EXTERNAL-TEAM-ACK.md). Delegated actors/full legacy/offline/events и все WP остаются обязательными. Этот этап не заменяет полный внешний сценарий.

- [x] Сверить локальную историю с GitHub: `git fetch origin --prune`, `git rev-list --left-right --count HEAD...origin/main` до обновления дали `0 189`.
- [x] Сохранить прежний HEAD в `backup/local-main-before-sync-20260930`; обновить `main` через `git merge --ff-only origin/main` до `cdd2f2f6bed9dec02472b566fc12f27ddcaf97f8`.
- [x] Воспроизвести утечку приватных оплат через `legacy_vendor_visible`: три regression-теста падали до исправления и проходят после него; ERR-0337.
- [x] Закрыть обход `visibility` в записи оплаты и vendor totals/analytics, включая уже сохранённые compatibility-флаги.
- [x] Пройти migration rehearsal 021 и 14 сценариев payment browser E2E без `page_errors`; `pnpm audit --prod --json` не сообщил уязвимостей в app/backend.
- [x] Финальный `bash init.sh` с отдельными PostgreSQL/Redis: frontend 1089/1089, backend 1286/1286, без пропусков; типы, линт и сборки прошли. Источник: `C:/Тили-тили/.unlazy/sync-audit-20260930/init-final.log`.
- [x] Подготовить проверенный результат для публикации в `main`; процедура окончательной сверки и источники — `session-handoff.md`.

Следующий шаг проекта: внешние release gates и открытые пункты roadmap по решению владельца. Ниже сохранена история предыдущих задач; её старые статусы не описывают текущую синхронизацию.

## Текущее состояние · 2026-09-28 — 019 слита

- [x] 017-A/B слиты в main (PR #1).
- [x] 018 «ответы квиза влияют на свадьбу» слита в main (PR #2).
- [x] 019 T001–T042 слита в main через PR #5; merge commit `027d6c3eb76e6a31c4ecd8b73c0376a910bd488d`.
- [x] 019 clean integration не содержит промежуточные 018-A/B payment-schedule/receipts/budget-controls и отдельный branding commit.
- [x] Дополнительный audit regression guard атомарного rollback при `vendor_unavailable` находится в main.
- [x] PR #5 gates: CI success (frontend 1020, backend 1164), Offers 019 browser E2E success, Task planning browser E2E success.
- [x] Контракт main после 019: v0.45.0, 138 путей / 183 операции / 78 схем; миграция `1761500000000_shortlist_offers.cjs`.
- [ ] Закрыть дублирующий PR #6 как superseded; не сливать его повторно.
- [ ] Следующий roadmap stage — 020.
- [ ] Production deployment и внешние release blockers — отдельный трек.

Нижележащие исторические секции 017/018/019 сохраняются как журнал решений; старые пункты про порядок их слияния больше не являются текущей задачей.

---

## Фича 018 · 2026-09-26 — ответы квиза влияют на свадьбу

- [x] **Фича 018** — `tasks/фичи/018-квиз-влияет/` (спека, план, задачи): коды `format`/`planner`/`prebooked`, мозаика и тайминг
      по формату, отметка «Уже забронировано» с «Добавить подрядчика» / «Нет, ещё ищем», шаг имён и `PATCH /users/me` до
      `POST /weddings`; контракт v0.42.0, миграция `1761300000000`; ERR-0309. PR в `main` из `feature/018-quiz-answers-matter`
      (не сливать самому). JOURNAL «Фича 018».
- [x] **Живой обход на ветке фичи** — локально на `c274086` (API GitHub отказал в запуске: у приложения Claude было только
      чтение Actions) — явных поломок нет, как эталон на `main`; после обновления прав приложения владельцем — Actions на
      `17e246c` (36264694374) — зелёный, «явных поломок нет».
- [x] **Мигающие тесты (ERR-0310)** — `stage7` и `audit32`: ответ Тиля ждётся `app.tilly.settle()`; `audit7b`: «сегодня» по поясу свадьбы, как в `notify()` (с 21:00 до 24:00 UTC краснел всегда). Гонка воспроизведена замедлением живого канала, дата — в 21:31 UTC; после правки зелёные (Тиль 20/20).
- [x] **Тиль знает отметку «уже забронировано» и блоки форматов** — решение владельца после первого ревью («почини
      Тиль»): `wedding/tips.ts` не считает отмеченный слот открытым (ни дефицита, ни блокирующего слота), карта
      `BLOCK_DEPENDENCIES` называет блоки всех форматов (ЗАГС и второй день — ни на чём, «Ужин» — площадка, «Выездная
      церемония» — ещё площадка церемонии и церемониймейстер), `tilly/context.ts` пишет «уже забронировано вне приложения».
      Тесты Т9/Т10 в `backend/test/quizAnswers.test.ts`. JOURNAL «Фича 018, после первого ревью».
- [x] **Ревью PR фичи 018** (независимый ревьюер, 2026-09-26): блокеров нет, находки D-01…D-12. В PR закрыты D-03
      («Пропустить вопрос» снимает выбранный вариант), D-06 (`t(s.label)`), D-09 (подсказки перечитываются после снятия
      отметки), D-11 (П3 — помощник и координатор), D-12 (комментарий миграции); тест побочного эффекта FR-018 на старой
      свадьбе; обоснование «Ужина» исправлено. ERR-0311, JOURNAL «Фича 018, ревью PR».
- [x] **Взаимная блокировка брони слота (ERR-0312)** — найдена прогоном с покрытием: две одновременные брони одного слота
      изредка получали 500 вместо 409 (жило с ERR-0035). Захват слота — замком строки до вставки сделки (`lockFreeSlot`),
      обе двери; тест `audit4` с заданным чередованием — красный до правки, зелёный после, мутанты ловятся по двери.
- [x] **Живой обход на `c7d9ae1`** (правки ревью в коде) — Actions 36278198394 — зелёный: сценарии 8/8, числа по 12 ролям
      строка в строку как на `17e246c`, 5xx нет; CI на `c7d9ae1` — зелёный.
- [ ] **Владельцу: решения по ревью 018** (спека 018, «Вопросы владельцу после ревью PR»): D-01 — «+15 мин всей программе»
      двигает и блоки второго дня двухдневной свадьбы; D-04 — «Свадьба прошла — оцените команду» приходит во второй день
      праздника; «Ужин» камерной свадьбы — только площадка?
- [ ] **Владельцу: порядок слияния PR №1 (017), №2 (018 квиз) и №3 (018-A/B, поверх №1)** — проверено по git 2026-09-26
      22:10 UTC. Контракт: `main` v0.41.0, №2 — v0.42.0, №1 — v0.43.0, №3 — v0.45.0. Миграции: №1 —
      `1761000000000…1761200000000`, №2 — `1761300000000_quiz_answers_matter`, №3 — `1761300000000_payment_schedule`
      (**тот же номер**; при равных номерах `node-pg-migrate` идёт по имени — `payment_schedule` раньше) и
      `1761400000000_budget_controls_receipts`; таблицы у миграций разные. Общие файлы №2 и №3: `slots.ts`, `tilly/context.ts`,
      `Wedding.tsx`, `i18n.en.ts`, `audit55`, сгенерированные файлы контракта. В №3 свой ERR-0310 (тот же фикс `audit7b`) и
      вторая папка фичи 018 (`tasks/фичи/018-платежи/`). **Кто сливается вторым:** поднимает версию контракта выше `main`,
      перегенерирует `api.generated.ts` / `schema.ts`, правит сторож версии в `audit55`, переносит номера своих миграций
      выше слитых, переименовывает повторяющийся номер ERR. **Базе, где миграция с большим номером накатана раньше
      меньшей** (при любом порядке слияния: `checkOrder` сверяет позиции), — один раз `npm run migrate up -- --check-order false`
      или откат новой миграции `npm run migrate down -- --check-order false` (без флага откажет и откат) и затем
      `npm run migrate up`; обе команды проверены на игрушечных миграциях. CI поднимает чистую базу, прод ещё не выкладывался.
- [ ] **D-02 (P2, до двухдневных свадеб в проде)** — перенос даты сопоставляет блок шаблона с событием только по `sort`
      (`wedding/reschedule.ts:173-181`), а `PUT /timeline` перенумеровывает `sort`. Двухдневная свадьба без даты, из
      тайминга удалили «Сборы жениха», потом выбрали дату — «День 2: бранч» встаёт на 22:30 первого дня. Сопоставлять по
      имени; тест «удалили блок до выбора даты».
- [ ] **D-05 (P3)** — `useIsCouple` не отличает ошибку `GET /weddings` от загрузки (R-179): при отказе кнопок отметки нет
      навсегда, ни ошибки, ни повтора (`app/src/lib/useIsCouple.ts:16-18`).
- [ ] **D-07 (P3)** — подписи новых плиток захардкожены (`wedding/templates.ts:99-113`), а слот, добавленный парой, берёт
      `categories.name`: после переименования категории в панели подписи разойдутся. Брать `name` из `categories` во вставке.
- [ ] **D-08 (P3)** — нет иконок у `ceremony`, `registrar`, `hotel`, `agency`, `coordinator` (`app/src/lib/icons.ts`), теперь
      такие слоты заводятся по умолчанию — показывается запасная `Sparkles`.
- [ ] **До фичи 018 (P3)** — заголовки `SlotView` без `t()` (`Wedding.tsx`, ветки забронированного и пустого слота) и подписи
      мозаики (`Wedding.tsx:123`); в словаре нет «Организатор», «Кондитер», «Флорист», «DJ».
- [ ] **Покрытие 018 (P3)** — прямого теста отката `POST /weddings` целиком (FR-015) нет; e2e не считает 14 плиток
      выездной свадьбы (SC-002).
- [ ] **Класс ERR-0309** (P3): ещё 17 полей `flex-1` без `min-w-0` — `Logistics.tsx:56–57, 362–367, 496`,
      `Wedding.tsx:1045–1046, 1376`, `Wishlist.tsx:240, 403, 462`, `VendorExtras.tsx:251, 346`, `Search.tsx:305`,
      `components/CityPicker.tsx:54`; живьём не мерены (`scrollWidth <= innerWidth` на 390 px).
- **Следующий шаг:** владелец решает порядок слияния PR №1/№2/№3 и даёт «сливай» для №2 (merge commit, чтобы ссылки на
  коммиты в записях остались живыми); после слияния — `npm run migrate up` на дев-базе (при отказе порядка — процедура выше).

## В работе · 2026-09-24 — план после допроса владельца

Порядок решён владельцем в трёх раундах вопросов (JOURNAL «План после допроса»).

- [x] FL-17 — кабинет подрядчика без анкеты (ERR-0296, `5d1f093`).
- [x] F-RL3-04 и половина кода F-RL7-08 — дневной лимит push и потолок лайков под замком (ERR-0296, `5d1f093`).
- [x] R-257 целиком — `key()` в константах, `t()` в месте показа, EN-сеть `audit50b/d/e` (ERR-0297).
- [x] Redis для 10 пропущенных тестов — Memurai ставит **владелец за машиной** (UAC): `winget install Memurai.MemuraiDeveloper`, затем прогон с `TEST_REDIS_URL=redis://localhost:6379`. — **ЗАКРЫТО 2026-09-26: Memurai 4.1.2 стоит службой, полный прогон с базой и Redis — ноль пропущенных (ERR-0303).**
- [ ] Выкладка на тестовый домен — вместе со специалистом по серверам (`DEPLOY.md`).
- [x] После выкладки: одна дверь `cancelDeal()` (F-RL-2-02/SA-06), миграция `CHECK (currency = 'RUB')` (F-RL-2-03), общий бамп контракта v0.41.0 (~12 правок, среди них код ответа F-RL7-08). — **ЗАКРЫТО 2026-09-26 ещё до выкладки: ERR-0298, ERR-0299, ERR-0302 (контракт v0.41.0).**
- [x] **Гейт согласия при мёртвой сессии** (`app/src/lib/store.tsx:414`, вне границы F4, не регрессия): «Выйти» с гейта ведёт на `/` вместо `/auth`; 401 на «Принять» снимает гейт раньше, чем экран успевает показать «Сессия истекла — войдите снова» (F4-F-G6r5-01/02). — **ЗАКРЫТО 2026-09-26, ERR-0306 (`49c7c7e`):** сброс стора и переход на `/auth` — одним transition-кадром, экран входа называет причину; заодно закрыты отзыв согласия и проба профиля. `audit54.test.tsx` +5 случаев (красные на `75375aa`).
- [x] **Уборка локальной тестовой базы после F6** (только база на этой машине, в репозиторий не попадает; писать в общую базу агентам не дают — делать с разрешения владельца): хвосты фикстур прошлых прогонов (пользователь `01a0db64…`, его согласия, сессии, `otp_codes`), `published_at` у 949 анкет усечена до миллисекунд шумовым скриптом FP-2, записи FP-2 неполные. — **СДЕЛАНО 2026-09-26 с разрешения владельца:** тестовый пользователь `+79358832555` удалён одной транзакцией, каскадом — его сессия, согласие и настройки уведомлений; 3 строки `audit_log` оставлены (журнал только на запись); `published_at` у 949 анкет — как есть.
- [x] **Мелочи общего ревью экономного режима** (P3, ни одна не блокирует): контракт — два списка 409 без части кодов, текст `policy_version_stale` («старше действующей»), строка `forbidden` в таблице общих кодов пересекается с `consent_outdated`, общий ответ `Forbidden` без `consent_outdated` (F5-R7-02…05); `audit55` сторожит не все правки F5, `payload: unknown` в `audit55:754-755` даёт 9 ошибок строгого tsc (F5-R7-08, info-1); `audit54:456-462` — пустой отрицательный контроль (F4B-R7-01); комментарий `audit4:372-377` цитирует не те строки (F6-R7-01); F6-G6r6-02 подтверждена. Остальное — неточности в записях агентов, в коде их нет. — **ЗАКРЫТО 2026-09-26 (`49c7c7e`):** тексты контракта F5-R7-02…05 (`team_busy`, `bad_transition`, «не совпадает», `forbidden`/`consent_outdated`), сторожа `audit55` G-h/G-i и типы `payload` (строгий tsc 0), контроль `JOIN_GAP` в `audit54` краснеет без предела, `audit4` — ссылки по смыслу.
- [ ] **`audit49q.test.ts` — кандидат в мигающие** (2026-09-26, 1 из 11 полных прогонов бэка): файл не стартовал («0 test»), ошибка в `avvio/lib/plugin.js` — вероятно, таймаут запуска плагина Fastify (10 с) при нагруженном импорте (252 с против обычных 205–219). Файл не менялся с ревью 016. Сначала поймать текст ошибки; варианты — `pluginTimeout` в тестовой сборке или последовательная группа. **Перепроверка в чистых Linux-контейнерах: 6 из 6 прогонов бэка — файл стартовал, ошибок avvio нет** — похоже на нагрузку ноутбука; держать под наблюдением. **2026-09-26, облачный контейнер: 10 из 10 под загрузкой процессора (8 процессов на 4 ядра) — не воспроизводится** (ERR-0310, «Не закрыто»).
- [ ] **Находки чистой перепроверки** (P3, выкладку не держат): `Idempotency-Key` в контракте `maxLength: 128`, сервер принимает до 200 (`deals/idempotency.ts:49`); в описаниях операций не названы `bus_full` (`routes/day.ts:1026`), `table_full` (`routes/guests.ts:406`) и 409 `vendor_blocked` (`routes/vendor.ts:345`); битый URL (`/legal/%`) отвечает 400 в формате Fastify `FST_ERR_BAD_URL`, а не `{error:{code,message}}` (`src/app.ts:59-71`). (`bad_transition` у отмены брони слота, `openapi.yaml:985`, — закрыт в `49c7c7e`.)
- [x] **Живой обход — в GitHub Actions** (2026-09-26, ERR-0307/0308, JOURNAL «Живой обход — в GitHub Actions»): скрипты 19.09 — `Тили-тили/e2e/walkthrough/`, проверка «Живой обход» кнопкой или при правке обхода; второй прогон нашёл секундное окно лимита — окно теперь 10 с.
- [x] **Находки обхода ролей** (после прогона с окном 10 с): no-effect, covered, ответы ≥400 по ролям — разобрать, как 19.09 (сводка — лог шага «Обход» и артефакт `walkthrough-out`). — **разобрано 2026-09-26:** четвёртый прогон `36248295917` зелёный — 8/8 сценариев, 12/12 заданий, 983 нажатия ok, 0 ошибок; все ≥400 — отказы по роли словами, 404 «Анкета ещё не создана», 423 чата дня X.
- [x] **`/me/favorites` пачкой** — во втором прогоне 89 из 164 ответов 429: какой экран шлёт избранное помногу (на каждую карточку?) — проверить после окна 10 с. — **снято 2026-09-26:** в третьем прогоне (окно 10 с) ответов 429 нет вовсе — пачки упирались в секундное окно.
- [ ] **Главная помощника и координатора запрашивает закрытое роли** (P3, третий прогон обхода): `GET /weddings/:id/budget` и `/tips` — по 81 ответу 403 за обход на каждую роль; экран объясняет словами, но запрос заведомо лишний — не звать для ролей без доступа.
- **Следующий шаг:** `ALTER ROLE tili CREATEDB` (администратор базы) и настоящая репетиция восстановления (FL-15, шаги 2–3); затем выкладка на тестовый домен по `DEPLOY.md` со специалистом по серверам. «Живой обход» — перед каждым слиянием фичи Codex (Actions → Run workflow).

**Следующий шаг:** Memurai от владельца → прогон с Redis; параллельно — договориться о выкладке.

---

## Сделано · 2026-09-19…21 — ревью 016 (поручение владельца «ревью всего кода»), записи (PASS 1 + PASS 2)

ERR-0271…ERR-0284 (сплошной блок, FL-18 — сиблинги внутри ERR-0271); JOURNAL «Ревью 016»; инструмент покрытия `CT-0`
(вне репозитория). 15 из 18 лейнов принято, 3 (FL-15/16/17) — DROPPED (TIME CUT), эскизы ниже. FL-10 и FL-12
дождались независимых G5/G6 в PASS 2 (RESUME #5, ночь на 21 сентября) и закрыты тем же блоком записей, без
переписывания того, что дописал PASS 1.
Полный `bash init.sh` этот проход не запускал: по правилу ARB-1 §C4 он выполняется один раз, в конце, лейном FG-1.

- [x] FL-01 (ERR-0271/R-271): гонка `POST /auth/otp` устранена — `pg_advisory_xact_lock` на номер внутри `db().tx()`. `audit49a` 2/2, coverage 100 %.
- [x] FL-02 (ERR-0272/R-272): маршрут `/guest-vendor/:token` — новый экран `GuestVendor.tsx` + `lib/api/guestVendor.ts`. `audit49b` 5/5.
- [x] FL-3 (ERR-0273/R-273, S1): хранимая XSS в PDF/DOCX договора закрыта — `escapeHtml` в `contractHTML`. `audit49c` 12/12, coverage 100 %/100 %.
- [x] FL-4 (ERR-0274/R-274): чипы городов EN-квиза сохраняют русский ключ, не перевод. `audit49d` 3/3, coverage 100 %.
- [x] FL-5 (ERR-0275/R-275): поле заявки подрядчика — `pb-28` вместо `pb-10` на `VendorExtras.tsx:177`. `audit49e` 2/2.
- [x] FL-18 (сиблинги ERR-0271, без своего номера): три родственные гонки — альбом (`day.ts`), холодные переписки (`chats/post.ts`), версия договора (`documents.ts`). `audit49p`/`q`/`r`, coverage 100 % ×3.
- [x] FL-6 (ERR-0276/R-276, 2 раунда правок): подделанный курсор каталога/отзывов не роняет запрос в 500. `audit49f` 7/7, coverage 100 %/100 %.
- [x] FL-7 (ERR-0277/R-277): смерть сессии и выход в соседней вкладке чистят как кнопка «Выйти». `audit49g` 4/4, coverage 100 %.
- [x] FL-8 (ERR-0278/R-278, 2 раунда правок): отсутствие свадьбы не читается как факт о человеке. `audit49h` 9/9, coverage 100 % ×3.
- [x] FL-9 (ERR-0279/R-279, ЧАСТИЧНО): согласие использует `clientIp()`. `audit49i` 2/2. Гонка SA-05 расследована, **НЕ закрыта** — см. «Владельцу» ниже.
- [x] FL-11 (ERR-0281/R-281): цена пакета анкеты не подменяется нулём — после PLAN-CONFLICT с контрактом и G1-плана. `audit49l` 6/6, coverage 100 % ×3.
- [x] FL-13 (ERR-0283/R-283): заголовки безопасности nginx повторены в каждом static `location`. Проверка скриптом (тестов vitest нет по решению TR-1).
- [x] FL-14 (ERR-0284/R-284): каталог различает ошибку / 403-со-словами / пусто. `audit49n` 6/6, coverage 100 % ×2.
- [x] FL-10 (ERR-0280/R-280): Тилли получал выдуманное «05:00» вместо «время не задано» для свадьбы без даты — `tilly/context.ts`. `audit49k` 2/2, coverage 100 % (4/4). Red-then-green на HEAD подтверждён напрямую; регрессия `audit44`+`tilly-client`+`audit39` — 31/31.
- [x] FL-12 (ERR-0282/R-282): повторное одобрение живой анкеты слало подрядчику вторую новость «Анкета проверена» — `routes/admin.ts`, `moderated_at` теперь читается под `for update` в той же транзакции. `audit49m` 2/2, coverage 100 % (4/4). Red-then-green без записи в репозиторий (in-memory подмена модуля на верифицированный блоб HEAD); регрессия по всем 16 файлам `/admin/…` (197 тестов) — зелёная.
- [x] FL-15 (ERR-0285/R-285, **DROPPED — TIME CUT**): репетиция восстановления БД (`backend/scripts/restore-drill.sh`) может снести боевую базу и не умеет восстановить выбранную копию. Эскиз: `exit 2`, если `DRILL_DB` пуст или равен имени из `DATABASE_URL`; восстанавливать файл из `DUMP=<file>`, а не свежий дамп текущей базы; шаг проверки в `RUNBOOK.md` §4 — живой тест/`/health/ready`, не DB-free `contract.test.ts`. Заодно `RUNBOOK.md:123-124` (F-RL6-10): `OTP_HMAC` не существует, коды входа используют `JWT_REFRESH_SECRET ?? JWT_ACCESS_SECRET`. — **ЗАКРЫТО 2026-09-26, ERR-0304:** сторож имени базы, `DUMP=<файл>`, RUNBOOK §4/§5; тест `restoreDrill` 10/10 (на старом скрипте 9 красные). Настоящий прогон шагов 2–3 — после `ALTER ROLE tili CREATEDB` (RELEASE-BLOCKERS №31).
- [x] FL-16 (ERR-0286/R-286, **DROPPED — TIME CUT**): `ci.yml` линтит `eslint .` целиком (8 ошибок в вендорном `components/ui`), гейт — свой список файлов без трёх компонентов фич 014/015. Эскиз: один и тот же список (`src/lib src/pages src/App.tsx src/main.tsx src/components/*.tsx`, без `ui/`) в трёх местах — `init.sh:23-24`, `.github/workflows/ci.yml:24`, `.claude/agents/tili-implementer.md:46`. — **2026-09-26:** линт исправлен ещё 24.09 (`d16af88`, граница в `eslint.config.js`), но CI всё равно красный: оба задания падают на `pnpm install --frozen-lockfile` (и на `c24d211`, и на `fc4f109`). Лог без входа в GitHub не отдаётся — нужен текст ошибки. Подозрение: в `package.json` нет `packageManager`, и `corepack` берёт другую версию pnpm, чем локальная 10.34.5. — **ЗАКРЫТО 2026-09-26, ERR-0305:** причина — незакреплённая версия pnpm в CI (corepack брал 12.6.0 → `ERR_PNPM_IGNORED_BUILDS`), воспроизведено в чистом контейнере; в `ci.yml` закреплён pnpm 10.34.5 и `minimum-release-age=0`, как в образах. CI зелёный: запуск `36232614543` на `cab2db7`.
- [x] ~~FL-17: кабинет подрядчика без анкеты отвечает текстом про роль пары~~ — **ЗАКРЫТО 2026-09-24, ERR-0296/R-296.** `CabinetDenied` в `components/AsyncState.tsx`, `AsyncState` получил `denied?: ReactNode`; подключён в пяти местах (`VendorApp.tsx` Сделки, `VendorExtras.tsx` ×4). `VendorVerification` намеренно не тронута — она ловит 404 сама через `catch(noProfile)`, шестого случая нет. Тест `audit49o.test.tsx` 6/6, отрицательный контроль красный на всех шести.

Гейты по каждому лейну — детально в `session-handoff.md`.

### Владельцу · ревью 016

**Открытые дефекты (не закрыты этим проходом):**
- ~~SA-05 · гонка `DELETE /users/me` × бронирование слота~~ — **ЗАКРЫТО 2026-09-24, ERR-0289/R-289.** Закрыты обе стороны и оба порядка: `users.ts` берёт свою строку `users` под `for update` следом за замком свадеб; `slots.ts` проверяет живость заявителя внутри транзакции (`for share`) в дверях `…/book` и `…/external`, анкета подрядчика читается `for share of u`. Тест `audit49j.test.ts` восстановлен по этому эскизу, 3/3 зелёный; обе проверки подтверждены отрицательным контролем (без фикса краснеют на первом заходе). Гейт: `init.sh` exit 0, бэк 91 · 906 · 10 пропущено.
- ~~F-RL-1-01 · `clientIp()` и зона интерфейса~~ — **ЗАКРЫТО 2026-09-24, ERR-0291/R-291.** Зона отрезается до проверки: `fe80::1%eth0` → `fe80::1`, мусор без адреса — `null`. Тест `audit50` T1.

**Дорогой фикс, отложен с эскизом (полный список — `findings\TR-1.md` §5.1 автопромпт-папки; здесь — самодостаточные копии):**
- ~~F-RL7-04 · `rotateNewcomers` и последняя строка выдачи~~ — **ЗАКРЫТО 2026-09-24, ERR-0291/R-291.** Ротация держит хотя бы одну строку — иначе курсор без якоря, и вытесненная анкета пропадала из каталога. Тест `audit50` T2.
- ~~F-RL-2-02/SA-06 · `backend/src/deals/repo.ts`, `weddingLifecycle.ts`, `slots.ts`, `deals.ts` — нужна одна функция `cancelDeal()` вместо трёх независимых дверей отмены (застрявшие лиды в состоянии `won` невидимы). 4-файловый рефакторинг маскированного дефекта, вне бюджета этого ревью.~~ — **ЗАКРЫТО 2026-09-26, ERR-0298.**
- ~~F-RL3-03 · `rsvpDigest` без ключа задачи~~ — **ЗАКРЫТО 2026-09-24, ERR-0291/R-291.** `claimJobKey('rsvp:{weddingId}:{день}')`. Тест `audit50` T3 — два прохода дают одну сводку.
- ~~F-RL3-04 · дневной лимит push считался count-then-insert~~ — **ЗАКРЫТО 2026-09-24, ERR-0296.** Поиск места и вставка в одной транзакции за `NOTIFY_LIMIT_LOCK` по человеку; при `unlimited` замок не берётся. `hasTx()` различает пул и клиента чужой транзакции — ни один из 19 вызывающих не менялся. Тест `audit50` T6; без замка — 11 push вместо 3.
- ~~F-RL3-05 · предупреждение о выплате мимо эскроу~~ — **ЗАКРЫТО 2026-09-24, ERR-0292/R-292.** Счёт и вставка в транзакции за `PAYOUT_WARNING_LOCK`. Тест `audit50` T4 (залп 12; на шести гонка не воспроизводится).
- ~~F-RL3-06 · дебаунс трансляции дня X~~ — **ЗАКРЫТО 2026-09-24, ERR-0292/R-292.** Счёт и вставка за `BROADCAST_LOCK` по паре «свадьба + действие». Тест `audit50` T5 (залп 6).
- ~~F-RL7-08 · лимит лайков — **половина кода ЗАКРЫТА 2026-09-24, ERR-0296**: счёт и вставка в одной транзакции за `LIKES_LOCK` (`inspiration.ts`); тест `audit50` T7, без замка — 509 историй вместо 500 на залпе 48. **Осталась половина контракта:** код ответа не назван в `YAML:3433` — уходит в общий бамп v0.41.0.~~ — **ЗАКРЫТО 2026-09-26, ERR-0302 (контрактная половина: квота лайков без Retry-After).**
- ~~F-RL-1-04 · `safeEqual` не использовался~~ — **ЗАКРЫТО 2026-09-24, ERR-0291/R-291.** Дайджест кода входа сравнивается за постоянное время.
- ~~F-RL-1-05 · необработанный reject `app.close()`~~ — **ЗАКРЫТО 2026-09-24, ERR-0291/R-291.** Ошибка останова пишется в лог, выход с кодом 1.
- ~~F-RL-2-03 · `CHECK (currency = 'RUB')` есть на 4 из 13 денежных таблиц — нужна миграция, не в этой итерации.~~ — **ЗАКРЫТО 2026-09-26, ERR-0299.**
- ~~F-RL-2-04 · два предиката живой внешней ссылки~~ — **ЗАКРЫТО 2026-09-24, ERR-0291/R-291.** Оказались не равны: чтение не проверяло `archived_at` и пускало гостя-подрядчика в заархивированную свадьбу. Сведены в `LIVE_INVITE`.
- ~~F-RL5-06/07, F-RL-4-04, F-RL-8-07 · module-level `t()`~~ — **ЗАКРЫТО 2026-09-24, ERR-0297/R-297** (сторож — ERR-0295/R-295). Все 9 файлов: в константе ключ под `key()`, перевод — `t()` в месте показа. Два захода: `eb0bc6b` — `chrome.tsx`, `Team.tsx`, `Onboarding.tsx` (EN-сеть `audit50b`, `audit50d`); второй — `contractTemplates.ts`, `dressPalettes.ts`, `inviteThemes.ts`, `Discover.tsx` STORIES, `Smart.tsx` planBRisks, `Wedding.tsx` CONTRACT_TITLE (24 места показа, EN-сеть `audit50e` 5/5, отрицательный контроль — 24 красных из 24). Храповик `moduleT.test.ts` пуст и держится пустым.
- ~~F-RL5-08 · молчаливые денежные умолчания~~ — **ПРОВЕРЕНО 2026-09-24, дефекта нет (ERR-0294).** В `Wedding.tsx` `?? 0` — документированный признак «итог не задан», каждый потребитель закрыт `hasTotal`/`ready(q)`. В `Wishlist.tsx` подстановка недостижима: список пуст, пока данных нет, а сервер эти поля шлёт всегда (колонки NOT NULL). Остаточный риск: если контракт сделает эти `Money` nullable, вишлист начнёт молча показывать «0 ₽».
- ~~F-RL-8-05 · двойная активная вкладка на `/us/chats`~~ — **ЗАКРЫТО 2026-09-24, ERR-0294/R-294.** `activeTab()` в `lib/utils.ts` — одно правило на обе навигации, побеждает самое точное совпадение. Тесты `audit50a` (чистая функция) и `audit50b` (отрисованная навигация).
- ~~F-RL-8-06 · UTC-месяц на дашборде подрядчика~~ — **ЗАКРЫТО 2026-09-24, ERR-0293/R-293.** `currentMonth()` в `lib/utils.ts`, тест `audit50a` 4/4.
- ~~F-RL-8-09 · пустая подпись календаря без даты~~ — **ЗАКРЫТО 2026-09-24, ERR-0294/R-294.** Без даты свадьбы карточка подрядчика показывает текущий месяц и правда запрашивает занятость за него; подпись «показаны занятые дни» говорится только после ответа сервера.
- ~~F-RL-8-10 · `/notifications` без двойника в кабинете~~ — **ЗАКРЫТО 2026-09-24, ERR-0294/R-294.** Добавлен маршрут `/vendor-app/notifications`, кнопка кабинета переведена на него. Тест `audit50c`.
- ~~F-RL-8-15 · `components.json`~~ — **ЗАКРЫТО 2026-09-24, ERR-0293/R-293.** `tailwind.config` указывал на `postcss.config.js`; исправлено на `tailwind.config.js`.

**Владельческие заметки без кода:**
- ~~RL-1 · `assertConsent` игнорирует `policy_version` — повторное согласие после поднятия `POLICY_VERSION` не запрашивается; решение владельца/юриста.~~ — **ЗАКРЫТО 2026-09-26, ERR-0301.**
- ~~F-RL-1-03 · `backend/src/plugins/ratelimit.ts:88-89` — гостевой IP-потолок и анонимный IP-счётчик делят один ключ Redis; однострочный префикс-фикс, тест под Redis.~~ — **ЗАКРЫТО 2026-09-26, ERR-0300.**
- ~~SA-05 vendor-side · сторона подрядчика~~ — **ЗАКРЫТО 2026-09-24 вместе с ERR-0289**: `for share of u` на строке пользователя-подрядчика в запросе анкеты. `deals.ts` остаётся непроверенным: там сделки не заводятся, только меняют состояние — отдельный проход, если найдётся сценарий, где это важно.
- F-RL3-07 · `backend/src/vendorCabinet.ts:217-219` — состояние лида пишется до принятия текста ответа; оставить как задокументировано или сдвинуть после отправки сообщения.
- F-RL-8-08/13/14 · формулировка «добавим за день»; чипы «Кто вы» без запроса; заглушки галереи (до появления путей загрузки).
- `Us.tsx:186` — заводит любую пару в кабинет подрядчика; `clickstorm.test.tsx` `ROUTES` пропускает 8 маршрутов.
- Вишлист: `PATCH` без действия на экране; нет `.gitattributes` (CRLF/LF смешиваются при чекауте); `dev-token.sh` — куда класть файл токена по умолчанию; `backup.sh` — пароль в аргументах командной строки виден в `ps` (однопользовательский VPS, заметка не блокирует).
- ~~F-RL6-06 · сторож свежести контракта на фронте~~ — **ЗАКРЫТО 2026-09-24, ERR-0293/R-293.** `contractSync.test.ts` сравнивает `schema.ts` с `api.generated.ts` побайтово.
- Карта кнопок · колонка «Сервер» (`file:line` обработчика) не сверялась на дрейф от бэкендовых правок FL-9/FL-18/FL-6/FL-01 этого ревью (у каждой реальный диф 26–186 изменённых строк) — участник ревью, ведущий карты, сознательно ограничил себя фронтовым R-BTN-якорем каждой строки (его и сверил, 117/117) и не трогал вторичное поле «Сервер»; для будущего прохода.
- Вне любого списка записей ревью-016 (решение ARB-1 §C3 — сознательно не тронуто этим проходом, отдельный docs-микролейн не заводился: у прозы без исполняемых строк нет измеримого «покрытие изменённых строк ≥95 %»): `backend/.env.example:5` порт `3000` вместо `3001` (проверить против `vite.config.ts` прокси) + комментарий про SMS не на месте (:66-67 над :84); `backend/README.md:14,24` — тот же порт, «3 из 4» команд регенерации без имён скриптов; дублирующиеся блоки `.gitignore` (корень :15-18=:20-23, `backend/.gitignore` :8-9=:11-12); `app/README.md`, `app/info.md` — шаблонные заготовки create-vite.

**Контрактный текст — один будущий бамп YAML (ни один S1/S2 этого ревью правки контракта не потребовал):** — **ЗАКРЫТО 2026-09-26: контракт v0.41.0, ERR-0302.**
- ~~`openapi.yaml:2325` — пример URL → `/guest-vendor/{token}` (см. также `Тили-тили_Бизнес-логика_и_бэкенд.md:251` ниже).~~ — **ЗАКРЫТО 2026-09-26, ERR-0302, контракт v0.41.0.**
- ~~`:2588, :2781` — `Idempotency-Key: required` объявлен на двух гостевых операциях, которые его не проверяют.~~ — **ЗАКРЫТО 2026-09-26, ERR-0302, контракт v0.41.0.**
- ~~Необъявленные `400 bad_limit/bad_cursor` (8 списков ответов), `400/409 idempotency_key_*` (12/4 операции), `423` на статусе «печатает», 33 операции с безымянными кодами ошибок, `refresh_superseded` на `/auth/refresh`.~~ — **ЗАКРЫТО 2026-09-26, ERR-0302, контракт v0.41.0.**
- ~~`:3433` — именовать код лимита лайков `QuotaExceeded`.~~ — **ЗАКРЫТО 2026-09-26, ERR-0302, контракт v0.41.0.**
- ~~Очереди администратора отвечают 400, контракт объявляет 422.~~ — **ЗАКРЫТО 2026-09-26, ERR-0302, контракт v0.41.0.**
- ~~Консьерж/подрядчик/свадьбы — сервер отвечает 404 на промахе словаря тела запроса, контракт этого не называет.~~ — **ЗАКРЫТО 2026-09-26, ERR-0302, контракт v0.41.0.**
- ~~Вместимость стола автобуса: 100 в контракте против 50 в коде.~~ — **ЗАКРЫТО 2026-09-26, ERR-0302, контракт v0.41.0.**
- ~~`additionalProperties` не выставлен для `fields`/`keys` — контракт не ограничивает лишние ключи параметров.~~ — **ЗАКРЫТО 2026-09-26, ERR-0302, контракт v0.41.0.**
- ~~`:3192-3194` — текст про 72-часовой hold `negotiating`, которого ни один путь API не производит.~~ — **ЗАКРЫТО 2026-09-26, ERR-0302, контракт v0.41.0.**
- ~~Гостевой токен: 410 на одних путях, 401 на других — свести к одной формулировке.~~ — **ЗАКРЫТО 2026-09-26, ERR-0302, контракт v0.41.0.**

**Ops-документы вне границы FL-13/FL-15 (RL-6, `RELEASE-BLOCKERS.md:14-15` уже поправлено этим проходом, см. diff):**
- ~~`RUNBOOK.md:123` — строка про `JWT_REFRESH_SECRET` не договаривает «и все живые коды входа перестают подходить» (см. FL-15 эскиз выше про `:124`).~~ — **ЗАКРЫТО 2026-09-26, ERR-0304.**
- `backend/README.md:14,24`, `backend/.env.example:5,66-67` — см. запись в «Владельческие заметки» выше, не дублировать правку.
- `backend/test/schemas.test.ts:10` — заголовок теста «все 39 схем», в контракте 65; поправить, если лейн коснётся файла, иначе оставить как есть.

**`CLAUDE.md` — только строка шапки дополнена этим проходом (PASS 2), остальное вне границы (см. ниже):**
- Шапка (running summary наверху файла) дополнена этим проходом (PASS 2): все 15 принятых лейнов закрыты, FG-1 не владеет `CLAUDE.md` (пишет только `GATELOG.md`/`evidence\final-gate.md` и плейсхолдеры `<FG-1>` в `session-handoff.md`, ROADMAP.md §FG-1), а сам FG-1 по таблице ROADMAP зависит от «RC-1 done» — не наоборот; предложение о шапке (`**ревью 016 всего кода — 2026-09-19…21** (…)`) добавлено сразу после предложения «живой обход ролей и кнопок» без изменения его текста/жирного начертания. Первая (контрактная) строка шапки — `130 путей контракта, 175 операций (v0.40.0, …)` — не тронута: этот проход не менял контракт, тот же прецедент, что и для «живого обхода ролей» (тоже не попал в ту строку).
- §5.7 (денежная формулировка «целые рубли на фронте» vs `lib/money.ts` — минорные единицы + код валюты), §5.12 («факт онбординга» — RL-6 F-RL6-11; «черновик до входа»/«черновик текста приглашения» — актуально теперь, когда FL-7 убрала мёртвое состояние черновика, ERR-0277), §4 (`CLAUDE.md:119-120` таблица «9 (ждут Redis)» → 10, тот же пересчёт, что и `tasks/todo.md:421` этой сессии) — найдено RL-6, в границу ЭТОГО прохода («только шапка») не входит; не тронуто.
- `Тили-тили_Бизнес-логика_и_бэкенд.md:251` — ссылка гостя-подрядчика по-прежнему названа `/join/ТИЛИ-СВОЙ-…`, реальный путь — `/guest-vendor/{token}` (см. запись FL-02 выше). Документ вне пяти файлов границы этого прохода (не карта, но и не один из пяти прозовых файлов записей) — не тронут.

**Инфраструктура и гигиена:**
- `git worktree remove` во время фикс-раунда FL-8 прошёл сквозь junction `node_modules` и стёр `@babel/core` по всему репозиторию; тот же воркер восстановил зависимости `pnpm install --node-linker=hoisted` в `app/node_modules`. Правило действовало до конца ревью-016: без `git worktree create/remove`, только `git show HEAD:<path>` для чтения без изменения рабочего дерева.
- Повторяющийся мусор хука: 0-байтовые файлы в корне репозитория (видены под именами вида `20.10`, `20.11`, `20.14`, `20.15`, `20.23`, `#'` и похожими) и 196-байтовые файлы-эхо `ruflo` (например `1405`, `1623`) — следствие команд формы `awk 'NR>=…'` в тексте команды; каждый застигший лейн удалял только СВОИ находки этого класса, не чужие. Пустая директория `-p` в корне репозитория — предсуществующая, не мусор этого ревью, не трогать. Файл `Тили-тили/20.23` (0 байт, замечен на момент этой записи) не создан этим лейном записей — не тронут (граница этого лейна — только пять файлов записей).
- ~~Флейки «409 wedding_exists» (`prod15`, `prod6`, `audit42`, `audit18`, `audit35`) и тайминговый флейк `audit49h` T1~~ — **ЗАКРЫТО 2026-09-24, ERR-0288/R-259 (область действия).** Причина оказалась шире четырёх замеченных файлов: перебор свободного префикса стоял только в `audit44`/`audit46`/`audit47`/`audit48`, а 66 остальных файлов с живой базой брали `const RUN` наугад — при 5963 занятых префиксах из 900 000 полный гейт краснел примерно раз в 38 прогонов. Все 66 переведены на `let RUN` + цикл до 20 попыток; пять правились по отдельности (`prod8` — CRLF, `prod3` — таймаут `beforeAll`, `stage3` — пользователь внутри `beforeAll`, `realtime` — `app.listen`, `audit14` — три `describe`). `audit49h` — три проверки `NO_WEDDING` обёрнуты в `waitFor`. Гейт после правки зелёный: `init.sh` exit 0, фронт 63 · 858, бэк 90 · 903 · 10 пропущено. **FP-3 финала хвоста ревью 016 — ERR-0303.**
- Хвост оттуда же: **у репозитория по-прежнему нет `.gitattributes`**, и `prod8.test.ts` лежит с CRLF-окончаниями, когда все соседи — LF. Правка ERR-0288 окончания сохранила, но следующий чекаут на другой машине снова перемешает их. Заводить `.gitattributes` с `* text=auto eol=lf` — отдельная задача: она перепишет окончания во всём дереве и её нельзя смешивать с содержательным дифом.
- ~~`audit46.test.ts` П5 («счётчик анкет по городу растёт на одну») — межфайловая помеха, замечена 2026-09-24: счётчик абсолютный, по паре «город + категория», и любой параллельный файл, публикующий флориста в Уфе между двумя чтениями, ломает точное `before + 1`. Не регрессия — одиночный прогон зелёный 8/8 дважды, полный гейт после этого зелёный. Класса ERR-0288, но R-259 тут не лечит: уникален префикс телефона, а не город. Лечится сверкой по самой анкете (появилась в выдаче своего города и не появилась в чужом) вместо абсолютного счётчика.~~ — **ЗАКРЫТО 2026-09-26, ERR-0303.**
- ~~`audit41.test.ts` («заполненность анкет на дашборде») — тот же класс, замечен 2026-09-24: метрика считает опубликованные анкеты по ВСЕЙ базе, соседний файл между двумя чтениями ломает точное ожидание (+3 / +1). Одиночный прогон зелёный дважды, полный гейт после этого зелёный. Лечится так же: сверка по своим анкетам вместо абсолютной дельты.~~ — **ЗАКРЫТО 2026-09-26, ERR-0303.**
- Минорные незакрытые заметки независимых ревью: FL-11 — текст словесного отказа («Укажите название и цену…») в мастере анкеты не сбрасывается после «Отмена»/«Назад» (тот же паттерн, что уже принят для `Logistics.tsx:139`, решение TR-1 — не лейновая правка). FL-14 — блоки `SearchCategories` и `VendorList` дают ДВА независимых «Войти» при 403 на одном экране `/search`; мёртвая ветка `?? cats.forbiddenText` около строки 268 (недостижима); блок «Похожих специалистов» (`Search.tsx:755`, `similar.forbidden`) сознательно НЕ подключён этой лейной — 403 там тихо не рисует ничего вместо ложного «Похожих нет», мягче исходной находки, но вне названной границы FL-14; тест T1b первой версии ловил гонку в `store.tsx` (смерть сессии стирает `weddingDate`, эффект `similar` перезапускается по этой зависимости до того, как тест успевает проверить кнопку) — сама гонка живёт в `store.tsx`, вне границы FL-14, тест заменён на детерминированный 500-й сценарий с тем же покрытием кода. FL-10 — G5 минорные m1–m6 (расхождение
числа циклов замка «6» вместо 8 в FL-10.md §7; окно DB-лога начинается 15:57:52, а не заявленные 16:00:38;
формулировка R-280 в records.md шире дословного текста TR-1 — RC-1 выбрал дословный TR-1, records.md остаётся
черновиком; логи `tsc`/`eslint` 0 байт без явного кода возврата; снимок porcelain — просто более ранний срез;
шаг 6 шаблона отдельно не перепрогонялся, эквивалентен по построению); S4-заметки: `day.ts` принимает
`startsAt: null` с заданным `endsAt` независимо — правдиво покажет «(время не задано)–HH:MM», шаблон свадьбы
такую комбинацию не производит (оба поля `NULL` вместе); шапка «Тайминг без времени: дата свадьбы ещё не выбрана»
ключуется по дате свадьбы, а не по наличию пустых блоков — датированная свадьба с вручную вписанным временем
через `PUT …/timeline` тоже может получить блок «(время не задано)» без шапки; первая регулярка `audit49k:152`
Уфа-специфична (`/\b0\d:00 Сборы/`), остальные проверки теста зоно-независимы и ловят все пояса. FL-12 — G5
минорные m1–m4 (m1: «9/9 захватов замка» в FL-12.md §7 против подтверждённых 8/8 — первый лог перезаписан
успешным прогоном; m2: «903 прошло» против точных 900+3-флейк из строки 169 GATELOG — суть не расходится;
m3: бэкенд-сторожа контракта/схем отдельно не перечислены, покрыты полным прогоном; m4 = S4 ниже); S4: первый
`approve` после предшествующего `verify` тоже не шлёт «Анкета проверена» (условие ключуется на `moderated_at`,
который `verify` тоже проставляет — механизм TR-1, не дефект лейна), изменённая причина отказа на повторном
`approve` журналируется в `audit_log`, но подрядчику не долетает (согласовано с «одно решение — одна новость»).

## Сделано · 2026-09-19 — живой обход ролей и кнопок (поручение владельца «проверить каждую роль и сценарий, понажимать все кнопки»)

ERR-0269, ERR-0270, JOURNAL «Живой обход ролей и кнопок», карты `live-016`. Инструменты — `scratchpad/live/crawl/*` (обходчик,
сценарии, фикстуры; в репозиторий не входят).

- [x] Фикстуры dev-базы: пара со свадьбой и данными, помощник, координатор, фотограф (бронь/аванс/договор), флорист (лид),
  гости с ссылками; позже DJ через мастер и видеограф для заявки — одноразовые номера, токены только в файлах
- [x] Обходчик кнопок (playwright-core, headless Chromium): шесть ролей × 127 экранов, 1 449 нажатий с чистой загрузкой перед
  каждым, 390 px (пара — и 1280): 0 `pageerror`, 0 `console.error`, 0 ErrorBoundary, 0 накрытых после правки онбординга;
  325 ответов `≥400` разобраны — матрица доступа, закрытый чат дня X, погашенные ссылки, служебный 404 анкеты, обмен refresh
- [x] Сценарии с проверками: онбординг → SMS → квиз → свадьба (7/7); новый подрядчик через мастер → каталог → модерация (7/7);
  пара ↔ DJ ↔ гость — чат, бронь, аванс, договор, кабинет, RSVP, складчина (8/8); команда по ссылке `/join` (5/5); заявка:
  ответ → hold → вернуть (3/3); язык, выход с устройства (3/3); отмена свадьбы, отзыв согласия, удаление аккаунта (3/3)
- [x] Найдено и закрыто: пятна онбординга накрывали «Далее»/«Пропустить» (ERR-0269); помощнику на «Написать» — «Сначала
  заведите свадьбу» → 403 «ведёт пара»; «Бюджет не загрузился» у помощника → «ведёт пара»; «Добавить в свадьбу» у уже
  забронированного → «открыть сделку»; «Поделиться» без Web Share → «Скопировано» (ERR-0270). `audit48` бэк (1) и фронт (6)
- [x] Гейты: фронт 55 файлов · 809, бэк с базой 82 · 885 | 10, tsc/eslint 0/0, `init.sh` exit 0; серверы погашены

Владельцу (не блокирует): `users.lang` на сервере не пишется и не читается (язык — свойство устройства); `GET /vendor/profile`
→ 404 у пары на каждой анкете — лишний запрос, можно заменить признаком в `GET /users/me`; чип «Свободны на дату» нельзя
снять повторным нажатием; «+15 мин» и «Написать» у помощника показывают отказ сервера словами — можно прятать по роли.

## Сделано · 2026-09-18 — корзина 1 после сверки планов (поручение владельца «сделай»)

Контракт **v0.40.0** (130 путей, 175 операций, 65 схем), миграция **39**. ERR-0268, JOURNAL «Корзина 1».

- [x] Правила Тиля §3.14 на сервере — `GET /weddings/{id}/tips` (`wedding/tips.ts`): дефицит категории, блокирующий слот, лимит
  бюджета > 85 %; главная, мозаика и бюджет показывают серверные подсказки; клиентское правило 80 % убрано. `audit47` (бэк/фронт)
- [x] Карточка сделки подрядчика `/vendor-app/deals/:id` (План §8.2): состояние, оплаты (`paid`), договор (заголовок), журнал,
  «Написать паре» (`chatId`), «Открыть спор»; строки списка — кнопки
- [x] Заполненность анкеты — `VendorDetail.completeness` (`vendor/completeness.ts`, одно правило с панелью, тест сверяет)
- [x] Описания категорий — миграция 39 (35 строк), `Category.description`, строка под шапкой `/search/:catId`
- [x] `plural` в EN по `Intl.PluralRules`; `ring-[var(--rose)]` вместо `#C98A8A` ×6 (R-01, P3 закрыт)
- [x] Живая проверка кликом (390 и 1280): вход с двумя галочками, жалоба → 201 и строка в `complaints`, «N рядом», описание
  категории, выгрузка → файл 19 КБ / 14 разделов, права на портфолио → `mediaRights: true`, карточка сделки, подсказки на
  главной и мозаике, «Прочитать все» одним запросом, офлайн день X при обрыве API
- [x] Обход кликабельности: 41 маршрут на 1280, 42 на 390 (низ страницы), 84 прохода — **найдено и закрыто:** панель «Написать /
  Добавить в свадьбу» на `/vendor/:id` под таб-баром на телефоне (`.action-bar` над ним), «Далее» мастеров анкеты и договора
  под таб-баром (`pb-28`), «+15 мин» из офлайн-копии была открыта. Сторож в `shell.test.tsx`
- [x] Гейты, карты (`basket-1`), записи, коммиты

## Сделано · 2026-09-18 — хвосты четырёх планов end-to-end (поручение владельца «по порядку все закрой»)

Сверка планов по коду (четыре разведчика, JOURNAL «Сверка планов»): ~20 пунктов ⚠️/❌, девять — ни в одном журнале.
Закрыто кодом всё, что не ждёт ключей. Контракт **v0.39.0** (129 путей, 174 операции, 64 схемы), миграция 38.

Бэкенд:
- [x] Б1 Миграция 38: `consents.adult`, `vendors.media_rights_at`, `job_marks`
- [x] Б2 Контракт v0.39.0: `adult` в согласии; `mediaRights` в анкете; `POST /notifications/read-all`; `PATCH …/album`;
  `Category.vendorsCount` + `?city`; описание `Category` без `lib/data.ts`
- [x] Б3 Обработчики, генераторы, `audit46` (8): согласие 18+, права на портфолио, read-all, альбом, счётчик, сторож без эскроу
- [x] Б4 Фоновые `after` (00:05) и `catering` (09:00, −14 и −7) — ключи в `job_marks`, тесты в `audit46`
- [x] Б5 Гейт бэка с базой: **80 файлов · 878 прошло | 10 (Redis)**; tsc/eslint 0/0

Фронт:
- [x] Ф1 Вход: «Мне есть 18 лет» → `adult: true` (`consent`/`audit27`/`audit32` — под вторую галочку)
- [x] Ф2 Мастер анкеты, шаг 5: права на портфолио → `mediaRights`; без галочки публикация закрыта словами
- [x] Ф3 `ComplaintSheet` → `POST /complaints`: анкета, отзыв в кабинете, собеседник в чате (по последней реплике), спор по сделке
- [x] Ф4 «Выгрузить мои данные» → `GET /users/me/export` → файл JSON
- [x] Ф5 «Прочитать все» → read-all; «Одобрить все» → один `PATCH` (`persist` — под read-all)
- [x] Ф6 `/search`: «N рядом» из `vendorsCount` по городу
- [x] Ф7 Тексты сделки и сторожа без эскроу и «приложим»; словарь EN (+31 ключ)
- [x] Ф8 Офлайн день X (`lib/offlineDay.ts`): копия тайминга/плана Б/команды с меткой времени, чистится при выходе
- [x] Ф9 `audit46.test.tsx` (15); гейт фронта: **53 файла · 792 прошло**, tsc/eslint 0/0, сборка чистая

Записи:
- [x] Д1 `todo.md` (этап 6 — пять пунктов закрыты), `MIGRATION-PLAN.md` §2, `AUDIT.md` (пять чекбоксов), План §20.1
  (43 · 22 · 2, 15 маршрутов, №40/45), `CLAUDE.md`, `RELEASE-BLOCKERS.md` №29–31, карты (`plans-015`), ERR-0265…0267, JOURNAL
- [x] Д2 Репетиция восстановления: копия 72 МБ / 8 с / 65 таблиц / 38 миграций, `pg_restore --list` чист; чистая база — нужен
  пароль `postgres` (№31); `restore-drill.sh` — порядок аргументов `psql` под Windows
- [x] Д3 `bash init.sh` — **exit 0**; коммиты явными путями; handoff

Владельцу (не блокирует): ИИ-подбор подрядчиков — после ключа модели (№27); погода (№29); канал поддержки (№30); пароль
`postgres` для репетиции (№31). P3 `ring-[#C98A8A]` — закрыт корзиной 1 (блок выше).

## Сделано · 2026-09-18 — живая проверка ревью 015 при поднятых серверах (пункт 2 «следующего шага»)

Playwright на 1280 и 390, dev-серверы 3001/3000 на общей базе, токены подбором кода (в чат не печатались).

- [x] Очередь консьержа: заявка пары 201 (повтор категории — 409 `concierge_pending`) → `/admin/concierge` (телефон, `tel:`,
  «просрочено») → «В работу» → «Подобрано» (карточка ушла, паре — «Консьерж подобрал варианты» → `/search`) → закрытая — 409
  «Заявка уже закрыта»; не сотрудник — 403. В dev-базе 361 открытая заявка старых прогонов — данные, не код.
- [x] Выход: 4xx на `DELETE /users/me/sessions` — слова под кнопкой, токены на месте; настоящий выход — три запроса, хранилище
  пусто, `/auth`. Смерть сессии (мёртвый токен) — стор пуст, «Войдите» с кнопкой.
- [x] Без свадьбы: `/wedding/guests|budget|checklist|timeline|logistics` — «заведите её» с кнопкой. `/wedding` — была красная
  строка без кнопки → `ErrorState` с «Завести свадьбу» (FB6 доведён).
- [x] Бронь с пакетом из анкеты: `packageId` + `Idempotency-Key` в теле, слот «ЗАБРОНИРОВАН», в `/vendor-app/deals` «Пакет: …».
- [x] **Найдено и закрыто (ERR-0263):** десктоп ≥900px — правило сайдбара `.glass-tab` ловило шапку и строку ввода чата (чаты
  открывались пустыми) и панель брони анкеты (под сайдбаром, не нажималась) → `nav.glass-tab`; сторож в `shell.test.tsx`.
- [x] **Найдено и закрыто (ERR-0264):** после смерти сессии каталог перечитывал данные без токена и показывал «Нужен заголовок
  Authorization: Bearer» с «Повторить» → `SIGN_IN_REQUIRED` в `request()`, `ErrorState` на `/search`, `/search/:catId`,
  `/vendor/:id`, `/favorites`; `AsyncState` сравнивал ключ без `t()` (в EN «Sign in» не показывался). `audit45` +3, `shell` +1.
- [x] Гейт фронта: tsc 0 · 52 файла · 777 тестов · eslint 0 · сборка чистая; `bash init.sh` — **exit 0** (бэк без базы 190 | 690
  пропущено, не менялся). Карты пересобраны (`live-015`). Записи: ERR-0263/0264, JOURNAL, handoff, CLAUDE.md.
- [x] Владельцу, P3: `ring-[#C98A8A]` в шести местах — **закрыто корзиной 1 (2026-09-18): `ring-[var(--rose)]`**. Было: (`Quiz.tsx` ×2, `Search.tsx` ×2, `VendorApp.tsx`, `DatePicker.tsx`) — хардкод
  вместо `var(--rose)` (R-01); в тёмной теме `--rose` = `#D69999`, рамка выбора остаётся светлой. Правка механическая, не делал.

## Сделано · 2026-09-18 — ревью 015 (фичи 005–014, семь ревьюеров): бэкенд, контракт v0.38.0, фронт, очередь консьержа

Триаж и итог — `tasks/фичи/015-ревью-фич-005-014/triage.md`. Бэкенд 2026-09-13 (F1–F9, C1–C12, G1–G15) был не закоммичен и без
тестов — довёл, дописал V1–V15, D2–D11; контракт v0.38.0 (128 путей, 172 операции, 64 схемы: `GET/POST /admin/concierge…`,
`failed` у напоминания, `pay` «пусто = остаток», отзыв 403/404, `guest-vendor` поля). Миграций не добавлялось (37).

- [x] Бэкенд: `chats/post.ts` — одна дверь для реплик (кабинет заявок → те же проверки); доступ подрядчика к чатам по виду;
  квота Тиля под замком и без `failed`; `settle` с отбоем; `safeText`; вход по всем живым кодам; сессии без протухших; телефон
  гостя нормализуется; замки автобус/отель/свадьба→сделка/резерв/консьерж; оплата остатком по `PAID_SUM`; лид из `won`;
  курсоры панели с микросекундами; очередь консьержа. `audit44` (18); `audit33`/`prod13`/`stage3`/`audit13-live` — под правила.
  Гейт с базой: 79 · 870 | 10 (Redis); tsc/eslint 0/0. Коммит `d055ac7`.
- [x] Фронт FA1–FA5, FB1–FB7, P2 (20): смерть сессии → `forgetSession`; отказ на выходе словами; `packageId`; `holdDates`;
  экраны без свадьбы — `noWedding()`; `/admin/concierge`; квиз без `t()` на уровне модуля; число мест/номеров обязательно;
  подарки с приглашения; `notificationRoute` кабинета; Enter/двойной тап под замком. `audit45` (7); `audit20`/`audit33`/
  `audit35`/`consent`/`nomocks` — под правила. Гейт: 52 · 773, tsc/eslint 0/0, сборка чистая. Карты (`review-015`).
- [x] Прод: nginx `access_log off` на `/api/`; compose `stop_grace_period: 30s`.
- [x] Записи: ERR-0256…ERR-0262 (R-256…R-262), JOURNAL, RELEASE-BLOCKERS №28, CLAUDE.md (v0.38.0), handoff.
- [~] Отклонено намеренно: сверка категории анкеты со слотом при брони (V1, ERR-0037); V7 не подтвердилась (фильтр на месте).

**Осталось владельцу:** №28 в `RELEASE-BLOCKERS.md` (миграции: CASCADE переписки и `referrals`, флаг `system` у сообщений,
индекс `guest_invite_codes(guest_id)`; продукт: «Город свадьбы», согласие при живых сделках, правка одобренной анкеты, периоды
воронки, лимиты на номер; контракт vs код: подрядчики в чате дня, гость не снимает автобус) + прежнее (ключи №1–№6, №8, №11–№14,
№17, №27; worktree в `app/.claude/worktrees/`).

## Сделано · 2026-09-13 — фича 014 «Хвосты до прода» (поручение владельца «закрывай все хвосты и доводи до прода»; четыре ответа одним «да»)

Папка `tasks/фичи/014-хвосты-до-прода/` (спека — инвентарь A1–A19, B1–B7, C1–C4). Контракт v0.37.0 (`POST /weddings/{id}/slots`, `Message.mine`,
заметки `…/notes`, `VerificationSubmit`, `AdminCategoriesUpdate`, `transport`). Четыре миграции — всего 37.

- [x] Бэкенд A1–A3, A8–A10, A12–A15, A17, A18, B1, B2, B5: `audit43` (10, все красные на HEAD), четыре старых теста под новые правила
  (`audit23`, `audit26`, `audit28`, `audit34`). `RESERVATIONS_MAX_PER_GUEST` в `.env.example`.
- [x] Фронт A4–A9, A11, A16, заметки с сервера + перенос с устройства, бронь вне шаблона: `audit41` (11) + `sw.test.ts` (правило кэша из исходника), 13 из 16
  красных на HEAD; `audit17`/`audit36` — под новые правила; новые строки в `i18n.en.ts` (блок фичи 014).
- [x] Прод: `deploy/nginx.conf`, `deploy/Dockerfile.web`, `deploy/docker-compose.prod.yml`, `DEPLOY.md` (№19); `.nvmrc` + `engines` (№20); `recharts` +
  `chart.tsx` убраны, `npm audit --omit=dev` чист (№21); `npm run migrate:fresh` — 37 миграций с нуля в чистой схеме (№22); тестовые строки поправлены,
  `VALIDATE` обеих проверок миграцией (№26). README/RUNBOOK — ссылки на `DEPLOY.md`.
- [x] Живьём: перенос заметки → сервер, добавление/удаление; «Салют» вне шаблона забронирован — 13-й слот; настройки подрядчика с тихими часами (PATCH);
  «Выйти только с этого устройства» у пары. Гейты: бэкенд 78 · 852 | 10, фронт 51 · 765, tsc/eslint 0, сборка чистая.
- [x] Карты (`feature-014`), RELEASE-BLOCKERS №7/№19–№22/№26, CLAUDE.md (v0.37.0), BACKEND-PLAN (`notes`), JOURNAL, ERR-0254/ERR-0255, handoff.

**Осталось владельцу:** ключи (№1–№6, №8, №11–№14, №17, №27); инструменты Тиля — после ключа; забытый `git worktree` в `app/.claude/worktrees/`
(276 МБ, HEAD `2f00a07`) — удалить `git worktree remove` или оставить (ERR-0255).

## Сделано · 2026-09-13 — фича 013 «Сделки для поддержки» (решение владельца: сделки без чатов; блокер №24 закрыт) + splash вычеркнут

Папка `tasks/фичи/013-сделки-для-поддержки/` (4 задачи, все закрыты). Контракт v0.36.0 (`GET /admin/weddings/{id}/deals`, `SupportDeal`).

- [x] Бэкенд: сделки свадьбы поддержке с причиной и журналом `wedding.deals.view` — имена без телефонов, цена, оплачено, история; `audit42` (2, 501 до фикса).
- [x] Фронт: «Показать сделки» на карточке свадьбы → список; подпись «Список гостей и переписка поддержке не показываются»; `audit40` (2, красные на HEAD).
- [x] План §20.1 №1 splash — вычеркнут из MVP (решение владельца 2026-09-13); карты (`feature-013`), RELEASE-BLOCKERS №24, CLAUDE.md (v0.36.0), JOURNAL, handoff.

## Сделано · 2026-09-13 — фича 012 «Заполненность анкет» (малая, без вопросов; блокер №23 закрыт)

Папка `tasks/фичи/012-заполненность-анкет/` (4 задачи, все закрыты). Контракт v0.35.0 (`AdminMetrics.profiles`).

- [x] Бэкенд: `profiles` (описание, телефон, цена «от», пакет — фото после хранилища), дашборд одним снимком `REPEATABLE READ`; `audit41` (1, красный до фикса).
- [x] Фронт: карточка «Заполненность анкет» в панели, прочерки до ответа; `audit39` (2, красные на HEAD). Карты (`feature-012`), RELEASE-BLOCKERS №23,
  CLAUDE.md, JOURNAL, ERR-0253 (R-247: замки `mkdir` до старта — хук повторяет команды параллельно), handoff.

## Сделано · 2026-09-13 — фича 011 «Радиус поиска» (малая, без вопросов; блокер №16 закрыт)

Папка `tasks/фичи/011-радиус-поиска/` (4 задачи, все закрыты). Контракт v0.34.0 (`radiusKm` описан, `Vendor.distanceKm`).

- [x] Бэкенд: `distanceKm` в выдаче тем же гаверсинусом (0 — свой город, null — без `city`/координат, у анкеты — null); `audit40` (3, красные до фикса).
- [x] Фронт: выбор «Радиус поиска» (только город · 50 · 100 · 300; умолчание 100 = прежнее молчаливое умолчание сервера), `radiusKm` в запросе и ключе
  страницы, подпись «N рядом · до 100 км», карточка «· Бирск · 80 км»; `audit38` (2, красные на HEAD). Прогоны: бэкенд 75 · 839 | 10, фронт 48 · 751;
  tsc/eslint 0; сборка чистая; `init.sh` exit 0. Живьём: 300 км — «· Бирск · 80 км», «· Стерлитамак · 123 км»; «только город» — без них.
- [x] Карты (`feature-011`), RELEASE-BLOCKERS №16, CLAUDE.md, JOURNAL, handoff.

**Хвосты (не блокируют):** координаты у 27 из 119 городов — остальные ждут геокодера (владелец); одноимённые города разных регионов — якорь по имени.

## Сделано · 2026-09-12 — фича 010 «Тиль на живой модели» (свой цикл, В1–В4: OpenRouter / локальная модель, `tilly_usage`, лимит со счётчиком)

Папка `tasks/фичи/010-тиль-на-живой-модели/` (13 задач, все закрыты). План §8.9 контур 3 «чат-ассистент по данным проекта».

- [x] Миграция `tilly_usage`, контракт v0.33.0 (`Chat.tilly`, 429 `tilly_daily_limit`, `AdminMetrics.llm`). Коммит `7d8a70e`.
- [x] Бэкенд `src/tilly/*`: клиент OpenAI-совместимого протокола (OpenRouter `openrouter/free` по умолчанию, Ollama `hermes3`, любой
  совместимый сервер; без зависимости), контекст свадьбы без PII, системная подсказка с границами §8.9, служба — квота 50/сутки по поясу,
  фоновый ответ с «печатает», учёт, честные заглушка/отказ; `TILLY_*` в `config.ts`/`.env.example`; `tilly-client` (6), `audit39` (5, все
  красные на HEAD). Коммит `a88d15e`.
- [x] Фронт: «сегодня N из 50» и «без ИИ» в шапке чата Тиля (перечитывается после отправки), карточка «Тиль · модель за последний месяц»
  в панели; `audit37` (6, 4 красных на HEAD). Коммит `5b15dac` + хвост.
- [x] Прогоны: бэкенд 74 · 840 | 10, фронт 47 · 748; tsc/eslint 0; сборка чистая; `down`/`up` миграции. Живая проверка без провайдера:
  шапка, заглушка по живому каналу, счётчик «2 из 50», карточка в панели. Карты (`feature-010`), README «Тиль: провайдеры»,
  RELEASE-BLOCKERS №27 (модель за владельцем) и №23 (LLM — частично), BACKEND-PLAN, CLAUDE.md, JOURNAL, handoff.

**Владельцу:** ключ OpenRouter (`TILLY_PROVIDER=openrouter`, `TILLY_API_KEY`) или Ollama на сервере (`TILLY_PROVIDER=ollama`,
`ollama pull hermes3`) — `RELEASE-BLOCKERS.md` №27; после включения — живая проверка ответа модели и подбор `TILLY_MODEL` по качеству
русского (бесплатный маршрутизатор меняет модель под капотом). **Хвосты (не блокируют):** ответ теряется при перезапуске сервера
посреди вызова (очередь — с Redis); инструменты модели (каталог, действия с подтверждением) — отдельная фича; стоимость в рублях
на дашборде не считается.

## Сделано · 2026-09-12 — фича 009 «Гостевой день X» (свой цикл, В1–В3 по рекомендации)

Папка `tasks/фичи/009-гостевой-день-x/` (13 задач, все закрыты). Экраны Плана §20.1 №59, 60 → «да»; итог «да» 47 · «внутри» 18 · «нет» 2
(splash; фото гостя — нет хранилища).

- [x] Миграции `timeline_events.for_guests`, `messages.guest_id` (CHECK «один автор»), контракт v0.32.0 (`GET /join/{t}/day`, чат дня гостя
  с 423 вне окна, `TimelineEvent.forGuests`, `Message.guestName`). Коммит `a988b89`.
- [x] Бэкенд: день гостя одним запросом (программа только «для гостей», стол, автобус с перевозчиком, координатор — с кануна, окно чата),
  чат дня гостя `GET`/`POST`, `guestName` у реплик; `audit38` (7 + 3 утверждения хвостов). Коммит `7806fc3` + хвосты в коммите фронта.
- [x] Фронт: раздел «День свадьбы» на `/invite` (с кануна по `tz` места), `/invite/day-chat`, галочка «Показывать гостям» в тайминге,
  «имя · гость» в чате пары; `audit36` (20, 18 красных на HEAD). Прогоны: бэкенд 72 · 825 | 10, фронт 46 · 743; tsc/eslint 0; сборка чистая.
  Карты (`feature-009`, `feature-008`).
- [x] Живая проверка: пара скрыла «Сборы невесты» → гость с кануна видит раздел без них, стол, координатора с `tel:`, чат → реплика →
  у пары «Марина Гостева · гость». Дата свадьбы пары сдвигалась SQL на сегодня и возвращена.
- [x] Записи: ERR-0251 (R-245), JOURNAL (008, 009), План §20.1, CLAUDE.md (v0.32.0), RELEASE-BLOCKERS №22 (32 миграции), handoff.

**Владельцу (не блокирует):** показывать ли раздел «День свадьбы» гостям, не ответившим на приглашение к кануну (сейчас — только «приду»);
своя реплика гостя в чате узнаётся по имени — тёзка покажется «своей» (признак гостя в `Message` — правка контракта).

## Сделано · 2026-09-12 — фича 008 «Импорт гостей списком, заявка консьержу, деталь задачи» (решения — по поручению владельца)

Папка `tasks/фичи/008-гости-импорт-консьерж-задачи/` (10 задач, все закрыты). Экраны Плана §20.1 №29, 18 → «да», №12 → «внутри».

- [x] Контракт v0.31.0 (`POST /weddings/{id}/guests/import`, 1…300 строк, `created`/`skipped` с причиной); бэкенд `guests.ts` — одна
  транзакция под замком строки свадьбы, дубликаты по имени/телефону (с базой и внутри запроса), телефон → `+7…`, `invalid` не
  блокирует остальных; `audit37` (4 + тест переименования задачи). Коммиты `438e605`, `bada451`.
- [x] Фронт: `lib/guestsImport.ts` (разбор текста, 19 тестов), «Добавить списком» с предпросмотром и одним `POST`, «Оставить заявку
  консьержу» при пустой выдаче (`POST /catalog/concierge`, 409 словами сервера), раскрываемая задача («Переименовать» → `PATCH`,
  «Удалить» → `DELETE`). `audit35` (14, 13 красных на HEAD). Коммит `c7314b1`.
- [x] Прогоны и живая проверка — вместе с фичей 009 (блок выше). Карты (`feature-008`), План §20.1, JOURNAL.

**Хвосты (не блокируют):** город консьерж-заявки — из store (`tt_city`), не из свадьбы; `group` в импорте контракт принимает,
экран не заполняет (нет надёжного признака в тексте).

## Сделано · 2026-09-12 — фича 007 «Кабинет подрядчика: чаты, настройки, анкета глазами пары» (В1–В4 по рекомендации)

Папка `tasks/фичи/007-кабинет-подрядчика/` (13 задач, все закрыты). Экраны Плана §20.1 №49, 53, 56 → «да».

- [x] Контракт v0.30.1 (`Lead.chatId`; владелец видит свою анкету и неопубликованной) — `4b1b013`; бэкенд `catalog.ts`/`vendorCabinet.ts`,
  тест `audit36` (3) — `88231cd`.
- [x] Фронт: `VendorTabBar` с бейджем непрочитанных, `/vendor-app/chats(/:id)`, карточка «Чаты с парами», «Открыть чат» из заявки,
  `/vendor-app/settings` (режим подрядчика, выход только с этой сессии), своя анкета на `/vendor/:id` с плашкой и «Редактировать».
  Тест `audit34` (22). Прогоны: бэкенд 70 · 813 | 10, фронт 43 · 687; tsc/eslint 0; сборка чистая. Карты (`feature-007`).
- [x] Живая проверка подрядчиком: навигация, чаты, переписка, настройки, превью — без дефектов.
- [x] Записи: ERR-0250 (R-244), JOURNAL, План §20.1, handoff.

**Владельцу (не блокирует):** показывать ли подрядчику тихие часы и виды уведомлений; дать ли паре «Выйти только с этого
устройства»; скрывать ли `TabBar` пары на своей анкете; признак владельца в ответе каталога вместо `GET /vendor/profile`.

## Сделано · 2026-09-12 — фича 006 «Транспорт: перевозчик как подрядчик» (свой цикл, В1–В4 по рекомендации)

Папка `tasks/фичи/006-транспорт/` (`spec.md`, `plan.md`, `tasks.md` — 14 задач, все закрыты).

- [x] Миграция `bus_routes.deal_id` (FK deals, SET NULL), контракт v0.30.0 (`BusRoute.dealId`/`carrier`, `PATCH …/logistics/buses/{busId}`,
  `busRoutes` у сделок кабинета, `notifiedGuests` снят). Коммит `79eba2d`.
- [x] Бэкенд: маршрут ссылается на транспортную сделку (422 `not_transport`, 409 `deal_cancelled`), правка маршрута с 409 `bus_full`,
  `carrier` паре и гостю, счётчики маршрутов перевозчику без имён, заметка перевозчику, `detachBusRoutes` во всех дверях отмены
  (ERR-0249). `audit35` (10). Прогон 69 · 810 | 10 (Redis).
- [x] Фронт: «Перевозчик» в форме маршрута, «Изменить», `?deal=` из карточки сделки, блок «Маршруты для гостей», подпись у гостя,
  «Маршрутов: N · записалось M из K» в кабинете. `audit33` (12). Прогон 42 · 662; tsc/eslint 0; сборка чистая. Карты (`feature-006`).
- [x] Живая проверка цепочки «карточка транспортной сделки → маршрут с перевозчиком → гость видит `carrier`» — без дефектов.
- [x] Записи: ERR-0249 (R-243), JOURNAL, `BACKEND-PLAN.md`, `Бизнес-логика` §12.1, CLAUDE.md, RELEASE-BLOCKERS №22.

**Хвосты (не блокируют):** свой вид заметки «транспорт» в `vendor_updates.kind` (миграция + enum контракта — пока `timeline`);
сервер позволяет привязать `candidate`/`negotiating`-сделку (фронт предлагает только живые).

## Сделано · 2026-09-12 — фича 005 «Хвосты ревью старого кода» (свой цикл, план одобрен владельцем В1–В8)

Папка `tasks/фичи/005-хвосты-ревью/` (`spec.md`, `plan.md`, `tasks.md` — 26 задач, все закрыты).

- [x] Семь миграций (чат своего подрядчика по сделке, автобус по персонам, отзыв по гостю, `deals.package_id`, CHECK
  санкций, ограничения заявок, `vendors.couple_reviews_count`) — применены, `down 7`/`up 7` проверены; две CHECK
  `NOT VALID` из-за старых тестовых строк (`RELEASE-BLOCKERS.md` №26). Коммит `f7e43b5`.
- [x] Контракт v0.29.0 (120 путей, 160 операций, 57 схем) — столы `PATCH`/`DELETE`, `GET` push-подписок, тела 202 и дня X,
  `Guest.comment`/`hasPhone`, `Message.system`, `Chat.closed`, `Deal.packageName`, `HotelBlock.mine`, `tz` гостю,
  `VendorDetail.blocked`, `shortfall`, 409 `wedding_exists`/`chat_closed`, `Error.details`, `AuthTokens.consentRequired`.
- [x] Бэкенд (`7fc0f40`): правила схемы в коде (23505/23514 → 409 с кодом), восстановление удалённого ≤30 дней, лимиты OTP
  номер+IP 3/ч · номер 10/ч · 30/сут с честным `Retry-After`, порог рейтинга по парам, столы, права на гостей и напоминание
  (матрица + обработчик), вторая свадьба 409, `gen-templates.mjs` удалён → `templates.ts`. Тесты `audit32` 11 · `audit33` 22 ·
  `audit34` 14. Прогон: 68 · 800 | 10 (Redis).
- [x] Фронт: столы (переименовать/удалить), выбор сделки на «Документах», комментарий и `hasPhone` гостя, «Напомнить» только
  паре, закрытый чат и `system`, `blocked`/`shortfall`/`packageName` в кабинете, «Вы здесь»/«Перенести бронь?» у гостя, список
  push-подписок, таймер 429, 409 второй свадьбы → переход к своей, честные строки рассылок и дня X. Тест `audit32` (31).
  Прогон: 41 · 650; tsc/eslint 0; сборка чистая. Карты пересобраны (журнал `feature-005`).
- [x] Живая проверка (dev-сервер + браузер): 409 второй свадьбы с `weddingId`; два чата флористов — А закрыт без поля ввода,
  Б пуст, ссылка А — 410; стол — 409 «уже 2 человека» и переименование; комментарий и телефон гостя у пары; выбор сделки на
  «Документах»; «Push не включён» — дефектов нет.
- [x] Записи: ERR-0246…0248 (R-240…R-242), JOURNAL 2026-09-12, RELEASE-BLOCKERS №22/№26, BACKEND-PLAN схема, CLAUDE.md.

**Владельцу (не блокирует):** помощник/координатор могут записать телефон гостя, но не читать — закрывать ли запись; перенос
брони отеля — второй тап вместо диалога; заблокированной анкете оставлена «Сохранить изменения»; строка старше 30 дней при
входе — 401 до ежечасного стирания (как до фичи). **Фича 006** (перевозчик как подрядчик) — сделана тем же днём, блок выше.

## Сделано · 2026-09-11 — ревью старого кода шестью агентами и фиксы (149 находок)

- [x] Шесть ревьюеров по доменам (`scratchpad/review-old/D1…D6.md` в записях сессии): 149 находок, 4 критичных, ≈40 высоких.
- [x] Контракт v0.28.0 (`8cf90ef`, `8c89f46`, коды ответов в `1624d17`, `27e8164`): nullable у дресс-кода, `Slot.label`,
  `User.phone`/`name` nullable, `endpoint` у отписки push, честное описание плана Б, 400/401/404/409/422/429 у затронутых операций.
- [x] Шесть фиксеров по непересекающимся файлам, ~120 находок закрыто с красными тестами: бэкенд `audit28…31` (+100 тестов),
  фронт `audit27…29` (+114); девять старых тестов, сертифицировавших дефекты, переписаны. Свод uuid (32 копии → `isUuid`).
  Коммит `1624d17` (91 файл). ERR-0219…ERR-0239.
- [x] Живая проверка после зелёных прогонов нашла два дефекта в самих фиксах — выход висел без service worker, 409 на
  свою сессию оставлял её живой (`27e8164`, ERR-0232, ERR-0233). Карты пересобраны (журнал `rev-old-code`).
- [x] Прогоны: бэкенд 65 · 748 | 10 (Redis), фронт 38 · 579, tsc/eslint 0, сборка чистая.
- [x] Второй раунд: живая проверка экранов + ревью фиксов двумя агентами по дифу — 16 находок (1 высокая: токен убранного
  подрядчика гас одной дверью из трёх), все закрыты, плюс четыре попутные фронтовые; коммит второго раунда (27 файлов),
  ERR-0242…0244, R-237/R-238. Прогоны: бэкенд 65 · 752 | 10, фронт 39 · 601.
- [x] Третий раунд: ревью фиксов второго раунда (REVIEW-FIX-R3, 4 находки) и фикс-агент FIX-FE-E — `useApi.refreshing`,
  кнопки дня X и трёх редакторов «весь список одним PUT» закрыты на окно «принято, но не показано», слот/сделка различают
  «без входа / едет / пусто / не пришёл», push ждёт активации воркера; попутно — запись закрыта при упавшем первом GET и
  `adoptWeddings` после повторного входа. `audit31` (19). ERR-0245, R-239. Карты пересобраны (журнал `rev-fix-r2-r3`).
  Прогоны: фронт 40 · 620, tsc/eslint 0, сборка чистая.
- [x] Попутно: ранжирование каталога по показанному рейтингу (`388add6`, ERR-0216), главная без свадьбы (`8f724cd`, ERR-0217),
  тесты без ложных красных под нагрузкой (`910db6f`, ERR-0218), `audit8` по имени (`083b234`, ERR-0215), `String.replace` с `$` (ERR-0240).

**Хвосты ревью старого кода** — вынесены в фичу 005 (`tasks/фичи/005-хвосты-ревью/`), см. блок «В работе» ниже.
- **Мелочи в отчёт, не в код:** `chat_reads` не выгружается в экспорт; `RESERVATIONS_MAX_PER_GUEST = 5` — в конфиг, если
  понадобится менять; идемпотентность без `request.url` в хеше и `saveResult` вне транзакции (D2-13, не стреляет — фронт ключи
  не переиспользует); ленивое `expireHolds` из `loadSlots` двумя запросами без транзакции (D2-20 — `negotiating` сегодня
  недостижимо); курсор сообщений с точностью до мс против мкс в базе (D4-23); хаб при Redis дольше 250 мс может дублировать
  событие (D4-24); токены дня X `--dark-bg/--dark-gold` из плана §10.2 в `index.css` нет — экран несёт `data-theme="dark"`.

## Сделано · 2026-09-08 — три фичи по выбору владельца (свой цикл, без Spec Kit)

- [x] Фича 002 — очередь заявок на верификацию (`RELEASE-BLOCKERS` №25 закрыт): `tasks/фичи/002-верификация/`, 22/22.
- [x] Фича 003 — отмена свадьбы из приложения и уборка архива (План §20.1 №45, `RELEASE-BLOCKERS` №10 закрыт):
  `tasks/фичи/003-отмена-свадьбы/`, 15/15.
- [x] Фича 004 — версия справочника категорий (ревью 001, A-09): `tasks/фичи/004-версия-справочника/`, 8/8.
- [x] Попутно: `sw.js` кэшировал ответы `/api/` cache-first в проде — `9bcc57d` (ERR-0204); журнал сделки при отмене свадьбы
  писал новое состояние вместо исходного (ERR-0206); кэш даты переживал отмену свадьбы (ERR-0208).
- Контракт v0.27.0: 119 путей / 157 операций / 55 схем. Коммиты `2be1112` (спеки), `1651745`, `0ce75ed`, документы — см. `git log`.

**Хвосты трёх фич (владельцу или следующей сессии):**
- Частичный уникальный индекс «одна `pending`-заявка на подрядчика» — миграция после «да» (сейчас держит обработчик подачи).
- Подача заявки на верификацию из приложения — вместе с хранилищем (№3): загрузка → `fileUrl` → `POST /vendor/verification`.
- Уборка архива и рассылка событий сделок работают, когда работают фоновые задачи (Redis, №2).
- Причина отмены свадьбы — у пути нет тела; План §19.3 говорит о причине отмены брони. Решение о продукте.
- Уборка отменённой свадьбы **удаляет отзывы пары** по её сделкам (`CHECK reviews_key_matches_source` требует сделку, сделка
  уходит каскадом — ERR-0209); отзывы гостей остаются. Сохранить отзыв пары можно только миграцией (ослабить `CHECK`
  до «отзыв пары БЫЛ по сделке») — решение владельца.
- Из ревью фич 002–004, владельцу: `CHECK (file_url like 'https://%')` на `vendor_verifications` — миграция; значок
  категории нельзя стереть ничем (сервер по `coalesce` сохраняет старый) — либо явное «убрать значок», либо
  различать «не прислали» и «null»; тела `POST /vendor/verification` и `PUT /admin/categories` описаны прямо в путях,
  и их правила живут второй копией в обработчиках — вынести в именованные схемы (55 → 57) и `ref()`; контракт
  ужесточился (`fileUrl` только https, `version` 16 hex, пределы словаря) без бампа версии — при выпуске поднять.
- `sw.js` кэширует same-origin картинки по типу запроса: если фото анкет или аватары когда-нибудь пойдут с того же
  origin по пути API (не с хранилища), они лягут cache-first до следующей версии кэша — сузить до `/assets/` тогда же.
- ~~Главная без свадьбы показывает «0% готово · 0 гостей»~~ — **сделано 2026-09-11:** стор хранит итог сверки списка
  (`weddingsState`), главная без свадьбы говорит словами — «Свадьбы пока нет» → квиз, «Войдите» → вход, «Сервер
  недоступен» — и ставит прочерки (ERR-0217).
- ~~Каталог «по рейтингу» сортирует по столбцу `vendors.rating`, заполненному уже при одном отзыве, хотя наружу
  число скрыто до трёх~~ — **сделано 2026-09-11 по слову владельца:** ключ сортировки и курсора — показанный
  рейтинг (`reviews_count >= 3`), анкеты без числа идут после всех с числом (ERR-0216, R-228).
- Тестовые аккаунты сессии: подрядчики `+79993334401` (верифицирован), `+79993334402` (документы отклонены), пара
  `+79993334403` (свадьба отменена); сотрудник по-прежнему `+79972874000`.

---

## Сделано · 2026-09-07 — админка (фича 001)

- [x] Пять экранов Плана §20.1 (63–67) + вход из меню «Мы» по `isStaff`. Спека, план, задачи (34/34) —
  `tasks/фичи/001-админка/`. Коммиты `814bd77`, `a57b575` + документы. Владелец в отъезде: вопросов не задано,
  спорное — допущениями A1–A12 в `spec.md`; любое можно пересмотреть точечно.
- [x] Живая проверка сотрудником: решения, санкции, словарь, карточка свадьбы — строки `audit_log`, уведомления,
  поиск по новому синониму; тёмная тема. Протокол — `JOURNAL.md`, запись «Админка».

**Хвосты фичи:**
- `CHECK` на `complaints.resolution` по `target_kind` — после «да» владельца одна миграция с правилом из
  `APPLICABLE_ACTIONS` (`backend/src/routes/admin.ts`); сейчас правило только в обработчике (422).
- [x] `ApiError.fields` во фронте (`22b40f8`): 422 с `error.fields` ставит текст сервера под виноватым словом словаря
  и под причиной снятия; общий текст остаётся.
- [x] План приложения приведён к факту (§12.1 стек, §20.1 таблица «Факт на 2026-09-07»: 40 да / 17 внутри / 10 нет;
  `JOURNAL.md`). **Владельцу:** какие из десяти отсутствующих экранов вычеркнуть или сделать и что делать с десятью
  маршрутами вне списка плана (`/favorites`, `/notes`, `/tools/alcohol`, `/inspiration`, `/venues`, `/wedding/logistics`,
  `/wedding/catering`, `/wedding/wishlist`, `/gifts`, `/wedding/album`) — R-15.
- Тестовый аккаунт `+79972874000` оставлен сотрудником (`users.is_staff = true`) — в меню «Мы» виден пункт «Админка»;
  снять: `update users set is_staff = false where phone = '+79972874000'`.
- Из ревью фичи (не закрыто кодом, нужны решения): (а) справочник категорий сохраняется «последний выигрывает» —
  два открытых экрана затирают правки друг друга; лечится версией справочника в `GET /admin/categories` и 409 при
  расхождении — правка контракта; (б) причина просмотра карточки свадьбы уходит строкой запроса (`?reason=`) и
  попадает в логи прокси — так задано контрактом; перевести на тело POST или оставить осознанно; (в) `maxItems: 100`
  у категорий — экран шлёт справочник целиком, на 101-й сохранение начнёт отказывать; (г) `GET /users/me/export`
  описан как пустой `object` (R-208) — описать схему выгрузки или закрепить запрет тестом контракта.

**Следующий шаг:** владелец читает допущения A1–A12 спеки и `RELEASE-BLOCKERS.md` №23–25 (LLM-стоимость на
дашборде, просмотр сделки поддержкой, очередь верификации), закрывает №1–6, №22 — дальше стенд и повтор блоков
9–10 `AUDIT.md` плюс живая проверка панели на стенде.

---

## Сделано · 2026-09-06…07 — аудит перед выпуском (блоки 0–10)

Чек-лист с доказательствами — `AUDIT.md`; хвост владельца — `RELEASE-BLOCKERS.md`; дефекты и правила —
`ERRORS.md` ERR-0165…ERR-0194, R-183…R-206.

- [x] Блок 0 — окружение, базовая линия (фронт 23·295, бэкенд 49·555+9)
- [x] Блок 1 — контракт против бэкенда: v0.24, NUL-хук, 409 при удалении с живой сделкой (`b072a3b`)
- [x] Блок 2 — транзакции, блокировки строк, refresh из двух вкладок, срок годности push (`dcb5cff`)
- [x] Блок 3 — права и 152-ФЗ: матрица ролей живьём, журнал сделки, стирание аккаунта (`703c8c7`)
- [x] Блок 4 — фронт против API: четыре состояния у каждого запроса, галочка «Проверен» по полю, изоляция фоновых задач (`b718ee5`)
- [x] Блок 5 — инвентаризация 347 элементов, карты из кода, еда/трансфер/телефон гостя, контракт v0.25 (`428d064`)
- [x] Блок 6 — моки и заглушки, NUL в исходниках, RELEASE-BLOCKERS.md (`22fa089`)
- [x] Блок 7 — тексты: тринадцать обещаний без кода, числительные, «из 0 ₽» (`9a9e691`)
- [x] Блок 8 — realtime и уведомления: клиентский push, ссылки по роли, свежий токен после 4401 (`5644b99`)
- [x] Блок 9 — готовность: сборка без предупреждений, PNG для iOS, `.env` под игнором, чанк React (`86ca0af`)
- [x] Блок 10 — сквозной сценарий трёх ролей, доказанный базой (`backend/test/audit22.test.ts`)

**Следующий шаг:** владелец закрывает `RELEASE-BLOCKERS.md` №1–6 (SMS, Redis, хранилище, ключи Web Push, юрист,
Роскомнадзор) и прогоняет `npm run migrate up` на пустой базе (№22); после этого — выкладка на стенд и повтор
блоков 9–10 против него.

---

## В работе · 2026-09-04 — перевод фронта на реальный API

План целиком — `MIGRATION-PLAN.md` (12 этапов, инвентарь на 94 действия, 5 дыр в контракте).

### Этап 0 — окружение проверки

- [x] PostgreSQL 16.15 поднят локально. Docker не завёлся: заклинили AF_UNIX сокеты, сокет ломается в момент создания, лечится только перезагрузкой — поставлен нативно
- [x] Кластер создан вручную: winget разложил файлы, но `initdb` не выполнил. Роль и база `tili` — как в README, чтобы документированная команда работала без правок
- [x] 21 миграция применена, 62 таблицы
- [x] Прогон с `TEST_DATABASE_URL`: было 111 тестов, стало 482 — **371 молчавший тест ожил**
- [x] Найден дефект: `test/audit8.test.ts:338` — `.resolves` без `await`. Правило «два отзыва — рейтинг скрыт, три — показан» не проверялось никогда: сначала утверждение висело в воздухе, потом файл ушёл в пропуск. Коммит `f8b3c81`
- [x] Десять тестов ждут Redis (было «девять» — число выросло вместе с набором тестов, пересчитано ревью 016 F-RL6-12, R-267). `winget install Memurai.MemuraiDeveloper` упирается в подтверждение UAC — это защита Windows, из терминала не обходится, нужен владелец за машиной — **ЗАКРЫТО 2026-09-26: Memurai 4.1.2 стоит службой, полный прогон с базой и Redis — ноль пропущенных (ERR-0303).**

### Этап 1 — слой запросов

- [x] Типы из контракта: `app/src/lib/api/schema.ts` через `openapi-typescript`. Опечатка в адресе — ошибка сборки, а не 404 в проде
- [x] Клиент `app/src/lib/api/client.ts`: таймаут 15с, единый `ApiError` (сеть/таймаут/http), обмен refresh **одним промисом на все параллельные запросы** — refresh одноразовый, лишние обмены выглядят как кража и гасят все сессии
- [x] Доступность сервера отдельно от `navigator.onLine` — `app/src/lib/api/health.ts`
- [x] Прокси `/api` → `127.0.0.1:3001` в `vite.config.ts` (3000 занят сервером разработки), `.env.example`
- [x] `OfflineBanner` различает «нет сети» и «сервер не отвечает», строка переведена
- [x] `/health` и `/health/ready` внесены в контракт, генераторы прогнаны (инвариант 9), комментарий в `routes/health.ts` приведён к реальности
- [x] Проверено вживую в браузере: сервер поднят → плашки нет; убит → 500 → плашка. 229 тестов фронта, 513 бэка
- [x] ~~Коммит ждёт: общее рабочее дерево переключено на ветку параллельной сессии `fix/audit-backend-2026-09-04`~~ — закрыто (ревью 016, F-RL6-12, R-267): репозиторий на `main`, HEAD `e67ffcf`; ветка `fix/audit-backend-2026-09-04` — остаток той сессии (2026-09-04), давно неактуальна

### Этап 2 — авторизация

- [x] `POST /auth/otp` и `/auth/otp/verify`: четыре любые цифры больше не открывают приложение
- [x] Таймер повтора из ответа сервера (`resendAfter`), а не выдуманные 42 секунды
- [x] Согласие на ПДн уходит на сервер с версией документа, датой и IP — по 152-ФЗ доказательством должна быть наша запись
- [x] Выход гасит сессии через `DELETE /users/me/sessions`; удаление аккаунта чистит локальное только после ответа сервера
- [x] Три ошибки найдены живым прогоном: пустое тело 201 роняло запрос, согласие уходило неверным телом, глушение ошибки в `catch` (ERR-0113)
- [x] Проверено в браузере: неверный код не пускает, верный заводит пользователя, сессию и согласие в БД. 231 тест
- [x] ~~**Решение владельца:** редакцию документа клиенту негде взять — `policyVersion` только в теле запроса, ни один ответ его не отдаёт (MIGRATION-PLAN.md §2.6)~~ — закрыто 2026-09-06: `GET /legal/policy` отдаёт `policyVersion` без входа (ERR-0114); подтверждено ревью 016 (F-RL6-12, R-267), `MIGRATION-PLAN.md:168` «§2.6 закрыто 2026-09-06»

### Этапы 3–5 — свадьба, каталог, чтение

- [x] **Этап 3** — свадьба как сущность: квиз создаёт её через `POST /weddings`, `weddingId` живёт в состоянии и восстанавливается через `GET /weddings`
- [x] **Этап 4** — каталог: категории, выдача, анкета, занятость по датам, избранное
- [x] **Этап 5** — чтение свадьбы: мозаика, бюджет, чек-лист, гости, тайминг, документы, план Б

### Этап 6 — запись свадьбы · СДЕЛАН 2026-09-04

- [x] Мозаика: бронь, отмена, оплата, свой подрядчик — с ключом идемпотентности; состояние плитки считает сервер
- [x] Экран сделки переехал на `/deal/:id` и показывает настоящую сделку; переходы состояний через `PATCH /deals/{id}`
- [x] Чек-лист: галочка и своя задача уходят на сервер, у задачи появился срок
- [x] Гости: добавление, RSVP, удаление; еда и трансфер стали ответом гостя, а не переключателем пары
- [x] Бюджет: своя статья с выбором категории, удаление по идентификатору
- [x] Столы и рассадка: столы с сервера, место гостя — поле `tableId` у гостя
- [x] Тайминг: добавление и удаление блока через `PUT`, автоплан как предпросмотр с конфликтами
- [x] Дата свадьбы уходит переносом; отказ `409 team_busy` виден человеку
- [x] Две ошибки бэкенда закрыты: пояс тайминга при записи (ERR-0123) и первая простановка даты (ERR-0124). Регрессия — `backend/test/prod9.test.ts`
- [x] `Task.due` внесён в контракт (ERR-0125): сервер срок считал, но не отдавал
- [x] Утечка доступа закрыта: «удалить своего подрядчика» больше не подменяется отменой (ERR-0126)
- [x] Проверено в браузере и запросами в базу по каждому действию. 239 тестов фронта, 522 бэка

### Дальше по плану

- [x] **Этап 7** — гостевые сценарии по токену. `b2d214a`, `30a9b58`, `5b32511`, `2daf2c9`, перепроверка `9743b4f`, `2460a98`
- [x] **Этап 8** — подарки и медиа. `ba7bdf8`, `9b49e4f`, перепроверка `4b0ac32`. Загрузка файла с устройства ждёт объектного хранилища — хвост владельца
- [x] **Этап 9** — кабинет подрядчика. `f8acdba`, перепроверка `e64c211` (ERR-0143…ERR-0145)
- [x] Перепроверка этапа 8: отзывы гостей дошли до пары, итоги «После свадьбы» считаются по своей свадьбе (ERR-0141, ERR-0142)
- [x] **Этап 10** — реальное время и чаты. `e3f4fc6`, `19c8372`, перепроверка `c06d9dc` (ERR-0149…ERR-0151). Живой канал проверен без Redis: хаб доставляет внутри процесса
- [x] **§2.6 редакция согласия** — закрыта `fe177b7`. Оказалась закрытой ещё в ERR-0114; настоящая дыра была рядом: подпись под номером, которого человек не видел (ERR-0163), и вход без согласия (ERR-0164).
- [x] **Этап 11** — снос моков. `6015871`, перепроверка `fcd994e` (ERR-0159…ERR-0162: ноль выдавался за факт, «Загружаем…» навсегда, индикаторы ни из чего). `lib/data.ts` удалён; шесть экранов, остававшихся витринами, переведены на сервер (уведомления, настройки, чек-лист плана Б, отзывы подрядчика, «Тиль», площадки). Убраны обещания без кода — эскроу, штраф рейтинга, подбор замен ИИ (ERR-0153…ERR-0158). Регрессия — `nomocks.test.tsx`: 38 экранов без сервера, ни следа моков

**Миграция закончена: все 12 этапов пройдены.** Дальше — только хвосты владельца
(S3, Redis, SMS, VAPID, Sentry, почта, платежи, юридические тексты, Роскомнадзор)
и шесть дыр контракта, каждая из которых требует решения о продукте.

### Решения владельца, накопившиеся к этапу 6

Все пять закрыты кодом задолго до 2026-09-18 — чекбоксы не обновлялись (ERR-0267). Ниже — как есть, с отметками.

- [x] **Сколько уже оплачено по сделке.** В схеме `Deal` есть цена и состояние, но не сумма платежей. Экран показывает факт оплаты, а остаток посчитать не может — «оплачено 30 000 из 50 000» сейчас негде взять — **закрыто кодом:** `Deal.paid`/`paidAt` в контракте, «Оплачено X из Y» на `/deal/:id` (волна 3, 2026-09-03). Отметка поставлена при сверке планов 2026-09-18: пункт держали открытым, хотя код давно был
- [x] **Резерв «непредвиденное» 10%** (План ч. 283) — по плану это категория бюджета, которую заводит сервер. В ответе `GET /budget` её нет; на клиенте рисовать нельзя — **закрыто кодом:** `Budget.reserve` с сервера, полоса на `/wedding/budget`. Отметка поставлена при сверке планов 2026-09-18: пункт держали открытым, хотя код давно был
- [x] **Мозаика — 12 слотов, категорий в каталоге 35.** Подрядчика из категории вне мозаики забронировать некуда, добавить слот контракт не умеет. Сейчас экран честно говорит об этом — **закрыто кодом:** `POST /weddings/{id}/slots {categoryId}` — слот вне шаблона (фича 014). Отметка поставлена при сверке планов 2026-09-18: пункт держали открытым, хотя код давно был
- [x] **Журнал сделки.** `PATCH /deals/{id}` пишет события (`deal_events`), но пути на чтение нет — история сделки на экране показать нечем — **закрыто кодом:** `GET /deals/{id}/events`, блок «Что происходило» на `/deal/:id` (ревью старого кода). Отметка поставлена при сверке планов 2026-09-18: пункт держали открытым, хотя код давно был
- [x] **Напоминание гостям, не ответившим на RSVP.** Массовой рассылки в контракте нет; кнопка ведёт на экран приглашений — **закрыто кодом:** `POST …/guests/remind` — SMS каждому молчащему (2026-09-05, `d733652`); без провайдера код уходит в лог (№1). Отметка поставлена при сверке планов 2026-09-18: пункт держали открытым, хотя код давно был

---

## В работе

**Подготовка к прод-релизу — план в `tasks/prod-plan.md`, 11 находок в 4 волнах.**

- [x] **Волна 1** — часовые пояса городов и полная выгрузка данных (152-ФЗ). 420 тестов
- [x] **Волна 2** — четыре поля, которые всегда возвращали пустое: мягкая бронь, отзывы в карточке, чат своего подрядчика с таймингом, дата рассылки опроса. Плюс рассылка гостям, которая никого не оповещала. 432 теста, контракт 0.17
- [x] **Волна 3** — чек-лист плана Б на сервере, правка цены сделки до аванса, избранные истории «Вдохновения» (два решения владельца 2026-09-03). Заодно: планом Б командует и координатор. Контракт 0.19
- [x] **Волна 4** — поведение под отказом (три поломки при мёртвом Redis), заголовки безопасности и таймауты, сквозной проход ролью подрядчика (две дыры), механическая сверка полей ответа со схемой. 447 тестов, контракт 0.20
- [x] **Иерархия переписки** (вопрос владельца 2026-09-03): подрядчик с бронью вернулся в чат команды по §3.11 — координатору стало где командовать; заведён чат исполнителей без пары, пара видит строку без содержимого. 453 теста, контракт 0.21
**Даты и календари — вопрос владельца 2026-09-03.** Решения: работаем и во фронте, и в бэке; диапазон даты свадьбы — год назад … пять лет вперёд.

Бэкенд:
- [x] Б1 `src/wedding/dates.ts`: реальная дата + диапазон, 422 вместо 500
- [x] Б2 Применить везде, где дата принимается: свадьба, перенос, занятость подрядчика, дедлайн брони отеля, фильтр каталога
- [x] Б3 Каскад переноса вынесен в `src/wedding/reschedule.ts`; `PATCH /weddings` идёт через него (ERR-0087)
- [x] Б4 Тесты: занятость, сроки задач и тайминг едут за датой; занятая команда — 409; `2027-02-30` — 422. 462 теста

Фронт:
- [x] Ф1 Дата в `tt_wedding_date`; подпись, «дней до» и обратный отсчёт считаются от неё
- [x] Ф2 Квиз: календарь вместо трёх строк; ответы сохраняются в `tt_quiz` (ERR-0086)
- [x] Ф3 Главная, договор и превью приглашения берут дату из состояния
- [x] Ф4 Смена даты на экране «Мы» — тем же календарём
- [x] Ф5 Карта экранов и карта кнопок обновлены с записью в журнал
- [x] Ф6 Тесты фронта: 181 → 192

**Телефон подрядчика — вопрос владельца 2026-09-03.**
- [x] Отдельное поле анкеты (`vendors.phone`), а не номер входа: заполнение и есть согласие на публикацию
- [x] Виден паре и её команде только после брони; отмена сделки закрывает обратно
- [x] Фронт: поле в мастере анкеты, блок контакта в карточке, карты обновлены
- [x] 469 тестов бэка, 195 фронта, контракт 0.23

**Стили в квизе — вопрос владельца 2026-09-03.**
- [x] Двенадцать стилей вместо шести; список собран из «Вдохновения» и тем приглашений
- [x] Под каждым — строка, что этот стиль значит
- [x] План ч. 295 поправлен под факт (решение владельца, R-15): связки «6 стилей × 2» нет
- [x] 198 тестов фронта, карты обновлены

- [x] ~~**Следующий шаг:** сквозной проход ролью гостя по коду. Дыр в реализованных путях пока не найдено; известные пробелы — возвращающийся гость и гостевая сторона чата дня X — записаны в «Хвосты» как границы MVP~~ — закрыто (ревью 016, F-RL6-12, R-267): гостевой день X и чат дня X реализованы фичей 009 (`day.ts:1370-1441`), подтверждены живым обходом ролей 2026-09-19

**Этап 9 — эксплуатация и 152-ФЗ. Новых путей нет, 4 дня.**

- [x] `scripts/backup.sh` — копия в формате custom, проверка целостности сразу, хранение 30 дней
- [x] `scripts/restore-drill.sh` — репетиция: копия → ЧИСТАЯ база → разворачивание → сверка. Прогон: 60 таблиц, 13 миграций, 5 с
- [x] Удалённый аккаунт через 31 день не находится ни в одной таблице, кроме журнала — проверено обходом `information_schema`
- [x] До 31-го дня аккаунт ещё возвращается
- [x] Одиннадцатый запрос за секунду получает 429 — критерий этапа закреплён тестом
- [x] Экспорт данных пары одним файлом
- [x] `RUNBOOK.md`: 7 сценариев отказа и таблица локаций с датой проверки
- [x] 403 → 408 тестов
- [x] **Sentry подключён** (решение владельца): уходят только неожиданные ошибки и падения фоновых задач, адреса маскируются как в логе. Без `SENTRY_DSN` молчит и говорит об этом

## Сделано · 2026-09-04 — цикл спеки фичи в харнессе

- [x] Заведён `Тили-тили/Тили-тили_Спека_фичи.md`: пять шагов (спека → вопросы → план → задачи → сверка), три шаблона, порог включения
- [x] `CLAUDE.md`: строка в §2 (источники правды) и правило в §6.1. Нумерация пунктов §6 не тронута — на §6.3 есть ссылки
- [x] `JOURNAL.md`: почему взяты 5 механик GitHub Spec Kit и почему сам Spec Kit в проект не поставлен
- [x] **Обкатано 2026-09-07** на первой фиче — админке (`tasks/фичи/001-админка/`): спека без техники, план с воротами, 34 задачи; сверка независимым агентом нашла одну критичную и восемь высоких до первой строки кода. Урок: методичка обещает «12 инвариантов» в `CLAUDE.md` §5, их 16 — поправить при следующем касании документа.

## Сделано · 2026-09-03 — бэкенд, этап 8: кабинет подрядчика, отзывы, модерация

- [x] Контракт v0.14: выручка в аналитике — `Money`, прирост может быть `null`, у лида дата и город допускают пустоту
- [x] Таблицы `leads`, `reviews`, `complaints`, `category_synonyms` + признак сотрудника и санкции у анкеты
- [x] Лид рождается из «Написать» и из брони; повтор не создаёт второго
- [x] Отзыв пары — только по сделке в `done`, один на сделку, окно 14 дней; отзыв гостя — после свадьбы, по токену
- [x] Рейтинг с затуханием; до трёх отзывов число не показывается, и фильтр по рейтингу это уважает
- [x] Скрытый модератором отзыв уходит и из показа, и из рейтинга
- [x] Антиспам: непроверенный подрядчик — не больше 5 новых переписок в день
- [x] Документы верификации наружу не выходят; блокировка убирает анкету из выдачи
- [x] Админка целиком; сотрудник — признак в базе, пути выдачи прав нет; просмотр чужого проекта требует причины и пишется в журнал
- [x] **Три ошибки по дороге:** декоратор не виден соседнему модулю (ERR-0065), правка накатанной миграции (ERR-0066), гостевой путь мимо белого списка (ERR-0067)
- [x] 359 → 387 тестов. Реализованы все операции контракта
- [x] **Перепроверка нашла 5 дыр:** отзывы негде прочитать (ERR-0069), гость весил как пара (ERR-0070), понижение ничего не понижало (ERR-0071), затухание останавливалось (ERR-0072), у экрана «Сделки» не было пути (ERR-0073)
- [x] 387 → 397 тестов, контракт v0.15
- [x] **Закрытие этапа нашло ещё 3 дыры:** заявка приходила пустой (ERR-0074), детектора вывода сделки не существовало (ERR-0075), срок разбора жалобы ничем не обеспечен (ERR-0076)
- [x] 397 → 403 теста, контракт v0.16
- [ ] **Не сделано осознанно:** автофильтр мата в отзывах (нужен словарь от владельца), чёрный список по телефону и документу (отдельная работа), лимиты файлов и антивирус в чате (упираются в S3)

## Хвосты — что осталось и кто это закрывает

Список сквозной: сюда стекается всё, что не сделано, с причиной. Пункт
уходит отсюда только вместе с записью в `JOURNAL.md`.

### 1. Без этого не запустить боевой стенд — нужен владелец

| Что | Почему это блокирует | Что происходит сейчас |
|---|---|---|
| **Аккаунт SMSAero** (`SMS_PROVIDER`, `SMSAERO_*`) | В production сервер не стартует без настоящего отправителя: код из лога — это вход для любого, кто читает логи | Проверка в `auth/sms.ts` роняет запуск с понятной строкой |
| **Ключи VAPID** (`pnpm gen:vapid` → `.env` и панель Timeweb) | Без них push отправить нечем | `POST /users/me/push-subscriptions` → 501 `push_not_configured`, уведомления приходят в приложении |
| **S3 в Timeweb** (`S3_*`) | Фото и видео анкет, кадры альбома, сканы верификации грузить некуда | `POST /media/upload-url` → 501 `storage_not_configured` |
| **Почтовый отправитель** | Сводка кейтерингу и цепочка «после свадьбы» уходят письмом, у гостя аккаунта нет | Три задачи раздела 5 не поставлены в расписание |
| **Платёжный провайдер и эскроу** | Оплаты записываются, но денег не двигают | Маркетплейс «Купить в приложении» и выплата фондов паре не сделаны намеренно |
| **Приложения OAuth** (ВК, Яндекс, Google, Telegram) | Регистрирует владелец | `/auth/oauth/{provider}` → 501 `oauth_not_configured`, кнопок на экране входа нет |
| **Тексты оферты и политики** от юриста | Без них согласие на ПДн юридически пустое | В `policyVersion` лежит дата, тексты — заглушки фронта |
| **DSN для Sentry** | Ошибки видны только в логах процесса | Сбор подключён, без DSN молчит и пишет об этом в лог |
| **Уведомление в Роскомнадзор** до первого реального пользователя | 152-ФЗ | — |
| **Полный справочник координат городов** | `radiusKm` считается по тем городам, у которых координаты есть | Города без координат в радиус не попадают |

### 2. Нужно решение владельца — работа понятна, ответа нет

**Опрос 2026-09-05 — восемь ответов получены, семь закрыты кодом:**

| Вопрос | Ответ владельца | Что сделано |
|---|---|---|
| С чего начинать код | этап 9, кабинет подрядчика | следующий шаг |
| Категорий 25 или 35 | 35, как в плане | в коде и базе уже 35 — правка касалась только документов |
| Сумма платежей по сделке | добавить | `Deal.paid` и `paidAt`, экран сделки (`1bf03ba`, `d733652`) |
| Резерв «непредвиденное» 10% | отдельной строкой от сервера | `Budget.reserve`, строка и предупреждение (`5e075f7`, `d733652`) |
| Журнал сделки | обеим сторонам | `GET /deals/{id}/events`, блок «Что происходило» |
| Напоминание молчащим гостям | одной кнопкой | `POST …/guests/remind` + кнопка; гостю с открытой ссылкой не пишем |
| Ограничитель частоты | 10 в секунду | так и было в коде; расхождение осталось в плане |
| Фильтр мата | пока без фильтра, жалобы вручную | ничего не делаем осознанно |
| Верификация подрядчика без S3 | делать экран, загрузка честно выключена | войдёт в этап 9 |
| Чёрный список по телефону | позже, с первым случаем | ничего не делаем осознанно |
| План против факта (67/48 экранов, стек) | привести план к факту | **осталось**: правка ч. 12.1 и списка экранов |


- **Словарь автофильтра отзывов** (§15). Выдуманный список слов даёт ложные срабатывания на живых отзывах. Либо готовый словарь, либо решение обойтись ручной модерацией по жалобе — она уже работает.
- **Чёрный список по телефону и документу** (§18.2). Сейчас блокируется анкета; заблокированный заводит новый аккаунт на другой номер. Хранение телефонов заблокированных — это ПДн: нужно решение, храним ли и как долго.
- **Число ограничителя частоты.** §13.4: «10 запросов в секунду на токен». Раздел 6 плана: «10 в минуту» для гостевых. Сейчас 10/с (`RATE_LIMIT_PER_SECOND`).
- ~~**Категорий 25 или 35.**~~ — снято 2026-09-07: в базе, контракте и панели 35 (`RELEASE-BLOCKERS.md` №9).

### 2б. Всплыло в этапе 9 — нужно решение владельца

- **Отказ по заявке молчит.** `POST /vendor/leads/{id}` с `action=decline` меняет состояние
  заявки и не пишет паре ничего: она продолжает ждать ответа. Ответ (`reply`) уведомление
  поднимает, отказ — нет. Либо шлём вежливое уведомление об отказе, либо оставляем как есть
  и говорим подрядчику писать в чат (сейчас так и написано на экране).
- **Заполненность анкеты считает клиент.** Семь полей поровну — это подсказка «чего не
  хватает», а не оценка качества. Если проценту нужен вес (фото важнее телефона), правило
  задаёт владелец, и считать его должен сервер.

### 3. Ждёт внешних служб — сделаем, когда они появятся

- **Лимиты файлов, антивирус, авто-перевод RU↔EN** (§19.4) — после S3.
- **Сводка кейтерингу, напоминания гостям по RSVP, цепочка «после свадьбы»** (раздел 5) — после почты и SMS.
- **Маркетплейс и выплата фондов** (§9, §10.1) — после платежей.

### 4. Границы MVP — не дыры, а решения

- **Кнопки SOS в дне X на бэкенде нет.** Бизнес-логика (раздел «сценарии дня X») помечает пункт готовым и требует «карточку координатора онлайн, SLA, эскалацию из чата дня X». В контракте пути нет ни одного. Сейчас пара пишет координатору в чат команды — это работает, но SLA и эскалации нет.
- ~~**Гость не ходит в чат дня X.**~~ — закрыто фичей 009 (2026-09-12): чат дня гостя по его ссылке (`/invite/day-chat`, `GET/POST /join/{t}/day-chat/messages`); своя реплика — по `mine` (фича 014).
- ~~**Возвращающийся гость не видит тайминга, стола и маршрута.**~~ — закрыто фичей 009 (раздел «День свадьбы» на `/invite`, `GET /join/{t}/day`); с фичи 014 — всем гостям, кроме «не приду».
- ~~**Карточка «Обновления от пар» во фронте на моках.**~~ — закрыто фичей 007 (2026-09-12): карточка с сервера, «Учёл» → `POST /vendor/updates/{id}/ack`; вид `transport` у маршрутов — фича 014.
- **Ключи `usePersist`, оставшиеся локальными осознанно:** черновики форм, свёрнутые блоки, выбранная вкладка. Переносить на сервер нечего — это удобство одного устройства, а не данные пары.
- ~~**Тиль без ИИ.**~~ — фича 010 (2026-09-12): OpenRouter / Ollama по `TILLY_*`; без ключа по-прежнему честная заглушка (`RELEASE-BLOCKERS.md` №27).
- ~~**Админка на фронте не начата**~~ — фича 001 (2026-09-07): пять экранов `/admin*`; сделки для поддержки — фича 013.
- ~~**67 экранов MVP против 48 роутов фронта**~~ — План §20.1, таблица «Факт» (2026-09-13): 47 со своим маршрутом, 18 блоками, splash вычеркнут, фото гостя — после хранилища.
- **Стек в плане ≠ факт** (ч. 12.1): React 19 вместо 18, Vite 7 вместо 6, свой Context вместо TanStack Query и Zustand, ни three.js, ни GSAP.

### 5. Закрыто по ходу работы

- ~~Деньги: копейки или рубли~~ — минорные единицы плюс код валюты у каждой суммы (решение владельца 2026-09-02).
- ~~Машина состояний сделки~~ — `candidate → contacted → negotiating → booked → paid_deposit → done` плюс `cancelled`.
- ~~openapi отстаёт от документации на ~15 эндпоинтов~~ — вишлист, свои подрядчики, логистика, опрос меню, отзывы гостей и лента отзывов внесены; контракт вырос до 105 путей.
- ~~Может ли помощник выдавать ссылки-приглашения~~ — нет, только пара (решение владельца 2026-09-03).
- ~~Лайки «Вдохновения»: сервер или браузер~~ — сервер, истории остаются во фронте (решение владельца 2026-09-03).
- ~~Нужна ли правка цены сделки~~ — да, до внесения аванса (решение владельца 2026-09-03).

## Сделано · 2026-09-03 — бэкенд, этап 8: кабинет подрядчика, отзывы, модерация

- [x] Контракт v0.14: выручка в аналитике — `Money`, прирост может быть `null`, у лида дата и город допускают пустоту
- [x] Таблицы `leads`, `reviews`, `complaints`, `category_synonyms` + признак сотрудника и санкции у анкеты
- [x] Лид рождается из «Написать» и из брони; повтор не создаёт второго
- [x] Отзыв пары — только по сделке в `done`, один на сделку, окно 14 дней; отзыв гостя — после свадьбы, по токену
- [x] Рейтинг с затуханием; до трёх отзывов число не показывается, и фильтр по рейтингу это уважает
- [x] Скрытый модератором отзыв уходит и из показа, и из рейтинга
- [x] Антиспам: непроверенный подрядчик — не больше 5 новых переписок в день
- [x] Документы верификации наружу не выходят; блокировка убирает анкету из выдачи
- [x] Админка целиком; сотрудник — признак в базе, пути выдачи прав нет; просмотр чужого проекта требует причины и пишется в журнал
- [x] **Три ошибки по дороге:** декоратор не виден соседнему модулю (ERR-0065), правка накатанной миграции (ERR-0066), гостевой путь мимо белого списка (ERR-0067)
- [x] 359 → 387 тестов. Реализованы все операции контракта
- [x] **Перепроверка нашла 5 дыр:** отзывы негде прочитать (ERR-0069), гость весил как пара (ERR-0070), понижение ничего не понижало (ERR-0071), затухание останавливалось (ERR-0072), у экрана «Сделки» не было пути (ERR-0073)
- [x] 387 → 397 тестов, контракт v0.15
- [x] **Закрытие этапа нашло ещё 3 дыры:** заявка приходила пустой (ERR-0074), детектора вывода сделки не существовало (ERR-0075), срок разбора жалобы ничем не обеспечен (ERR-0076)
- [x] 397 → 403 теста, контракт v0.16
- [ ] **Не сделано осознанно:** автофильтр мата в отзывах (нужен словарь от владельца), чёрный список по телефону и документу (отдельная работа), лимиты файлов и антивирус в чате (упираются в S3)

## Ждёт решения владельца

- **Словарь для автофильтра отзывов** (§15: «автофильтр мата/спама»). Выдуманный список слов даёт ложные срабатывания на живых отзывах — нужен готовый или решение обойтись ручной модерацией по жалобе.
- **Чёрный список по телефону и документу** (§18.2). Сейчас блокируется анкета: заблокированный заводит новый аккаунт на другой номер. Нужно решение, храним ли мы телефоны заблокированных и как долго — это персональные данные.
- **Расхождение в числах ограничителя частоты.** §13.4: «10 запросов в секунду на токен». Раздел 6 плана: «10 в минуту» для гостевых токенов. Сейчас 10/с из `RATE_LIMIT_PER_SECOND` — какое верно?
- **Ключи VAPID для боевого стенда.** Сгенерировать `pnpm gen:vapid`, положить в `.env` и в переменные окружения Timeweb. Пока их нет, `POST /users/me/push-subscriptions` честно отвечает 501, а уведомления приходят в приложении.
- **Почта и SMS для последних фоновых задач.** Осталось три: сводка кейтерингу (вебхук или письмо), напоминания ГОСТЯМ по RSVP (у гостя нет аккаунта — в приложении его не уведомить) и цепочка «после свадьбы». Нужен аккаунт SMSAero и почтовый отправитель. Дайджест дедлайнов и сводка по RSVP паре сюда больше не относятся — они работают уведомлением в приложении.

## Сделано · 2026-09-03 — бэкенд, этап 7: чаты, уведомления, день X

- [x] Контракт v0.12: ответ `Locked` (423), `openFrom` описан как есть, `senderId` может быть null
- [x] Таблицы `chats`, `messages`, `chat_reads`, `notifications`, `push_subscriptions` + режим плана Б
- [x] Чаты заводит база: день X и Тиль при создании свадьбы, срок едет за датой, команда — на второй сделке
- [x] Чат дня X виден заранее и до срока отвечает 423, а не 403
- [x] Тиль отвечает честно: «пока без ИИ», а не молчит
- [x] Непрочитанные — по отметке чтения на пользователя; история листается курсором
- [x] Тихие часы и лимит 3 в день; сделки и день X идут мимо обоих
- [x] Сдвиг тайминга двигает только будущие блоки; план Б запоминает сценарий
- [x] **Перепроверка нашла 3 дыры:** лимит push сваливал лишнее в один день (ERR-0053), чат дня X без даты был открыт (ERR-0054), мусор в `tz` ронял уведомления (ERR-0055)
- [x] 286 → 324 теста
- [x] **Доделано после решения владельца:** живой канал WebSocket через Redis, очередь BullMQ (push, уборка, страховка на бронь), отправка Web Push с генератором ключей
- [x] Критерий этапа проверен настоящим WebSocket: сообщение доходит второму соединению < 1 с
- [x] 324 → 338 тестов, контракт v0.13
- [x] **Второй проход нашёл 5 дыр:** треть очереди раздела 5 не сделана и зря названа заблокированной (ERR-0056), в день X не снимались тихие часы (ERR-0057), уведомления копились вечно (ERR-0058), сокет переживал токен и не спрашивал согласия (ERR-0059), «печатает…» заливал канал (ERR-0060)
- [x] 338 → 348 тестов
- [x] **Третий проход по матрице §18.6 нашёл 3 дыры:** подрядчик не получал ни одного уведомления (ERR-0061), о смене статуса сделки не узнавал никто (ERR-0062), ответы гостей не доходили до пары (ERR-0063)
- [x] 348 → 355 тестов; в расписании 8 задач раздела 5 из 9
- [x] **Четвёртый проход по §13.4 нашёл сквозную дыру:** ограничения частоты запросов не было нигде (ERR-0064); список чатов не двигался при новом сообщении
- [x] 355 → 359 тестов. Этап 7 закрыт

## Сделано · 2026-09-03 — решение владельца: ссылка-приглашение

- [x] `POST …/guests/{id}/invite-link` — только `couple`; список гостей у команды остался целиком
- [x] Правило в матрице доступа выше общего правила по гостям, без проверки в обработчике
- [x] Контракт v0.11, строка и правило в матрице BACKEND-PLAN ч. 6

## Сделано · 2026-09-03 — третий проход по этапам 5 и 6

- [x] Гостевые токены и коды ссылок маскируются в логе (ERR-0050)
- [x] 429 разделён на временный (с `Retry-After`) и постоянную квоту (без); у альбома 429 объявлен в контракте (ERR-0051)
- [x] Повтор по ключу идемпотентности отвечает до проверки предела (ERR-0052)
- [x] 278 → 285 тестов, контракт v0.10

## Сделано · 2026-09-03 — бэкенд, этап 6: подарки, складчина, фонды

- [x] Контракт v0.9: `Gift.mine` и `Gift.icon`, `Fund.icon`, `fairPrice` может быть null, 409 у удаления подарка с деньгами, 429 у взносов
- [x] Таблицы `gifts`, `gift_reservations`, `gift_contributions`, `funds`, `fund_contributions`, `anti_gifts` + триггеры сумм
- [x] Двойной резерв закрыт PK `gift_id`: два одновременных запроса — один 200, второй 409
- [x] Пара не видит дарителя: резерв читается через `exists(...)`, колонка `guest_token` не покидает базу
- [x] Складчина копится до цены, при 100 % подарок закрывается; перебор — 409
- [x] Взносы идемпотентны по ключу в пределах гостя (глобальная уникальность отвергнута: один гость закрыл бы ключ всем)
- [x] Ориентир «банкет на гостя» считается из бюджета площадки; нет данных — `null`, а не ноль
- [x] **Перепроверка нашла 4 дыры:** вечный резерв удалённого гостя (ERR-0046), чтение резервов парой через перевыпуск ссылки (ERR-0047), взносы без предела (ERR-0048), отказ на `POST` без тела (ERR-0049)
- [x] Живой HTTP-прогон 18/18; 266 → 278 тестов

## Сделано · 2026-09-03 — бэкенд, этап 5: гости, RSVP, рассадка, тайминг, логистика, меню, альбом

- [x] Контракт v0.7: `GuestTokenQuery` — у альбома токен был объявлен как path-параметр, которого в адресе нет
- [x] Миграция: `guests`, `guest_invite_codes`, `tables`, `bus_routes`, `bus_bookings`, `hotel_blocks`, `hotel_bookings`, `menu_polls`, `menu_options`, `menu_votes`, `album_photos`, `timeline_shifts`, `broadcasts`
- [x] Гость без аккаунта: одноразовая ссылка → персональный токен; сырой токен паре не отдаётся
- [x] 21 гость в автобус на 20 мест — ровно 20 успешных, счётчик и число записей совпадают
- [x] Повтор голоса меняет выбор, сумма не растёт
- [x] `notify-pickup` дважды за 30 с — одна рассылка
- [x] Рассадка: состав стола вычисляется, человек не оказывается за двумя столами
- [x] Задачи шаблона отмечаются, но не удаляются; автоплан только предлагает
- [x] Альбом: согласие обязательно, гостю видны только одобренные кадры
- [x] **Перепроверка нашла 3 дыры:** удаление гостя не возвращало место (ERR-0040), журнал рассылок рос без предела (ERR-0041), альбом принимал кадры без счёта (ERR-0042)
- [x] Проверено живым HTTP; 214 → 242 теста

## Сделано · 2026-09-03 — бэкенд, этап 4: слоты, сделки, деньги, документы

- [x] Контракт v0.6: `Document.pdfUrl`/`docxUrl` стали nullable, `Idempotency-Key` объявлен у `book` и `pay`
- [x] Миграция: `deals`, `deal_events`, `payments`, `budget_items`, `documents`, `external_invites`, `idempotency_keys`
- [x] Машина состояний: шесть состояний, только вперёд, отмена из любого
- [x] Мягкая бронь — срок `negotiating_until`, истечение применяется при чтении до появления фоновой задачи
- [x] Гонка «две пары на одну дату» — первичный ключ `vendor_busy_dates`, захват в одной транзакции с бронью
- [x] **Найдено: гонка «два бронирования в один слот»** — уникальность на `slots.deal_id` её не ловила (ERR-0035)
- [x] Идемпотентность `book`, `cancel`, `pay`, `PATCH /deals`, `reschedule`, договора
- [x] **Найдено: ключи идемпотентности копились вечно** (ERR-0036)
- [x] Бюджет на лету: обязательства по сделкам плюс ручные статьи; строки и доли из данных фронта
- [x] Свой подрядчик, ссылка на 30 дней, кабинет гостя-подрядчика без команды и бюджета
- [x] Договоры: интерполяция полей, версии, дисклеймер; файлы ждут хранилища
- [x] Перенос даты целиком или 409 со списком занятых; отмена свадьбы двумя партнёрами
- [x] Проверено живым HTTP; 168 → 204 теста

## Сделано · 2026-09-03 — бэкенд, этап 3: каталог и анкета подрядчика

- [x] Контракт v0.5: `date`, `ratingMin`, `hasVideo` в выдаче; `VendorUpsert.media` с длительностью; `Vendor.verified` и `hasVideo`. Два критерия этапа без этого были невыполнимы
- [x] Миграция: `vendors`, `vendor_packages`, `vendor_media`, `vendor_busy_dates`, `favorites`, `vendor_verifications`, `concierge_requests`
- [x] `vendor_busy_dates` — PK по паре: две брони на один день невозможны по построению
- [x] Длительность видео ≤180 с — и в схеме, и в `CHECK` базы
- [x] Каталог с фильтрами, курсорной пагинацией и ротацией новичков (≥10 % первой страницы)
- [x] Анкета, публикация, календарь занятости; дата под сделкой кнопкой не снимается
- [x] Избранное, заявка консьержу
- [x] Документы верификации не попадают ни в один ответ каталога — закреплено поиском подстрок в теле
- [x] **Перепроверка нашла 4 дыры:** открытый каталог (ERR-0029), анкета ушедшего подрядчика в выдаче (ERR-0030), `javascript:` в ссылке портфолио (ERR-0031), заявки консьержу без счёта (ERR-0032)
- [x] Проверено живым HTTP; 128 → 165 тестов

### Ждёт владельца

- [ ] **S3 в Timeweb** — `POST /media/upload-url` отвечает 501 `storage_not_configured`. Из-за этого же ограничение 180 с пока проверяется по числу от клиента

## Сделано · 2026-09-03 — перепроверка этапов 1 и 2

- [x] **Найдено: каждое обновление токена заводило новую сессию** — экран устройств показывал бы сотни «входов», время входа сбрасывалось каждые 15 минут (ERR-0025)
- [x] **Найдено: помощник видел `budgetTotal` и КОДЫ приглашений** — матрица закрывает пути, а не поля; код с ролью `couple` это повышение прав в один клик (ERR-0026)
- [x] **Найдено: `trustProxy: true`** — любой клиент назначал себе адрес заголовком и обходил ограничитель (ERR-0027)
- [x] **Найдено: свою свадьбу нельзя найти после переустановки** — у `/weddings` был только POST (ERR-0028)
- [x] Ограничителей отправки кода стало три: на номер, на адрес, общий потолок. Первый вариант лимита на адрес отрезал бы целого мобильного оператора за CGNAT
- [x] Гонка: двое одновременно удаляли друг друга и свадьба оставалась ничьей — стало одним `DELETE` с `NOT EXISTS`
- [x] Потолок суммы на входе: `Number()` за границей точного целого молча округляет
- [x] Экспорт по 152-ФЗ дополнен свадьбами
- [x] Коды из SMS убираются через час — это персональные данные
- [x] Предполётный запрос браузера проверен: матрица не должна его отбивать
- [x] Контракт v0.4: `GET /weddings`, границы `Money.amount`
- [x] 111 → 128 тестов, проверено живым HTTP

## Сделано · 2026-09-03 — бэкенд, этап 2: свадьба и команда

- [x] Миграция: `categories` (35 записей), `weddings`, `wedding_members`, `invites`, `referrals`, `referral_uses`, `slots`, `tasks`, `timeline_events`
- [x] **Матрица доступа — один хук на все пути свадьбы**, включая ещё не реализованные. helper и coordinator не видят бюджет уже сейчас
- [x] Запрет по умолчанию: неописанный путь доступен только паре
- [x] Чужая свадьба — 404, а не 403: по кодам ответа не перебрать чужие идентификаторы
- [x] Создание свадьбы заводит 12 слотов, 12 задач и шаблон тайминга из данных фронта; срок задачи считается от даты свадьбы
- [x] Приглашения: одноразовость условием в UPDATE, 7 дней, отзыв, приставка по роли
- [x] Коды выросли с 4 знаков до 8 — 20 бит перебираются скриптом за минуты
- [x] Последнего участника с ролью «пара» убрать нельзя — свадьба останется ничьей
- [x] Рефералы: код один на аккаунт, чужой применяется один раз, свой — никогда
- [x] **Найдено при этом:** в алфавите кодов остался `8`, хотя комментарий обещал обратное (ERR-0024)
- [x] Проверено живым HTTP; 89 → 111 тестов

## Сделано · 2026-09-02 — бэкенд, этап 1: вход, согласие, профиль, гео

- [x] **Расхождение до старта:** контракт описывал вход по email и паролю, фронт и план — код из SMS. Поправлен контракт (v0.3): `/auth/otp` и `/auth/otp/verify` вместо `/auth/register` и `/auth/login`; добавлен `DELETE /users/me/sessions`
- [x] Миграция: `users`, `sessions`, `consents`, `otp_codes`, `notification_prefs`, `audit_log`, `cities`
- [x] `audit_log` только дописывается — триггер, а не только права роли
- [x] Сид городов генерируется из данных фронта: 119 записей, 43 крупных, 27 с координатами
- [x] Вход по коду: 5 минут жизни, 5 попыток, 5 отправок в час; код хранится HMAC с серверным секретом
- [x] Ответ одинаков для нового и известного номера — по нему не узнать, кто зарегистрирован
- [x] JWT access 15 мин, refresh 30 дней с ротацией; повторное использование погашенного refresh гасит ВСЕ сессии
- [x] Согласие: версия документа проверяется сервером, 409 при расхождении; без согласия — 403
- [x] Профиль, сессии, выход со всех устройств, удаление аккаунта, экспорт данных
- [x] Гео: «сиб» → Сибай первым, ё→е, ближайший город по координатам
- [x] **Найдено при этом:** контракт обещал `Retry-After` при 429, обработчик его не ставил
- [x] Неописанное поле теперь отвергается с 422, а не вырезается молча
- [x] Проверено живым HTTP, не только inject; 59 → 89 тестов

### Отложено осознанно

- [ ] **OAuth** — 501 с кодом `oauth_not_configured`. Нужны приложения ВКонтакте, Яндекса, Google и Telegram (регистрирует владелец); на экране входа кнопок соцсетей нет
- [ ] **SMSAero** — учётная запись и ключ. Без них код уходит в лог; сценарий входа рабочий целиком
- [ ] **Координаты городов** — 27 из 119. Остальные приедут с Яндекс Геокодером

## Сделано · 2026-09-02 — перепроверка этапа 0

- [x] **Найден баг: Redis никогда не становился `ready`** — `lazyConnect` без `connect()`, в проде `/health/ready` вечно 503 (ERR-0020)
- [x] **Найден баг: Dockerfile не собирался** — политика pnpm отвергала лок-файл со свежими пакетами (ERR-0021)
- [x] Закрыт тестом отсев заглушек — механика, от которой зависит старт этапа 1
- [x] Закрыты тестами: конфликты формы путей, единство имени параметра, заглушки на всех методах, 422, 500 без утечки, CORS, битый JSON
- [x] Конфигурация: нечисловой `PORT`, опечатка в `NODE_ENV`, пустой `CORS_ORIGINS` в проде, одинаковые и короткие секреты — всё падает на старте
- [x] Живые PostgreSQL и Redis: миграция up/down/up, расширения, `citext`, `/health/ready` → 200
- [x] Образ собран и запущен: 200 / 200 / 501 / 404, SIGTERM — штатный останов
- [x] Сторож против отставания типов от контракта — проверен фальсификацией, ловит удалённую схему
- [x] 30 → 59 тестов

## Сделано · 2026-09-02 — бэкенд, этап 0: каркас

- [x] `Тили-тили/backend/`: Fastify 5 + TypeScript на Node 22, `docker-compose` с PostgreSQL 16 и Redis 7, `node-pg-migrate`, `Dockerfile`
- [x] Сервер знает все 103 пути контракта: нереализованные отвечают `501`, несуществующие — `404`
- [x] Схемы контракта подключены к валидатору Fastify: `ref('Wedding')` в обработчике, правка контракта меняет валидатор сама
- [x] Два генератора из `openapi.yaml` (пути, схемы) + типы через `openapi-typescript`; результат коммитится, расхождение ловится тестом сверки
- [x] Единый формат ошибки `{ error: { code, message } }`, для 422 — плюс `fields`; пагинация по курсору
- [x] `/health` (всегда 200) и `/health/ready` (503 без базы или Redis)
- [x] CI на оба пакета, `init.sh` прогоняет фронт и бэк
- [x] **Найдено при этом:** незакавыченная строка в контракте разрезалась YAML на два ключа — схема была валидным YAML и невалидной JSON Schema (ERR-0018)
- [x] Проверено на живом сервере: 200 / 503 / 501 / 404

## Сделано · 2026-09-02 — контракт v0.2 и план бэкенда

### контракт v0.2

Четыре решения владельца («сделай как лучше всего будет») вписаны в контракт, все документированные пропуски закрыты.

- [x] Слот без своего статуса: `Slot.deal` + производная `Slot.tileState`; схема `Deal` заведена
- [x] Деньги — объект `Money { amount, currency }` у каждой суммы, в MVP только `RUB`
- [x] Один персональный `guestToken` во всех гостевых путях (`/rsvp`, `/gifts`, `/join`)
- [x] Переноса данных с моков не будет — эндпоинт импорта не заводится
- [x] **Найдено при этом: пара могла открыть гостевую страницу по токену из списка гостей** и увидеть его резерв подарка — это ломает обещание §9 «пара НИКОГДА не видит, кто зарезервировал». Сырой токен убран, вместо него одноразовая ссылка `/i/{shareCode}`, обмен через `GET /invite/{shareCode}`, перевыпуск через `POST …/guests/{id}/invite-link`, таблица `guest_invite_codes`
- [x] Механические пропуски: `Chat.kind += day` и `openFrom`, `Wedding.tz`, поля гостя (`diet`, `dietNote`, `menuOptionId`, `transfer`, `busId`, `hotelId`), описание ролей в `Member`, фиксация 35 категорий как сида
- [x] 34 недостающих эндпоинта дописаны: профиль и сессии, рефералы, консьерж, загрузка файлов, сделки и документы, тайминг и альбом, анти-вишлист и фонды, день X и push, жалобы, верификация, админка
- [x] Контракт событий WebSocket записан во вводный раздел (OpenAPI 3.0 каналы не описывает)
- [x] Контракт: 69 → **103 пути**, 32 → **39 схем**, версия **0.2.0**, все `$ref` разрешаются, дублей нет
- [x] `BACKEND-PLAN.md` пересобран под v0.2: 103 пути разложены по 10 этапам, каждый ровно в одном; оценка 51 → **64 дня**; +4 таблицы (`referrals`, `concierge_requests`, `vendor_verifications`, `guest_invite_codes`) — всего 55, у всех PK
- [x] Раздел 8 переписан: был список пропусков, стал история решений + что осталось открытым
- [x] Бизнес-логика §3.3 и §22: убрано «слот движется по машине состояний» — движется сделка

## Сделано · 2026-09-02 — решения владельца

- [x] 1. Ветка влита в master
- [x] 4. Тёмный текст на градиенте вместо белого: 99 мест, плюс затемнены подложки кнопок отмены (ERR-0009 закрыт)
- [x] 7. Каталог доведён до 35 категорий плана ч. 8.1
- [x] 3. Согласие на ПДн: непредустановленный чекбокс на входе, вход без него недоступен, факт согласия с датой; экраны оферты и политики — тексты помечены черновиком под правку юриста
- [x] 5. Деньги в копейках: `lib/money.ts`, 56 литералов данных и ввод пользователя переведены; характеризующий тест поймал ошибку в сто раз на экране сделки
- [x] 6. Сделка — шесть состояний по Плану §8.1; степпер и Бизнес-логика §3.4 говорят одно и то же
- [x] 8. openapi: 48 → 69 путей, добавлены вишлист, свои подрядчики, логистика, опрос меню, отзывы гостей, согласие на ПДн; схемы `Money` и `DealState`; денежные поля помечены
- [x] 9. План ч. 12.1 приведён к фактическому стеку с объяснением каждого расхождения

Решение №2 (масштаб демо-данных): не трогаем.

## Сделано · 2026-09-02 — проход по всем экранам

Просмотр каждого экрана в браузере: мобильный вьюпорт и десктоп, светлая и тёмная тема.

- [x] **Счётчики гостей были выдуманы** — «8 в списке» против «42 придут»; главная читала вообще другой список (ERR-0015)
- [x] **Рассадка жила своим набором имён** — за столами сидели люди, которых нет среди гостей, отказавшийся занимал место, один человек был в двух местах сразу (ERR-0016)
- [x] Опрос меню и трансфер приведены к реальному списку (ERR-0017)
- [x] «Готово» на главной дублировало счётчик команды — теперь это прогресс чек-листа
- [x] Ещё 3 склейки вокруг вложенных тегов: «Безопасность:каждая», «Тиль:главное», «получите3 000 ₽на»
- [x] Новый сторож `typography.test.ts` — ловит склейки обоих видов, включая те, что мой первый детектор пропустил
- [x] Проверены: онбординг, квиз, вход, каталог, анкета подрядчика, команда, бюджет, чек-лист, тайминг, гости, рассадка, вишлист, логистика, меню, план Б, альбом, сделка, ассистент, день X, после свадьбы, приглашение, подарки, кабинет подрядчика, «Мы», чат

## Сделано · 2026-09-02 — проверка в живом браузере

Первый прогон приложения глазами, а не в jsdom. Playwright, мобильный вьюпорт 390×844 и десктоп 1280.

- [x] 48 роутов: ни одного горизонтального переполнения, ни одного пустого экрана, ноль ошибок и предупреждений в консоли
- [x] Тёмная тема и десктоп-раскладка (боковое меню, широкая сетка) проверены на скриншотах
- [x] **Найдено: три разных суммы «потрачено»** — 455 000 / 560 000 / 677 000 ₽ на трёх экранах, и команда `3/14` против `3 из 12`. Сведено к одному расчёту `lib/budget.ts` (ERR-0012)
- [x] **Найдено: 22 склейки** вида «80гостей», «из1 200 000 ₽», «код7F3K· одноразовый» (ERR-0013)
- [x] **Найдено: service worker кэшировал HTML под адресом манифеста** при заходе по прямой ссылке (ERR-0014)
- [x] Прод-сборка развёрнута в подпапке на живом сервере: прямая ссылка `/app-build/wedding/guests` открывает экран «Гости», манифест, иконка и `sw.js` отдают 200, воркер регистрируется со scope подпапки, в кэше ровно четыре файла оболочки
- [x] Свои статьи расхода в бюджете стали переживать перезагрузку (`tt_budget_custom`)

## Сделано · 2026-09-02 — доступность и словарь

- [x] Контраст текста: 5 токенов светлой темы приведены к 4.5:1 (ERR-0008)
- [x] 136 хардкод-цветов текста переведены на токены — теперь переключаются вместе с темой
- [x] 14 разовых цветов затемнены до нормы; `contrast.test.ts` сторожит оба слоя
- [x] Оверлеи стали диалогами: `role`, `aria-modal`, `aria-label`, закрытие по Escape (выбор города, шторка приглашения, разбор свадьбы)
- [x] Телефон получил `type="tel"`, поля поиска — `type="search"`
- [x] Словарь: убраны 22 повтора ключей (6 съедали чужой перевод), дописаны 11 пропусков (ERR-0011)
- [x] Найдено и исправлено: проверки CSS в тестах были холостыми — `?raw` на `.css` отдаёт пустую строку (ERR-0010)

## Сделано · 2026-09-02 — фронт доведён до продакшн-качества

Аудит нашёл девять дыр. Продуктовые пробелы (67 экранов плана против 48 роутов, админка) сюда не входят — это решения владельца, не полировка.

**A. Хостинг и PWA — приложение в подпапке наполовину мёртвое**
- [x] A1 `manifest.webmanifest`, `icon.svg`, `sw.js`, `start_url`, `scope` и app-shell в `sw.js` прописаны абсолютными путями от `/`, хотя сборка идёт с `base: './'`. В подпапке превью — 404 на манифест, иконку и service worker, PWA не ставится и офлайн не работает.
- [x] A2 `BrowserRouter` без `basename`: шим восстанавливает `/подпапка/home`, роутер такого пути не знает, уходит в `*` → `/home` и вылетает из подпапки.
- [x] A3 Шим в `index.html` вычисляет корень по списку сегментов роутов, в котором не хватает половины (`gifts`, `deal`, `dayx`, `after`, `assistant`, `compare`, `favorites`, `notes`, `tools`, `notifications`, `support`, `inspiration`, `venues`, `quiz`) и есть несуществующий `onboarding`. Список обязан быть полным и не разъезжаться — закрепить тестом.

**B. Тема**
- [x] B1 `@media (min-width:900px) and (prefers-color-scheme: dark) { color-scheme: dark }` в `index.css` — рецидив бага §16.1. На десктопе с тёмной системной темой приложение остаётся светлым, а системные контролы (инпуты, скроллбары) темнеют.
- [x] B2 `theme-color` в `index.html` зафиксирован светлым — в тёмной теме строка статуса остаётся кремовой.

**C. Производительность**
- [x] C1 Весь код одним чанком 782 КБ: гость, открывший приглашение, качает кабинет подрядчика, вишлист и логистику. Разнести по маршрутам.
- [x] C2 Шрифты подключены `@import` внутри CSS — браузер узнаёт о них только после загрузки и разбора всего бандла стилей.

**D. UI**
- [x] D1 Плитка забронированного слота показывает латинское `booked` вместо статуса — мимо `t()` и мимо смысла.
- [x] D2 Логистика: автобусы и отельные блоки удаляются до нуля, пустого состояния нет (R-04).

**E. Закрепление**
- [x] E Тесты на каждый пункт; клик-шторм и смоук научить ждать ленивые чанки, иначе они молча перестанут что-либо проверять.

## Сделано · 2026-09-02 — устойчивость фронта

- [x] Поднять окружение: pnpm вместо сломанного npm, `vitest.config.ts` + `src/test/setup.ts`
- [x] Слоты команды переживают перезагрузку (`tt_slots`, патч поверх `initialSlots`)
- [x] Настройки переживают перезагрузку (`tt_settings`: имя, 4 push-тумблера, тихие часы)
- [x] Прочитанные уведомления (`tt_notif_read`)
- [x] День X: задержка и план Б (`tt_dayx`)
- [x] Оценки команде на «После свадьбы» (`tt_after_stars`)
- [x] Переписка с Тилем (`tt_assistant`)
- [x] Ответ гостя на приглашении (`tt_guest_rsvp`)
- [x] Статусы слотов — русские ключи i18n, перевод при рендере
- [x] ErrorBoundary возвращает на корень приложения, а не на абсолютный `/`
- [x] Чистота рендера: `Date.now`, `Math.random`, компоненты внутри рендера
- [x] Регрессии: `src/lib/persist.test.tsx` (9 тестов), итого 129 зелёных
- [x] Обновлены Карта экранов, Карта кнопок, §17 Бизнес-логики
- [x] Харнесс: `CLAUDE.md`, `JOURNAL.md`, `ERRORS.md`, этот файл

## Сделано · 2026-09-02 — порядок в проекте

- [x] Восстановлены имена файлов и папки (ERR-0007) — `Read`/`Edit` снова работают
- [x] Лок-файлы: основной — `package-lock.json`, `pnpm-lock.yaml` производный (`pnpm import`)
- [x] `.claude-flow/` в `.gitignore`
- [x] Коммиты в ветке `fix/persist-and-render-purity` (3 шт., от `ecb1f2d`)
- [x] Репозиторий поднят в корень: документы, харнесс и код версионируются вместе

## Ждёт решения владельца

- [x] ~~**Масштаб демо-данных** (ERR-0017). Моки написаны для свадьбы на 80 гостей, список гостей — образец из восьми. Экраны, где число выводится из списка, уже приведены к нему; статические итоги («После свадьбы», статистика кабинета подрядчика) — нет. Решение одно на всё: расширить образец до 80 записей или привести статику к восьмерым. Исчезает само с приходом бэкенда.~~ — закрыто: моки убраны 2026-09-06 (`lib/data.ts` больше нет, все данные с сервера); подтверждено ревью 016 (F-RL6-12, R-267)

## Не начато

- [x] ~~**Бэкенд по `BACKEND-PLAN.md`** — 9 этапов, 51 день, все 69 путей контракта разложены. Хостинг: Timeweb Cloud, площадка в РФ. Старт возможен после четырёх решений владельца из раздела 8.1 плана (форма `Slot`, поле валюты, гостевой токен, перенос данных бета-тестировщиков)~~ — закрыто: 175/175 операций текущего контракта реализовано (`routing.test.ts`, «shadowed = []» зелёный); подтверждено ревью 016 (F-RL6-12, R-267)
- [ ] **Уведомление в Роскомнадзор** об обработке персональных данных — до первого реального пользователя. Идёт пакетом с офертой и политикой у юриста
- [x] ~~Админ-панель (5 экранов, План §19.10) — первая фича по циклу `Тили-тили_Спека_фичи.md`, бэкенд под неё готов~~ — закрыто 2026-09-07, фича 001; подтверждено ревью 016 (F-RL6-12, R-267)
- [ ] Платежи и эскроу — на них держится вся матрица защит §13.3

## Product improvements — отдельная ветка (2026-09-26)

- [x] 017-A принят: CI 36237703194 и browser 36237703208 успешны; main не изменён.
- [x] 017-B: реализованы уведомления назначения, один план напоминания, инвалидация, тихие часы и защита лимита. Проверки: `tasks/фичи/017-задачи/REPORT-B.md`.
- [ ] Зафиксировать удалённые gates 017-B в `REMOTE-B.md`; не считать другие workflows доказательством этой версии.
- [ ] 018: график платежей поверх существующих deals/payments (не начинать до принятого 017-B).
- [ ] Отдельно проверить конкурентное бронирование audit4 (локально один deadlock/500, повтор зелёный).
- [ ] Остальные этапы — `tasks/product-improvements-roadmap.md`; наличие списка не означает реализацию.
- [ ] Main не сливать без отдельного решения владельца.

## Изолированная экосистема 030 — локальное продолжение 2026-10-01

Источник требований: `tasks/фичи/030-экосистема-local/{spec,plan,tasks}.md`, реестр A01–A20/U01–U16. Это отдельная работа в `feature/ecosystem-audit-local-20260930` относительно baseline9628d0b, без remote; исходный каталог другой сессии не изменяется.

- [x] Проверены ограниченные основы push/режимов, 35 категорий, состав заказа/назначения, отдельные версии условий, staff domain и реальные ресурсы/API/UI. Подробности и пределы доказательств: JOURNAL.md, внешние gates leaf1.1–1.6.
- [x] Исправлены 5 падений первого frontend full; целевой повтор dictionary/audit41/persist/orders-EN: 71 passed (`C:/Тили-тили/.unlazy/ecosystem-audit-20260930/ui-full.log`).
- [ ] Повторный общий frontend/backend/types/lint/build/contract прогон на собственной PostgreSQL базе и Redis12. Прошедший целевой набор не означает прохождение полного.
- [ ] Реальные resource plan/условия/атомарное обязательство, все booking/manualcalendar/cancellation двери; индивидуальные ресурсы не являются бронью.
- [ ] Staff API/UI и адресные обязанности; incident routing/PlanB; per-event guests/diet/trips/rooms; fulfillment/settlement/last-event closure по исходному реестру.
- [ ] Review нового стабильного WP03 checkpoint другой сессии перед интеграцией; текущие незавершённые источники не копируются.
- [ ] Итоговая приёмка A/U, удаление временного browser fixture helper/HTML и отдельный локальный feature commit. Никаких push/merge/main/production.
- [ ] Внешние provider/device/retention/tariff/human pilot условия подтверждаются отдельными фактическими доказательствами; сейчас не закрыты.

## Local ecosystem030 — verified checkpoint 2026-10-01

Third `verify.mjs full full` ended exit1: frontend93 files/1467 tests and backend130 files/2295 tests all passed, no skips. Frontend types/lint/build and backend types passed. Only stopping backend lint error was no-console in our temporary browser fixture helper; this is NOT a whole init.sh pass. Evidence: C:/Тили-тили/.unlazy/ecosystem-audit-20260930/full-full-third-lint-failure.log, lines7-8,91-101.

The two temporary browser fixtures were removed from our clone after preserving them externally as browser-fixture-helper.mts and browser-fixture-page.html. Whole backend ESLint and tsc build then independently exited0. Source-manifest verify confirmed all772 captured file hashes still matched after fixture removal; preserved as checkpoint-full-third-source-manifest.json before further implementation. GATES:G2 remains pending one final whole init.sh exit0. No commit/push/main or original-checkout mutation.

Next required implementation is actual optional order resource plan, immutable private revision and safe public terms projection, followed by real booking commitments/legacy compatibility. Saving a plan must not claim reservation. Staff public duties, incident routing, Plan B and remaining broad A/U outcomes remain open. Local foundations are not all17WP or complete ecosystem.

## Local ecosystem030 — resource plan continuation 2026-10-01

Immutable360/361 and optional order resource plan are implemented in our isolated clone. Public terms schema2 binds the exact safe immutable plan; schema1 remains valid for orders without plans. Saving a plan explicitly reserves nothing and changes no paid balance, timeline, legacy busy date or capacity used. The initially applied360 was restored unchanged when a missing-schema/deferred-head improvement was identified; integrity was added as preserving forward361. Both were applied only to our fenced resource_plan test DB. No production migration.

Independent parent leaf1.7.1/2 review and reverify: static source check0 and61 actual PostgreSQL tests passed, with6 observed lock waits, actual deferred orphan COMMIT23514 and audit SQL rollback. Sources/hashes and bounded evidence are recorded in the leaf ledgers; their exact leases released. Historical-author deletion in those tests uses a synthetic transfer fixture and does not verify current-owner eraseUser.

Registered API14 passed after a real cached-owner privacy defect was fixed (ERRORS LOCAL-030-12). Before-fix200 private replay is preserved in resource-plan-api-before-owner-replay-fix.log; current scoped owner verification now occurs before cache lookup. Current owner positive replay/no-op and exact distinct synthetic party schema2 acceptance passed. This is not human acceptance or a production transfer workflow.

Parent optional editor64 passed; integration3 files149=83 terms+64 editor+2 dictionary passed (ui-plan_integrated.log, node-1.7:G3). Frontend full project tsc -b exited0 after source freeze. The first schema2 test run failed18 assertions because malformed projections remove the accept control rather than disable it; corrected tests assert no control/no POST, not weaker validation. Archive ui-terms_schema2-first-assertion-failure.log. An earlier in-flight UI parse error was resolved before this source freeze. Final UI still awaits actual browser RU/EN320/390/480 acceptance and leaf1.7.3 lease remains active.

OpenAPI0.66.0 local generation measured179paths/233operations/139schemas. The historical772-file manifest describes the earlier355 checkpoint; it is not current stage1.7 acceptance. Migration drill extension is under reviewed agent execution on first-absent exact fresh10–12 only, retaining earlier8/9 evidence. Its success is pending at this entry. No final full init.sh exit0, final feature commit, push/main or whole17-feature/ecosystem completion claim. Booking commitments and broader staff/incidents/PlanB/logistics/settlement/lifecycle still required.
## Local ecosystem030 — resource-plan checkpoint, 2026-10-01

Current isolated clone whole init exit0: frontend94files/1555tests, backend132files/2370tests; no skipped tests; both projects types/lint/build passed. Source-manifest verify matched all780 captured local files after the run. Evidence: C:/Тили-тили/.unlazy/ecosystem-audit-20260930/checkpoint-resource-plan-full-passed.log and checkpoint-resource-plan-full-source-manifest.json. This supersedes the prior partial init failure only for this reviewed snapshot; future changes need fresh checks.

Retained shared PG now loopback15432 (same data directory, no deletion/rebuild); shutdown cause unconfirmed. Exact own resource_plan/full/browser databases remain fenced, Redis12 empty. Parent domain61 and API14 rerun on15432; editor64 and integrated149 rerun after final EN recorded-in-commitments/timezone-list polish. Source hashes/actual receipt and browser limitations: C:/Тили-тили/.unlazy/ecosystem-audit-20260930/resource-plan-browser-acceptance.md.

Actual synthetic browser: distinct vendor then couple accepted terms2/schema2. Manufacture June13 and delivery June14 remained distinct; buffers10/15/20/25 show occupied09:30–12:40 Moscow. Invalid qty0 retained input/showed error; restored5 saved as no-op. Independent actual SQL confirms plan1/terms2/order4/two distinct user-session receipts, capacityused0 and business snapshot unchanged. RU/EN vendor and pair320/390/480 no horizontal overflow; all12 screenshots visually inspected. Synthetic Chromium only; no physical-device, provider, human or legal acceptance claim. Own8091/8092 stopped, temporary helper/credential page removed from clone after external preservation; sharedPG remains running.

Parent fresh migration drill11 actual G1 subprocess exit0:68SQL/11CLI controls and actual current-owner eraseUser/history preservation, frozen script6f6b20e3; leaf1.4.2 accepted/released. Raw migration_drill-migration_drill11.log. Historical drill10 raw numeric exit unavailable after runtime reinit; not invented. Leaf1.7.3 final browser/source reviewed and released; stage1.7 plan only verified. No final commit/push/main/production or source transfer to the other session.

Next: actual allocation ledger and common booking/cancellation/erasure/capacity doors, explicit finite legacy reconciliation. A saved/agreed resource plan still reserves nothing. Staff public duties, incidents/routing, PlanB, fulfilment/logistics, settlement/lifecycle and broader A/U outcomes remain open. No claim complete ecosystem or all17WP.

## Экосистема030 — граница остановки 2026-10-01

Текущий этап atomic legacy replacement и принятые основы завершаются отдельно. Продолжение всей экосистемы: tasks/фичи/030-экосистема-local/CLAUDE-CONTINUE.md. Невыполненные критерии030 остаются открытыми;370+ пока только дизайн. Последняя инструкция владельца разрешила проверенную публикацию/main и требует остановиться после этого этапа; production вне поручения.

## 2026-10-02 · Scoped presentation fixes (separate branch)

- [x] Implement the five independent presentation groups: responsive sidebar, fixed pickers, picker focus lifecycle, date selection semantics, localized icon actions.
- [x] Targeted frontend verification: 104/104 tests, TypeScript, lint and production build.
- [ ] Next step: review the single-commit draft PR; perform supported-browser visual/keyboard/screen-reader QA before claiming rendered-UI verification. See `tasks/presentation-accessibility-20261002.md`. No automatic main merge.


### Закрытие поставки030 · Codex, 2026-10-03

- [x] Проверить продолжение Клода: PR27/31 merged, актуальный main4f6381d; независимое ревью фиксов.
- [x] Повторить full2105/3067 и браузерную замену409/200, сохранение оплаты/истории/чужих дат; RU/EN320/390/480.
- [x] Сохранить полную переносимую инструкцию: [REPORT-CLOSE](фичи/030-экосистема-local/REPORT-CLOSE-20261003.md), [Claude](фичи/030-экосистема-local/CLAUDE-CONTINUE.md), [контракт380](фичи/030-экосистема-local/c380-inventory-contract.md).
- Итоговые документы публикуются отдельным PR после проверок; подтверждение CI/merge — в PR и финальном отчёте. Затем эта сессия останавливается.
- [ ] Будущее отдельное поручение: принять черновик380, завершить legacy-source.ts, репетицию миграций и независимое ревью. Remote6a0e6a3 новее localbde3e40; не перезаписывать. Широкие A/U/WP не отмечать выполненными.

## 2026-10-03 · Принят runtime atomic Plan B и nginx

Actual nginx PWA run 80f6aab9-4646-406a-b5f6-c7564ee2c86b / session50489: exit0, result/overall passed,9checks,10consumed capture waits. Две реальные сессии сохранили6IDs/done/title после reload; monthly checklist исключил Plan B; финальный SQL набор тот же. Page/console/HTTP/capture errors=[], raw6=proved expected6+unexpected0;3отмены имеют measured asset-alias proof, остальные exactURL proof. Parent независимо проверил route/build/document/finish witnesses. Source/build/nginx before/after совпали, fixture cleanup users/sessions/consents/tasks/weddings=0. Root просмотрел6PNG RU/EN320/390/480, documentWidth=viewport; горизонтальное clipping не обнаружено. Server task titles остаются RU в EN, fixed navigation на viewport позиции full-page PNG; полный перевод задач/physical devices/human pilot этим сценарием не заявлены.

Full5268/681-file f920...25423a1 повторно сверён после browser8; native52 baseline/candidate probes приняли E7 nginx. Источники и seven failed runs: [Plan B report](фичи/030-экосистема-local/REPORT-PLANB-ATOMIC-20261003.md), [nginx report](фичи/030-экосистема-local/REPORT-DEEP-LINK-ASSETS-20261003.md), ERR-0437–0443. Nginx отдельно опубликован в [PR37](https://github.com/bairasbai/tili-tili/pull/37), head affde66, exact7CI SUCCESS, actual merge efb4f7e5c89cdb1a1ec4626eefe5e826d8b404fd получен fetch; A13 отдельные commit/CI/main ещё pending. T023/A12/fullWP10/остальные WP и pending owner inputs сохраняются; goal active.


## 2026-10-03 · A13 фактически поставлен, продолжается T023

A13: [PR38](https://github.com/bairasbai/tili-tili/pull/38), feature644fe299606147c05449c31173b26702ab6cf7db; все7 CI COMPLETED/SUCCESS сохранены в pr38-ci3.json. Connector подтвердил merged=true/main SHA0b099f0394cf25298fc239bcf03fc442c745fd53; root получил этот main через fetch/ff-only, ancestry644fe299 и прежние681 hashes проверены. Предыдущие pending checkpoints сохранены как хронология и этим результатом заменены для статуса A13. Источники: PR38 и C:/Тили-тили/.unlazy/codex-planb-20261003/pr38-ci3.json, pr38-merged.json, A13-STAGED-EVIDENCE.json.

T023 выполняется в отдельной ветке codex/wp10-planb-system-keys. Actual prior381 oldred:18failed/51filtered;10 DML реально приняты и изменили снимки,7 storage cases наблюдали42NULL keys. Одна ошибка ожидания не засчитана как semantic defect. Native primary up382 прошёл с сохранением OID581016 и всех81 старых journal rows. Первый unfiltered69:68passed/1failed; direct-blocker predicate не распознал фактическую цепь second→first→holder. Оригинальные oracle/source/logs сохранены, минимальная поправка теста проходит независимый разбор.

Native17 first run f4bfab9b-3fb7-4a46-a651-468b7679cfb6 failed на stage5: projection старой схемы включила3 metadata columns нового index. Первые4 gates выполнены, включая actual42723/whole rollback. Это не полный native acceptance. Оба созданных drill targets и все snapshots сохранены; cleanupErrors=[], ownedchildren0, fixture cleanup0 после этого раннего отказа не заявляется. Нужен исправленный reviewed runner на двух новых absent-only targets, full69/A13/full/PWA/review/featureCI/main. Подробности: REPORT-PLANB-SYSTEM-KEYS-20261003.md.

Полностью подтверждённых WP00–WP16 остаётся0/17; закрытие A13 не закрывает WP10. A12 и все прочие FR/SC/NFR/A/U, M01/WP11/provider/device/human inputs сохраняются. Goal active. Пользователь разрешил публикацию A13 и следующих проверенных фич WP00–WP16; production разрешения нет. По новому указанию создан thread heartbeat30 с отчётом каждые30мин: сделано/осталось/текущий этап/подтверждённое число полных WP.

## 2026-10-03 13:34 UTC · T023: локальные gates пройдены, CI extension pending

T023 на A13 main0b099f0394cf25298fc239bcf03fc442c745fd53 прошёл focus97, full5337 (2105 frontend +3232 backend), оба types/lint/build, native17 run56de1a33-cc31-45ec-8ae2-cb89b0cedda7 и PWA9 run18fe0dec-b4e2-4e08-96f5-acfc7d8a2cc2. Все683 raw source hashes до/после остались54dc5b374627bcc4f214c9c6cf56d9727b24938a40bc0e7f7979682daa650090. Подробные actual results, ограничения и сохранённые failed runs: [T023 report](/C:/Тили-тили/tili-orchestrate-publish-20261003/tasks/фичи/030-экосистема-local/REPORT-PLANB-SYSTEM-KEYS-20261003.md).

Публикация ещё pending. Mandatory public CI migration drill допускает только381 и source-preflight отказывает на382; он требует отдельного reviewed extension с сохранением прежних recovery/SQL/down guards и actual нового native запуска. Actual GitHub CI этой фичи ещё не запускался. Полностью подтверждённых WP00–WP16 остаётся0/17, цель active; A12/прочие требования и M01/WP11/provider/device/human inputs сохраняются. Подготовка A12 schema обнаружила source gap transport FK deletion/rebind; исправление допуска схемы выполняется до DDL. Источники: T023 report и его exact artifact links, [A12 schema review](/C:/Тили-тили/.unlazy/codex-planb-20261003/A12-SCHEMA-API-ADMISSION-REVIEW.md).

## 2026-10-03 14:08 UTC · T023 public CI migration drill пройден локально

Root принял independently reviewed public harness D86175…3BF2 и выполнил его полный native drill на новой exact drill21 базе: exit0/ECOSYSTEM_MIGRATION_DRILL_PASSED/TZ_DRILL_PASSED. Все25 own migrations through382,18 новых named SQL refusals, все19 прежних+2 новых CLI guards=21, actual holder18892/waiter18592/23514 и whole preservation подтверждены raw log. Source binding показывает только1/683 changed file (CI harness), остальные682 exact full5337/focus97/private17/PWA9 inputs неизменны; current digestc53243393d9d4c05263b269eead97baf79002ca118177bfdeaa56a34b429c3d0. Syntax/ESLint нового live script также прошли. Источники и ограничения: [T023 report](/C:/Тили-тили/tili-orchestrate-publish-20261003/tasks/фичи/030-экосистема-local/REPORT-PLANB-SYSTEM-KEYS-20261003.md), [actual native](/C:/Тили-тили/.unlazy/tz-full-20261002/logs/drill-t023-ci-drill-v1.log), [source binding](/C:/Тили-тили/.unlazy/codex-planb-20261003/t023-ci-native-source-binding-1.json).

Commit/push/PR/GitHub CI/main пока pending. Fresh final integrated source review выполняется. A12 V2 transport design source-reviewed, original R01 устранён только на уровне проекта; root technical decisions не заменяют implementation/native/UI или M01 owner inputs. Full WP0/17, цель active; все WP/FR/SC/NFR/A/U и необходимые owner/provider/device/human gates сохранены.

## 2026-10-03 14:50 UTC · T023 фактически поставлен; продолжается A12

[T023 PR39](https://github.com/bairasbai/tili-tili/pull/39) опубликован с head4e3223ca2889a9a2f67fa551489a8cb63b75c198. Однократный actual gh snapshot подтвердил все7 COMPLETED/SUCCESS: два frontend, два backend, offers-browser, payment-browser и task-browser. Последняя backend проверка завершена14:39:39UTC. Источник: [CI snapshot](/C:/Тили-тили/.unlazy/codex-planb-20261003/pr39-ci.json); точное время запроса не записано, он сделан после clock14:44:44UTC. Затем connector подтвердил ready и merged=true, sha03f41a0f12bbd369450501fb30e2381972b15b0c; [merge receipt](/C:/Тили-тили/.unlazy/codex-planb-20261003/pr39-merged.json). Root fetch/ff-only получил этот origin/main, ancestry feature→main и clean checkout подтверждены. Все683 current source hashes после merge совпали с принятым source binding c53243393d9d4c05263b269eead97baf79002ca118177bfdeaa56a34b429c3d0; это проверка неизменности, новый полный runtime не заявляется.

T023/A13 принят в указанной технической границе; [полный отчёт](/C:/Тили-тили/tili-orchestrate-publish-20261003/tasks/фичи/030-экосистема-local/REPORT-PLANB-SYSTEM-KEYS-20261003.md) сохраняет failures и ограничения. Запись PR в приложении была запрошена, но tool не вернул результат при двух попытках; app attachment не подтверждено, GitHub merge подтверждён отдельно. Никакая production поставка этим не подтверждается.

Следующая ветка codex/wp10-planb-delivery-scope начата от actualmain03f41a0. A12 остаётся обязательным: immutable original attempts/live transport fences, полный C01–C08 source graph, receipt-after-wait authorization, recipient union и согласованный notice/quota lock order. Текущие C04 выводы являются source-only; actual RED/GREEN ещё UNRUN. M01/WP11/provider/device/human inputs и все прочие WP/FR/SC/NFR/A/U сохраняются. Полностью подтверждено0/17 WP; goal active. Thread heartbeat30 ACTIVE, отчёт каждые30мин; проверен persisted automation.toml, последний manual отчёт14:45UTC.


## 2026-10-03T16:15:43.923Z · A12 profile · actual RED9/controls4 → GREEN13

Root включил ровно два route-файла и helper после fresh source/test review и actual baseline9failed+4passed. Тот же frozen D624 test прошёл13/13 на настоящих registered HTTP/PG; две SQLSTATE22012 в одном tx client откатывают весь профиль, четыре authority-after-wait отказа и настоящий JWT expiry не оставляют изменений, mixed projection устранена и default initializer ждёт parent mutex. Подтверждены8 actual blocker pairs. Own mutable fixtures6категорий0;3 собственных auth.login audits сохранены неизменёнными, не заявляется audit0. Источник: [полный отчёт](/C:/Тили-тили/tili-orchestrate-publish-20261003/tasks/фичи/030-экосистема-local/REPORT-PROFILE-PREFS-ATOMIC-20261003.md), [qualified GREEN](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-profile-green-1-qualified.json), rawlogSHA F14501ED57A3706F426E957451FB776D5434DEEB4ACC4CC8315E13C2C9E463AD.

Full5350=предыдущие5337+новые13 — ожидаемое число, не подтверждённый результат; live root session30825 ещё ожидается. Source fence685 actual digest4b983040762d23272d188d0ce4c6091ce989d056f68fc7479779cc8a5260339c. Два creator-order supplement и реальный settings browser ещё не выполнены; отдельные source/CPU preparations не являются runtime acceptance. Исправление ещё не опубликовано; T023 ранее merged черезPR39/main03f41a0. Full A12/C04/M01, все17WP и owner/provider/device/human gates сохранены; подтверждено0/17, цель active.


## 2026-10-03T16:38:49.514Z · A12 profile · full5350 и оба creator orders подтверждены

Root получил exit0/TZ_FULL_PASSED:5350=2105frontend+3245backend,112+149files,обаtypes/wholelint/build. Exact685 source fence до/после4b9830…60339c. Затем separate frozen creator-order suite92ADF3…2DA57/freshreviewC6C3E8…C4731 добавлена с одной serial регистрацией59→60; остальные684 full inputs, включая всё приложение/миграции/прежние13 тестов, unchanged. Primary actual8=2order cases+6static audit53; exactFULLtarget actual2/2, оба реальных порядка с direct holderPID/blocker/user lock и целой старой проекцией доcommit. В каждом прогоне six ownmutable counts0/two original own immutable audit facts retained. Whole backend lint после добавления suite exit0; итоговые686 source inputs16e1b0…fac23f. Это full5350 плюс отдельно проверенный supplement, отдельный full5352 не заявляется. Источник: [profile report](/C:/Тили-тили/tili-orchestrate-publish-20261003/tasks/фичи/030-экосистема-local/REPORT-PROFILE-PREFS-ATOMIC-20261003.md), [qualified full/orders](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-profile-full-orders-qualified.json).

Browser target создан только после actualabsence:OID620849/PG16.15/codex_test/127.0.0.1:15432,82native migrations382,initialsixprofilecategories0/othersessions[]. Browser runner source authoring/review ещё pending; никакие UI/capture результаты не подтверждены. Исправление профиля ещё не опубликовано; PR39/T023 ранееmain03f41a0. FullA12/C04/M01/все17WP и owner/provider/device/human gates сохранены;0/17fullyaccepted,goalactive. Последний плановый отчёт16:15UTC;next16:45UTC.


## 2026-10-03T16:57:39.091Z · A12 profile · браузер V2: actual startup failure сохранён

Плановый отчёт фактически отправлен16:48UTC/19:48МСК (после срока16:45); fullyacceptedWP00–WP16 по-прежнему0/17. Full5350=2105frontend+3245backend и separate оба creator orders подтверждены предыдущими receipts. Следующий плановый отчёт17:15UTC/20:15МСК.

Root прочитал полный V2 adapter/common/hooks/server/runner/Python,54 binding tuples/one observer injection, actual existing Python ast.parse exit0 (toolchunk95bf3f), snapshot713 inputs, включая все неизменённые686 final full inputs. [Source admission](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-profile-browser-v2-root-review.json). Actual runner запущен на guarded OID620849: frontend build/nginx syntax/source guards прошли, API остановился до fixtures/browser с “Configure private observer before app construction”, стек private fault-hooks.js. [Raw API](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-profile-browser-v2/browser-b107ae3d-ed09-4014-91a1-b2a795a61bc8/api.log), [overall](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-profile-browser-v2/browser-b107ae3d-ed09-4014-91a1-b2a795a61bc8/overall.json). Дублирование ESM/CJS module instance — интерпретация прочитанного configure-before-build кода и stack, не отдельное измерение module identity. Исправление границы private loader ещё pending. Нельзя подтвердить UI/layout/fault runtime. Все failed bytes сохраняются, live product не изменён. Parent/child cleanup подтверждает six ownmutable categories0/audit[]; [cleanup](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-profile-browser-v2/browser-b107ae3d-ed09-4014-91a1-b2a795a61bc8/cleanup.json). Public profile CI/PR/main и полный A12/C04/WP ещё pending.


## 2026-10-03T17:23:50.296Z · A12 profile · отчёт20:15МСК и actual V3 gate failure

Root отправил плановый отчёт17:15UTC/20:15МСК; fullyaccepted0/17, next17:45UTC/20:45МСК. Full5350=2105+3245 и два separate creator-order прогона подтверждены. Новый независимый final product/test review6401C1…CE6EF не нашёл materialbounded blocker и сверил686 actualinputs/13GREEN/дваorders/immutableaudit; [review](/C:/Тили-тили/.unlazy/codex-planb-20261003/A12-PROFILE-FINAL-SOURCE-REVIEW.md).

V3 root source admission после полного чтения common/hooks/server/runner и exactadapter-to-reviewed-V2 inverse:713inputs содержат все unchanged686; package+MTS explicitESM, bounded installedtsx hook-identity probe passed. Actual API построился, configure/hooks/wrapper ledger имеет один ID/URL. [Rootreview](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-profile-browser-v3-root-review.json). Actual V3 child functional_status=passed,30 consumed captures,6PNGs/12layout records/two22012 fault records; но overall/status FAILED из-за3 unproved ERR_ABORTED. Root не принимал эти PNGs визуально и не принимал весь browsergate. [Rawresult](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-profile-browser-v3/browser-200a59e6-be24-4820-b535-dc3e2d2784df/result.json), [overall](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-profile-browser-v3/browser-200a59e6-be24-4820-b535-dc3e2d2784df/overall.json).

Root прочитал request354 navigation start1791047668.5687494; GET355/356/357 start.5758915/.576902/.5774114 и failures.5779972/.5785222; actualrootCommit354.5790436; replacements367/368/369 real200finished послеcommit. Request observer назначает pending generation по navigation REQUEST преждеcommit; трактовка отмен как следствия смены документа остаётся интерпретацией, а не принятой exemption. NEWV4 должен сохранять actual committed-document witness и parent recomputation строгих bounds/exactreplacement; frozenV2/V3/rawfailures неизменны. Native child/parent owncleanup sixmutable0/audit[] подтверждён. Public profile PR/CI/main и полныйA12/C04/WPpending.

СледующийC04/C05 privatebackend заморожен:24TS=21existing modifications+3helpers,12owners/6receiptfinalizers; авторCPUtypes0/lint24zero/inverse21, runtimeUNRUN. Independenttest30 sourcefrozen310CFC…8A9B, CPU0/0; полныйV01–20/C01–08 coverage ещёstaged, no fullclosure. Новая privateUI recoveryV1 root прошла виртуальныеfrontendtypes288/3lintzero, но freshreview нашёл cross-principal old204→newBsubscription unsubscribe countervector; V1не включён вlive. NEWV2 с actualprincipal/endpoint fence authoringpending, independentJSseamtests в работе. Источники: [C04candidate](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c04-candidate-v1/HANDOFF.md), [independenttests](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c04-independent-v1/HANDOFF.md), [privateUIV1](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c05-push-ui-v1/HANDOFF.md).


## 2026-10-03T17:45:14.354Z · Плановый отчёт20:45МСК · полных WP0/17

Подтверждённое завершение полных WP00–WP16: **0/17**; цель active. С прошлого отчёта root квалифицировал две реальные same-client SQLSTATE22012/HTTP500 rollback записи V3 — UI и compound с изменениями user+prefs — и отсутствие других сессий после завершения. Прогон всё ещё **FAILED**: три ERR_ABORTED не получили принятого объяснения;6PNG не приняты визуально. [Ограниченная квалификация](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-profile-browser-v3-limited-qualified-root-1.json) сохраняет raw hashes, источник и пределы вывода. Новая V4 instrumentation в подготовке; public profile PR/CI/main ещё ожидаются. Ранее full5350 и отдельные два creator orders не изменены; [profile report](/C:/Тили-тили/tili-orchestrate-publish-20261003/tasks/фичи/030-экосистема-local/REPORT-PROFILE-PREFS-ATOMIC-20261003.md).

Следующий C04/C05 backend пока private/UNRUN. Root сверил47 manifest artifacts,49 current backend sources,8 additional peer bindings и3 profile dependencies: [freeze verification](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c04-freeze-verify-root-1.json). Read-only PG preflight17:37:42UTC подтвердил OID616406/82 exact migrations382, отсутствие других сессий и собственных barrier catalog objects/locks на тот момент; [preflight](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c04-barrier-readonly-preflight-root-1.json). Это не DDL controls, namespace reservation или HTTP/runtime acceptance. Private push UI V1 отклонён независимым source review из-за oldA204→unsubscribeB; исправление V2 и независимые UI seam tests ещё в подготовке. [Review](/C:/Тили-тили/.unlazy/codex-planb-20261003/A12-C05-PUSH-UI-SOURCE-REVIEW.md).

Остаются browser acceptance и поставка атомарного профиля, полный C04/C05/остальной A12 и все исходные WP/FR/SC/NFR/A/U. M01/WP11/provider/device/human gates сохранены. Thread heartbeat30 ACTIVE; следующий плановый отчёт18:15UTC/21:15МСК.


## 2026-10-03T18:15:05.963Z · Плановый отчёт21:15МСК · полных WP0/17

Подтверждённое полное завершение WP00–WP16: **0/17**. Число пакетов:16−0+1=17; отдельные уже доставленные исправления не закрывают полные пакеты исходного реестра. Цель active.

За прошедшие30минут root выполнил новый настоящий браузерный V4:30 функциональных captures,12 layout records и две same-client SQLSTATE22012/HTTP500 rollback проверки прошли; все6 RU/EN320/390/480 PNG просмотрены. Общий gate **FAILED**:10 неквалифицированных ERR_ABORTED и3 ошибки Chromium Network.getResponseBody сохранены. Источник/build до и после совпали; собственные6 категорий mutable fixtures очищены, других сессий PG не осталось. [Ограниченная квалификация](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-profile-browser-v4-limited-qualified-root-1.json). Новая V5 проверка observer classification готовится с обязательной исходной хронологией и точным успешным replacement; FAILED V4 не переписывается. Profile публикация/CI/main ещё ожидаются.

Свежий независимый source review C04/C05 подтвердил R01:RETURNING в SELECT и R02:параметр finalIds не связан с UPDATE. V1 не принят; исправленный private V2 ещё требует финальной фиксации, свежей проверки и actual SQL/runtime. Отдельный H01 касается неверного расписания DELETE-race теста; новый independent V2 сохраняет обязательный409/whole-rollback oracle. [Review](/C:/Тили-тили/.unlazy/codex-planb-20261003/C04-C05-BACKEND-CANDIDATE-REVIEW.md). Private UI V2 и22 независимых React/API-client сценария подготовлены; в четырёх logout controls добавляется проверка завершения browser unsubscribe до каждого server request. Их runtime ещё UNRUN.

Остаются принятие browser gate и поставка атомарного профиля, реальные C04/C05/пуш UI RED–GREEN и весь первоначальный WP/FR/SC/NFR/A/U объём. M01/WP11/provider/device/human gates сохранены. Следующий плановый отчёт18:45UTC/21:45МСК.


## 2026-10-03T18:27:32.048Z · A12 profile · local acceptance готова к отдельной публикации

Три product-файла, два независимых test suites и serial registry сохранены в точных проверенных bytes. Fresh final source review не нашёл material bounded blocker: [review](/C:/Тили-тили/.unlazy/codex-planb-20261003/A12-PROFILE-FINAL-SOURCE-REVIEW.md). Actual PG/HTTP RED13=9failed+4passed → GREEN13passed; actual оба creator orders прошли отдельно на primary и штатном FULL target. Последний штатный full5350=2105frontend+3245backend/types/lint/build относится к685 inputs до supplement; два supplement cases проверены отдельно, все686 final inputs сохранены. Новый full5352 этим не заявляется.

Root принял actual browser V5 run892dcec9-a9d4-4f20-a121-2fc8d4cf7c23: child/parent passed,30consumed captures,12layout records,6 RU/EN320/390/480 PNG просмотрены. Два genuine same-client SQLSTATE22012/HTTP500 — UI и compound user+prefs — дали whole rollback. Все9 raw navigation cancellations и3 raw response.body protocol disposals получили independently recomputed exact chronology/replacement proof; unexpected errors0. Raw failures сохраняются. OID620849/own sixmutable cleanup0/audit[]/othersessions[]; source/build до/после/current равны. [Квалификация](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-profile-browser-v5-qualified-root-1.json). V2/V3/V4 failed runs не изменены. Физические устройства/provider этим не проверены.

Подготовлена только отдельная публикация atomic profile/default-prefs. OTP consumption, user restore/audit и выдача сессии не включены в эту короткую auth-default транзакцию; whole-login atomicity не утверждается. Публичный feature commit/push/PR/CI/main ещё pending. Ни этот prerequisite, ни прошлые A13/T023 не закрывают полный A12/WP10; fully accepted WP00–WP16 остаётся0/17. Private C04/C05 и UI candidates не включены вlive. Последний плановый отчёт18:15UTC/21:15МСК; следующий18:45UTC/21:45МСК.


## 2026-10-03T18:53:08.264Z · Плановый отчёт21:45МСК · фактический отчёт после21:49 · полных WP0/17

Полностью приняты **0/17 WP00–WP16**;17=16−0+1. Отдельные поставленные исправления не удостоверяют полный WP. Плановый отчёт21:45 задержался; фактический пользовательский отчёт отправлен21:49. Следующий плановый отчёт19:15UTC/22:15МСК. Цель active.

Атомарное сохранение профиля поставлено через [PR40](https://github.com/bairasbai/tili-tili/pull/40):feature a70364ae5650d7888ad7dc2c98f23488640d6d86, все7CI COMPLETED/SUCCESS, merge/main629c39bcde7c78542ab04f81465df925da645d50. Root получил main и fast-forward локальной копии, проверил ancestry и сохранность всех686 входных файлов. [CI snapshot](/C:/Тили-тили/.unlazy/codex-planb-20261003/pr40-ci4.json), [merge result](/C:/Тили-тили/.unlazy/codex-planb-20261003/pr40-merge-root.json). Попытка attach PR ранее завершена ожиданием без подтверждения; наличие app attachment не подтверждено.

Браузер V5 реально принят:30 captures/12 layout/6 просмотренных PNG/2 genuine SQL rollback;9 cancellations и3 response-body disposals имеют independently recomputed exact proof, unexpected0. Предыдущие FAILED V3/V4 сохранены. [Квалификация](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-profile-browser-v5-qualified-root-1.json). Full5350 был пройден до двух дополнительных creator-order tests; эти2 прошли отдельно. Это не запись full5352.

UI: те же22 frozen теста дали baseline16FAILED+6PASS и actual virtual-source GREEN22/22 с загрузкой ровно4reviewed candidate modules; live product UI не включён. HTTP/browser adapters синтетические; physical browser/provider/server409 этим не проверены. [RED](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c05-ui-red-v2-root-1/qualified-root-1.json), [GREEN](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c05-ui-green-v3-root-1/qualified-root-1.json).

C04/C05: actual read-only PG controls в OID616406 воспроизвели V1SQL ошибки42601/08P01; обе V2SQL формы прошли EXPLAIN без ANALYZE. Это подтверждает grammar/binding, не runtime finalization. Fresh source review backendV2/UIV3/testV2 завершён; native30 и worker-regressions ещё UNRUN. [SQL controls](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c04-final-sql-controls-root-1.json).

Остаются actual conditional receipt-barrier admission,30native конкурентных C04проверок, worker final-batch regression, интеграция frontend/backend с full/build/browser и отдельной публикацией; затем весь первоначальный WP/FR/SC/NFR/A/U объём. M01/WP11/provider/device/human gates сохраняются; я не могу подтвердить их закрытие.


## 2026-10-03T19:16:01.963Z · Плановый отчёт22:15МСК · полных WP0/17

Полностью приняты **0/17 WP00–WP16**;17=16−0+1. Отдельное исправление профиля уже поставлено, но полный WP не закрыт. Цель active; следующий отчёт19:45UTC/22:45МСК.

За период объединён [PR40](https://github.com/bairasbai/tili-tili/pull/40):7/7CI SUCCESS, main629c39bcde7c78542ab04f81465df925da645d50. Root получил main/fast-forward, ancestry и все686 входных файлов проверены. [Postmerge](/C:/Тили-тили/.unlazy/codex-planb-20261003/pr40-postmerge-report-root-1.json). Profile browserV5 уже принят30captures/6PNG/2realSQLrollback; full5350+2separate supplementary tests остаются раздельными доказательствами. UI22actual virtual-sourceGREEN ранее принят, live UI ещё не включён.

Подготовлены exact30native C04 baseline и exactcandidate24модуля/3newhelpers для следующегоGREEN. Свежая source-проверка отказала root-2config за неправильный string literal; приложение/БД до исправления не запускались. NEWroot-3использует отдельно проверенный staticloader; source/CPUcontrols пройдены, actualmoduleload/native ещё не удостоверены. [Root-2review](/C:/Тили-тили/.unlazy/codex-planb-20261003/A12-C04-NATIVE-RUNNER-BARRIER-SOURCE-REVIEW.md), [Root-3CPU](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c04-green-root3-reviewer-cpu.json).

Conditional receipt-barrier prepared/frozen; перед root-native use требуется завершённый свежий независимый source review; current completed native control status: **UNRUN**. C04 baseline completed result: **UNRUN or currently active; no completed result recorded**. Отсутствие finished artifact не означает semanticRED/PASS. [Barrierhandoff](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c04-barrier-control-v1/HANDOFF.md). Worker19regressions frozen source/noEmit/lintpassed, actualUNRUN; покрывают prepared N1/N2/laterpass/empty/revoked/mixedexpiry/409source/genuine22012wholefinalbatchrollback. [Workerhandoff](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c05-worker-independent-v1/HANDOFF.md). Это post-fixregression, не TDD baselineRED.

Остаются actualnative barrier/30baseline→candidateGREEN/19worker, интеграция frontend+backend с требуемыми сценариями/full/build/browser, portableisolatedCI и отдельная публикация, затем первоначальный WP/FR/SC/NFR/A/U объём. Не могу подтвердить закрытие provider/device/M01/WP11/human gates.


## 2026-10-03T19:49:42.725Z · Плановый отчёт22:45МСК · native30/19приняты · полныхWP0/17

Полностью принято **0/17 WP00–WP16**;17=16−0+1. Отчёт пользователю отправлен22:47МСК, следующий23:15МСК/20:15UTC; цель active. [PR40](https://github.com/bairasbai/tili-tili/pull/40) объединён с main629c39bcde7c78542ab04f81465df925da645d50 после7/7CI SUCCESS.

Настоящий PG C04: independent exact30 baseline18semanticfail/12controlsPASS → exactsame30candidatePASS;24actualcandidate modules;7directnativewaits/4genuineSQL22012wholeactionrollbacks/2expiry-crossedJWT/3named409/12batchowners. [Qualified30](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c04-native-green-v2-root-3/qualified-root-1.json). Post-fix worker19regressions actual19PASS;5loadedmodules/2nativewaits/source409/postupdate22012rollback/providerguard0. [Qualified19](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c05-worker-native-v1-root-1/qualified-root-1.json). Mutable fixtures removed, four prior immutable audits retained, catalog/locks removed.

Root перенёс exact24backend+4UI+22caseUItest+OpenAPI2literalchanges; existing atomic-profile3files preserved. [Adoption30paths](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c04-c05-adoption-root-1.json). UI22 previously actualGREEN is syntheticHTTP/browser, not physical-provider acceptance. Сейчас generator/fulltypes/lint/build/integratedbrowser ещё pending. PortableisolatedCI implementation source work идёт отдельно; no CI/newdelivery result claimed.

Остаются полные C01–C08/общие worker/lease/erasure сценарии, интеграционная приёмка/CI/публикация и первоначальные WP/FR/SC/NFR/A/U требования. Я не могу это подтвердить: закрытие provider/device/M01/WP11/human gates.


## 2026-10-03T20:16:15.410Z · Плановый отчёт23:15МСК · adoptedC04/C05 · полныхWP0/17

Полностью подтверждено **0/17 WP00–WP16**;17=16−0+1. Цель active; следующий отчёт20:45UTC/23:45МСК. За период включены exact24backend+4UI+UI22test+OpenAPI; generated4raw changes включают2typed semantic additions409 и2CRLF→LFonly. [Adoption](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c04-c05-adoption-root-1.json). Native30RED18/12→GREEN30 иpostfixworker19GREEN приняты ранее, не являются wholeA12/WP acceptance.

Первый full frontend2127=2123PASS+4FAIL остановлен доbackend/lint/build. Ошибки lifecycle/browserSubscription, StorageEvent.storageArea и opaque same-session fixture подтверждены freshsource review; exact3fixturecorrections privateготовы, assertions/counts сохранены, adoption/rerun pending. [Failurelog](/C:/Тили-тили/.unlazy/tz-full-20261002/logs/full-a12-c04-c05-full-1.log), [fixture review](/C:/Тили-тили/.unlazy/codex-planb-20261003/A12-C05-EXISTING-FIXTURE-SOURCE-REVIEW.md).

Отдельные backendwholetypes иwholelint actualexit0 (root tool chunks7a65d5/60fa84, emptyoutput), наcurrent717sourceF6B0F86BC650EF0D98EEFD76B0F56B4413039CDBDDADECD4D3913AA61F6DBB19. Fullbackendnative статус на момент записи: **ВЫПОЛНЯЕТСЯ:root tool session16163, completed execution artifact отсутствует; результата пока нет**. RootactualFULLtargetOID517419/native82/Redis12 attested; это existingdisposabletarget, не absent-only новая база. [Preflight](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c04-c05-full-preflight-root-1.json).

Freshlive integrationreview не нашёл иного boundedmaterialblocker; R01exactserver409ENtranslation подготовлен и admittedsource-only. [Review](/C:/Тили-тили/.unlazy/codex-planb-20261003/A12-C04-C05-LIVE-INTEGRATION-REVIEW.md), [i18nproposal](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c05-server409-i18n-v1/SOURCE-DELTA.json). ActualnativePWA/API browser иportableCI implementation готовятся source-only отдельно; no completed runtime claimed.

Остаются actualfocused/full/build/browser/portablelocal+publicCI/отдельная поставка этого блока и первоначальные WP/FR/SC/NFR/A/U. Новые C01–C08 graph/staff/read/lease/erasure/retention сценарии не закрыты49native+22UI. Асинхронно запрошены отсутствующие M01fields/access/deletion иWP11products/prices/entitlements/provider; ответа пока нет, зависимые policy choices не приняты. Я не могу это подтвердить: provider/device/human acceptance и завершение любого полногоWP. [Отчёт блока](tasks/фичи/030-экосистема-local/REPORT-NOTICE-ADMISSION-20261003.md).


## 2026-10-03T20:45:28.387Z · Плановый отчёт23:45МСК · regression repair · полныхWP0/17

Полностью подтверждено **0/17 WP00–WP16**;17=16−0+1. Цель active, следующий отчёт21:15UTC/00:15МСК 04октября. За период включены исправленные frontend fixtures и точный ENперевод реального server409. Actual focused4suites **105/105PASS**, первый focused104PASS/1fixturebrandFAIL сохранён. Это synthetic browser/HTTP evidence, не physical/provider proof. [Actual105](/C:/Тили-тили/.unlazy/tz-full-20261002/logs/vitest-a12-c05-ui-integration-2.log), [fixturebrand receipt](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c05-fixture-brand-fix-root-1.json), [ENadoption](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c05-server409-i18n-adoption-root-1.json).

Первый полный backend завершён: **3247=3211PASS+36FAIL**,7failedfiles. Это не полный успех. Две реальные ACLошибки404/403→409 подтверждены rawHTTP; изменение selectedvendorowner выявлено как source-risk, исходный тест остановился на SQLshape до HTTPassertion. Root отдельный wrapper не добавил GitshPATH,10restorecases statusnull; повтор через штатное окружение **10/10PASS**. Остальные SQLobserver/fault failures не объявлены исправленными до actual rerun. [Rawbackend](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c04-c05-backend-regression-root-1.log), [actual restore](/C:/Тили-тили/.unlazy/tz-full-20261002/logs/vitest-a12-restore-env-1.log).

Fresh different-author V3source review принят: exact3backendfiles included 2026-10-03T20:41:52.702Z,717source digestF7B1B896CDE18447FC7CE4B428F7CBBA036418D692D1CC2CF8AF6CF4A6344FC2; native acceptance ещё UNRUN onV3. Whole backendtypes после adoption actualexit0. Exactlocks/quota/receipt/finalJWT suffix preserved byfullinverse; это source evidence, не native claim. [Freshreview](/C:/Тили-тили/.unlazy/codex-planb-20261003/A12-C04-C05-BOUNDARY-V3-SOURCE-REVIEW.md), [actualadoption](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-boundary-v3-adoption-root-1.json). Private6backendtest adaptations сохраняют прежние HTTP/rollback/privacy oracles и добавляют nativePID/graph proofs; независимый review выполняется, liveadoption/runtime pending.

PortableCI source review выявил минимум2 ранних admissionblockers: missingdirectory иmissingjournalNames. FrozenV1 не принят; автору переданы для NEWversion, исправления/actualported49/publicCI ещё не подтверждены. Browser14 frozenauthored; root actual PythonAST PASS после execution sandbox escalation, но native/newtarget/source-rebind/browser14/layout6 ещё pending. [CIhandoff](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c04-c05-portable-ci-v1/HANDOFF.md), [browserhandoff](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c05-browser-v1/HANDOFF.md).

Остались actual focused/full/build, portablelocal49 иpublicCI, PWA14/6layouts, независимая финальная приёмка и отдельная поставка блока. Весь исходный WP/FR/SC/NFR/A/U сохраняется, C01–C08/futuregraph/staff/read/lease/erasure/retention не закрыт boundedcases. M01/WP11questions pending, без принятия policy по истечению времени. Я не могу это подтвердить: physicalprovider/device/human acceptance и завершение любого полногоWP.


## 2026-10-03T21:21:15.835Z · Плановый отчёт00:15МСК04октября · boundary repair · полныхWP0/17

Полностью подтверждено **0/17 WP00–WP16**;17=16−0+1. Goal active, следующий отчёт21:45UTC/00:45МСК. Actual completefrontend **2127/2127PASS**,113files, source-before/afterequal717; separatewholefronttypes/lint actualexit0. Это frontend acceptance, не полный backend/build/browser/publicCI. [Qualifiedfront](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c05-ui-full-2-qualified-root-1.json), [types](/C:/Тили-тили/.unlazy/tz-full-20261002/logs/tsc-app.log); lint tool2192f9 exit0, only BABELsize note.

Root six backendfixture corrections included20:57:40 withfreshreview/fullinverses/nochangedoracles. ActualV3 nativefocus **262=261PASS+1FAIL**, one new replacementchanged_owner response404 instead oforiginal409; originalbookprivate404 passed. Whole firstbackend3247=3211PASS+36FAIL retained, restore10/10 separately passed. V4exactonecallsite removesprivate404flag ONLYreplace, preservesbookflag/fullpins/ACL/quota/receipt/JWT. Freshdifferent-author11CPU/AST/lint/source review accepted thenroot included 2026-10-03T21:12:49.631Z,717source16F2BBAA848A62674351892B08DB7BEBA784F548F4C92FD0CFC6F4ED470C98BC; V4currentnative104status **actual104/104PASS,exit0**. [Raw262](/C:/Тили-тили/.unlazy/tz-full-20261002/logs/vitest-a12-c04-c05-backend-focus-2.log), [V4review](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-boundary-v4-fresh-review-v1/REVIEW.md), [V4adoption](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-boundary-v4-adoption-root-1.json).

PortableCI V1 independentreview rejected4execution/uploadblocks+G02rawproofbinding gap. NEWV2 source correction41CPU/types/lint passed onactualreadtime115inputs (82migrations+seeddata2 admitted), finalcurrentV4rebind/freshreview/adoption/local49/publicCI pending. Hidden .ci artifactfiles requireinclude-hidden-files according to [official action README](https://raw.githubusercontent.com/actions/upload-artifact/v4/README.md); no artifactuploadruntime claimed. [CIreview](/C:/Тили-тили/.unlazy/codex-planb-20261003/A12-C04-C05-PORTABLE-CI-V1-SOURCE-REVIEW.md), [authorCPU](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c04-c05-portable-ci-v2/CPU-CHECK.1.json).

BrowserV1 independent source review foundB01 exactcase/origin classifier/parent omission; NEWV2 source correction and expandedstatic-tab observation+separatelytyped genuineAPIRequestContext capture prepared, finalcurrentrebind/freshreview/rootnative stillpending. No browser14/6layouts/provider/device acceptance claimed. [FreshB01review](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c05-browser-fresh-review-v1/REVIEW.md).

Остались currentfull/backend/build, isolatednative49, nativePWA14/6layouts, publicCI/отдельная поставка этого блока и весь исходный WP/FR/SC/NFR/A/U. C01–C08futuregraph/staff/read/lease/erasure/retention иM01/WP11/provider/device/humanrequirements сохраняются. M01/WP11questions ответа пока нет; policy не принимается по истечению времени. Я не могу это подтвердить: завершение любого полногоWP или physicalprovider/device/humanacceptance.


## 2026-10-07 · Отдельная ветка PWA / CLAUDE.md

- [x] Обновить CLAUDE.md, проверить исходники PWA по MDN/web.dev.
- [x] Подтвердить RED и исправить runtime cache lifetime/redirect/quota rejection.
- [x] Frontend types/tests/lint/build:2202passed; targeted32passed.
- [x] Изолированный Chromium:8сценариев online/offline/deep-link/update двух вкладок/logout; [evidence](../PWA-BROWSER-20261007.json).
- [ ] Сверить актуальный main и интегрировать проверенную ветку с CI, сохранив незакоммиченный FR011.

Следующий шаг: CI опубликованного SHA и merge в актуальный main; критерии и ограничения — [PWA-REVIEW-20261007.md](../PWA-REVIEW-20261007.md); этот отдельный аудит не закрывает целые WP.
