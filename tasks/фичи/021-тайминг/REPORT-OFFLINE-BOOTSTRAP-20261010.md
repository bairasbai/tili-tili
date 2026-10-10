# WP03 / FR040 / T009 · очистка копий при старте и загрузка оболочки

Checkpoint 2026-10-10T20:28:04.975Z: локальная приёмка завершена; публикация/CI/merge OPEN. Checkout C:/Тили-тили/wp03-continuation-20261010, branch codex/wp03-continuation-20261010. Guarded origin/main на20:00:36UTC=HEAD83e7b145fea75b3fd0767fa7ade64d633b983a8d/divergence0/0; перед публикацией нужна новая сверка. Полных WP принято0/17.

## Поведение

При старте до React очищаются прежние неразмеченные, неизвестные или неоднозначные копии из пяти известных offline-ключей. Валидные текущие копии проходят существующие validators/projections: сохраняются минимальные данные с исходным владельцем, сессией, версией и временем чтения. Значения не придумываются; сторонние ключи, вход, язык и тема сохраняются. Если storage одновременно запрещает запись и удаление, проверен no-crash; физическое удаление bytes подтвердить нельзя.

HTML использует абсолютные адреса фактических CSS/preload/module ресурсов и контролируемый parser entry. Проверяется прямой вход, история и подпапка; итоговый HTML участвует в версии service worker. Пять DayX read factories и VendorTabBar не отправляют чтение при известном offline; восстановление сети вызывает свежие чтения. Сохраняются текущая сессия, штатные ошибки, очистка неподтверждённого badge и существующая навигация.

Source digest EFF87C3E9BB740252BB8D32C188EF510539D91AB33A85615D474C791CD716902 /791inputs: [manifest](C:/Тили-тили/.unlazy/wp03-continuation-20261010/source-root-vendor-nav-v1.json), [независимый SOURCE6](C:/Тили-тили/.unlazy/wp03-continuation-20261010/REVIEW-v6.md), [root](C:/Тили-тили/.unlazy/wp03-continuation-20261010/root-source-review-v6-verified.json). Backend, контракт0.72.5/85миграций, dependencies/locks/deploy/init не менялись. Последний Nav delta — один существующий файл и новый12-case test;789 прежних inputs совпали.

## Подтверждённые проверки

| Проверка | Фактический результат | Источник |
|---|---|---|
| VendorTabBar regression | Старый код отказал на cold-offline GET/chats; новый12PASS, ближайшие106=12+94/7files, types/lint0 | [root](C:/Тили-тили/.unlazy/wp03-continuation-20261010/root-vendor-nav-handoff-verified-v1.json) |
| Полный штатный gate |5951=2542frontend/127files+3409backend/155files; все8этапов, failed0/skipped0/exit0/sourceEqual791 | [full9](C:/Тили-тили/.unlazy/wp03-continuation-20261010/full-v9.json), [raw](C:/Тили-тили/.unlazy/wp03-continuation-20261010/full-v9.log), [root](C:/Тили-тили/.unlazy/wp03-continuation-20261010/root-full-v9-verified.json) |
| Native full7 | Fresh cluster отсутствовал до создания; Russian_Russia.1251/UTF8,85миграций,119городов/6actualSQLprobes; отдельный delivery42PASS. Fresh штатно остановлен; retained105tables/2sequences/85journal/catalogue восстановлены точно | [overall](C:/Тили-тили/.unlazy/wp03-continuation-20261010/full-isolated-v7-overall.json), [restore](C:/Тили-тили/.unlazy/wp03-continuation-20261010/full-isolated-v7-restored.json) |
| Chromium geometry8 |1positive+8negative+2inner, actual CSS/Chromium, own browser закрыт; scope только fixtures | [geometry](C:/Тили-тили/.unlazy/wp03-continuation-20261010/geometry-controls-v8.json), [inner](C:/Тили-тили/.unlazy/wp03-continuation-20261010/geometry-inner-qualified-v8.json) |
| Actual public shell9 |16cases/80phases/944requests=responses=finished;752original bodies+192proved cached;32anonymous no-store health; tracked app console/page/network/capture0; source/build/cleanupPASS | [root](C:/Тили-тили/.unlazy/wp03-continuation-20261010/root-shell-46be3-pass-verified.json) |
| Private stand17 SOURCE |7полных forward/inverses/syntax0;146input rows+отдельныйSHORT9+manifest=148absolute refs,91compiled pins отдельно; independent8positive/19AssertionError negatives | [review](C:/Тили-тили/.unlazy/wp03-continuation-20261010/BROWSER-REVIEW-v17.md), [root](C:/Тили-тили/.unlazy/wp03-continuation-20261010/root-browser-review-v17-verified.json) |

