# Проверка закрытия ограничения `/legal/policy`

14 октября 2026 Александр разрешил отдельную проверку 48 офлайн-сценариев V14, затем дополнительную узкую диагностическую версию после остановки первого прогона. Продукт и бэкенд не изменялись. Профиль исходного V14 сохранён: database/Redis/jobs=null; чужие службы не использовались.

## Фактические результаты

| Проверка | Доказательство | Результат |
| --- | --- | --- |
| Положительный контроль: один офлайн-сценарий со старым закрытием и Chromium tracing | [V1 reconciliation](positive/reconciliation.json), [native](positive/actual-health.json), [journal](positive/case-journal.json) | 2 строки закрытия с правильной меткой: `/health` и `/legal/policy`; непарных строк и ошибок 0 |
| Первый основной прогон | [V1 reconciliation](main/reconciliation.json), [STOP report](STOP-REPORT.json), [FINAL_FAIL](final-review.json) | FAILED: 16/48 завершены, 5 непарных тёплых `/health`; на 17-м сценарии сетевой отказ загрузки React |
| Разбор временной сверки V1 | [Независимый анализ](v2/NETWORK-CLOCK-SOURCE-ANALYSIS.json), [posthoc](v2/TIMING-ANALYSIS.json) | По часам Playwright не доказана нижняя граница с точностью 1 мс. Повторный анализ старых данных не является приёмкой; старый FAILED сохранён |
| Диагностика проблемного сценария RU/480/scene 1/normal | [V2 reconciliation](v2/diagnostic/reconciliation.json), [независимый gate](v2/DIAGNOSTIC-GATE-REVIEW-v2.json) | DIAGNOSTIC_PASS: 1/1, paired 2, closing/unpaired/errors 0; прежний сетевой отказ не повторился |
| Фактический повтор 48 офлайн-сценариев | [V2 reconciliation](v2/main/reconciliation.json), [browser summary](v2/main/browser-summary.json), [native](v2/main/actual-health.json), [journal](v2/main/case-journal.json) | MAIN_48_CLEAN: 48/48, paired 96/96, closing/unpaired/unmatched/ambiguous/errors 0 |
| Независимое ревью | [SOURCE](v2/SOURCE-REVIEW-v2.json), [FINAL](v2/FINAL-REVIEW-v2.json) | SOURCE_PASS и FINAL_PASS; обновление приёмки допущено в пределах согласованного ограничения |

Основной повтор: 48 раскладок, 540 held-нажатий, 588 PNG; 7512 request = response = finished. Все пять исходных массивов ошибок пусты. Трассировка и внедрённые JS-логгеры выключены. 48 контекстов созданы и закрыты; браузер, Python, nginx и API остановлены. Все 367 закреплённых входных файлов V14 сохранили хеши; runner дополнительно проверил 374 входа с собственными и вспомогательными файлами.

[Отчёт остановки](v2/main/cleanup.json) и [строгая OS-проверка собственных портов Root](v2/OWN-PORT-CLEANUP-20261014.json): системный запрос выполнен успешно, на портах 62348/58449 слушателей 0. Граница независимой OS-проверки ревьюера указана в FINAL-отчёте.

## Что изменено в стенде

Копия V12 выгружает страницу через `about:blank` внутри наблюдаемой `teardown-unload`-фазы, затем всегда вызывает `context.close()` в `finally`. Журнал содержит phase-end, unload-start, unload-done, close-call, page-close, context-close и close-return. Метка контекста задаётся cookie `tt_probe_case`; в доказательствах сохранён только SHA256.

Дополнительно разрешённая V2 записывает коды сетевых ошибок и исходные числовые часы API через уже существующие слушатели. Корреляция привязана к фактическому сценарию, cookie SHA256, методу, пути, статусу, байтам ответа и наблюдаемой фазе. Требуется единственное полное соответствие; неоднозначность, отсутствие метки, строка закрытия или непарная строка дают FAILED. Выведенные часы Playwright сохранены для диагностики. [SOURCE freeze](v2/SOURCE-FREEZE-v2.json), [CPU 29/29](v2/source-selfcheck.json), [main admission](v2/MAIN-ADMISSION-v2.json).

Приложение и закреплённый бэкенд не читают `tt_probe_case`; ответы `/health` и `/legal/policy` с меткой и без неё совпали побайтно: [контроль](positive/byte-equivalence.json), [диагностика](v2/diagnostic/byte-equivalence.json), [основной повтор](v2/main/byte-equivalence.json). Положительный контроль переиспользован из фактического V1: второго контрольного браузерного запуска не было. Его строки независимо проверены V2-ревьюером; posthoc явно помечен как анализ, а не новый запуск.

## Границы вывода и сохранность

Исторический инициатор V14 row 756 остаётся UNKNOWN. Я не могу это подтвердить. Новый прогон доказывает работу исправленного порядка закрытия и отсутствие лишних/непарных строк в 48 проверенных сценариях; он не устанавливает инициатора старой анонимной строки и не переписывает V14 AUDIT_INCOMPLETE, FAILED_POSTCOLLECTION или `qualification=false`.

SHA256 и 51 байт сохранённого сообщения консоли совпали со строкой `Failed to load resource: net::ERR_CONNECTION_FAILED`: [независимый разбор](v2/NETWORK-CLOCK-SOURCE-ANALYSIS.json). Старая запись requestfailed для загрузки React не сохранила код ошибки. Причина транспортного отказа не установлена. Успешный повтор не объявляется исправлением продукта или доказательством причины этого отказа.

Малые исходники и отчёты скопированы побайтно. `.gitattributes` отключает преобразование строк в этом архиве. [ARCHIVE-MANIFEST.json](ARCHIVE-MANIFEST.json) содержит SHA256/размер каждой архивной копии (сам манифест исключён). [LOCAL-ARTIFACTS.json](LOCAL-ARTIFACTS.json) индексирует 873 сохранённых крупных файла: полные сценарии, PNG и положительную Chromium trace. Их байты остаются локально в `C:/Тили-тили/.unlazy/policy-teardown-48-20261014/` и `C:/Тили-тили/.unlazy/policy-teardown-48-diagnostic-20261014/`; все 67 полных capture SHA256 совпали с browser-summary.

Приёмка ограничена онбордингом и этим пробелом проверки. WP00, SC004, остальные пакеты и production deployment этим архивом не принимаются. В следующих браузерных стендах, включая SC004, требуется тот же порядок выгрузки через `about:blank`.