Shell9 сохранил288framework Response.finished.on_finished / Target closed warnings. Root и independent reviewer проверили installed Playwright _network.py884–899: после обычного завершения остаётся задача ожидания закрытия context. Body/CDP/finished наблюдения собраны. Связь конкретного taskID с requestID не записана — я не могу это подтвердить. Это не globalzero-log claim и не разрешение ошибки в MAIN: основной runner требует пустой browser.log. Dependencies/observer/classifier ради подавления warnings не менялись.

Полный gate остаётся действительным: после него менялись только private browser helpers и документация; продукт, тесты в полном наборе, runtime конфигурация и сборка совпадают. Actual Node24 check-evidence-v6.mjs full full-v9.json20:00UTC exit0 WP03_FULL_EXACT_PASSED5951 — сверка сохранённого прогона, не ещё один запуск5951тестов.

## Завершённая браузерная приёмка

MAIN17 завершён exit0:42=7ролей×RU/EN×320/390/480;768=30×20+12×14фаз;1536=768×2native checkpoints;168=42×4primary PNG. Root действительно просмотрел все42 original contact sheets, каждый содержит4полных unscaled/uncropped PNG. Все17772requests=responses=finished; строгая классификация2298API reads/72ожидаемых отказа/72ожидаемые console rows/180secondary DOM/losses0. Неожиданные403/404/page/request/capture/body/pending отказы отсутствуют в принятой матрице; browser.log0bytes. Все18 actual saved-ledger negative controls отклонены AssertionError. Это18отрицательных проверок классификатора, не18новых native сценариев.

Actual cleanupPASS:oldAuditExact/nonAuditRowsExact/sourceEqual,providers0; retained3290audit rows сохранены,total3506(+216). Native fixtures и private credentials отсутствуют; все3ownedchildren завершены (APIexit0/nginxexit1при штатном принудительном закрытии/Pythonexit0). OS20:25:59UTC: pinnedChrome0/reserved8097–8100listeners0. Foreign PG5432/Redis6379 не изменялись. Доказательства [cleanup](C:/Тили-тили/.unlazy/wp03-continuation-20261010/browser-86b24e06-a685-4736-9017-9cabde094183/cleanup.json) и [overall](C:/Тили-тили/.unlazy/wp03-continuation-20261010/browser-86b24e06-a685-4736-9017-9cabde094183/overall.json).

[Qualified receipt](C:/Тили-тили/.unlazy/wp03-continuation-20261010/browser-qualified-v6.json) SHA256 F71C88B95262B40070BE2CF7A5D59A91D39663E0A14B827279A8CD79B6E6803A; [original views](C:/Тили-тили/.unlazy/wp03-continuation-20261010/browser-86b24e06-a685-4736-9017-9cabde094183/root-contact-views-v1.json) SHA256 FB54EA4B1AD5D12709D2E0C1A9A08C150F43C2489FAB381C3F50B098001AC0B8; [18 controls](C:/Тили-тили/.unlazy/wp03-continuation-20261010/browser-86b24e06-a685-4736-9017-9cabde094183/classification-controls-v4.json) SHA256 30CA3B9B1CBB4EB112889549F383BEA2A17FC8CE41E2894C0E169BE1FA82BC8D. Actual qualifier7/checker6 exit0. Original matrices, native ACL/session/revocation, geometry, source/build/body/cleanup guards сохранены.

Исторический MAIN16 FAILED из-за ошибочного universal-anonymous transport oracle зарегистрированного гостя; raw failure неизменён. Независимый SOURCE17 квалифицирует только точный owned-token GET/rsvp/{token}/events с actual native own sub/SID/bearer; все другие public readers anonymous. MAIN15 actual offline GET/chats defect исправлен live guard/reconnect и подтверждён current full/browser. [История](C:/Тили-тили/.unlazy/wp03-continuation-20261010/root-main16-failure-verified-v1.json).

## Следующий шаг и пределы

Локальные проверки, все42rootviews и очистка завершены. Следующий шаг: fresh guarded main → scopedcommit/attachedPR → final-head7CI checks и native49+8/schema85 → freshmain/integration → обычное защищённое merge и remote tree proof. Публикации текущей поставки ещё нет; production не разрешён. [GATES](C:/Тили-тили/.unlazy/wp03-continuation-20261010/GATES.md), [handoff](../../../session-handoff.md).

Пять localStorage copies не закрывают всю legacy CacheStorage migration, физические устройства, installed-PWA upgrades, провайдеров, пилот, полныйT009/WP03 или все17WP. Quiz/Onboarding в отдельных checkout не интегрированы и требуют собственного full/browser/CI. Действующий OpenAPI508: raw quizAnswers принимаются, но не хранятся/читаются сервером; будущая Quiz приёмка подтверждает значимые коды, derived fields и создаваемые семьи данных после повторного входа, не придуманную raw-колонку.
