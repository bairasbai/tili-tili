# Проверка PWA и инструкции агента — 7 октября 2026

Проверена отдельная ветка codex/pwa-practices-20261007 от локального main 406d5e7e091c737228995e7657a89bd926c653ca. Чужой checkout и незакоммиченный FR011 не изменялись. Перед публикацией main проверен через GitHub и git fetch:406d5e7, совпадает с базой. Это проверка исходников, production-сборки и изолированного headless Chromium, не подтверждение работы production или установки на физическом устройстве.

## Исправлено

В [public/sw.js](Тили-тили/app/public/sw.js) фоновая запись lazy assets теперь удерживает worker через event.waitUntil, сетевой ответ возвращается до завершения записи. Отказ CacheStorage/квоты при записи обработан; redirect не кэшируется под исходным URL. Правило остаётся белым списком собственной статики, API и пользовательские файлы проходят через сеть. Основание lifetime: [MDN waitUntil](https://developer.mozilla.org/en-US/docs/Web/API/ExtendableEvent/waitUntil).

Новые [runtime-регрессии](Тили-тили/app/src/lib/swRuntimeCache.test.ts) исполняют настоящий исходник worker в VM с Request/Response: задержка записи, отказ квоты, cache hit, redirect/HTML/HTTP error, API по разным путям, чужой origin. До исправления: 2 failed / 8 passed и 1 unhandled rejection. После: 10 passed, ошибок 0. В существующем [criticalAssets.test.ts](Тили-тили/app/src/lib/criticalAssets.test.ts) mock FetchEvent дополнен waitUntil; проверка изоляции чужого кэша сохранена.

[CLAUDE.md](CLAUDE.md): актуальное состояние берётся из текущей ветки и реестра; старый длинный статус убран из вводного блока, сентябрьские заметки явно архивные. Добавлены свежесть main, сохранение чужих правок, единственный владелец общих служб, последовательные GitHub-запросы, порядок быстрых/целевых/полных проверок и условия повторения, ограничения публикации и отдельные правила приёмки PWA. Удалены устаревшие фиксированные числа тестов и автоматический выбор системной базы 5432. Источники окружения: [CI](.github/workflows/ci.yml), [disposablePgPort.ts](Тили-тили/backend/test/disposablePgPort.ts), [общий гейт](init.sh).

## Что соответствует проверенным подходам

| Область | Найденная реализация | Предел подтверждения |
|---|---|---|
| Оболочка offline | [criticalAssets.ts](Тили-тили/app/build/criticalAssets.ts), [vite.config.ts](Тили-тили/app/vite.config.ts) включают реальные entry/критические маршруты/зависимости; install отвергает неполные/HTML/redirect ответы | Сборка включила 33 файлов, все существуют. VM install и реальный Chromium: полный precache, offline reload/deep-link прошли |
| Приватные данные | [sw.js](Тили-тили/app/public/sw.js) использует статический allowlist; [offlineAccess.ts](Тили-тили/app/src/lib/offlineAccess.ts) и [api/client.ts](Тили-тили/app/src/lib/api/client.ts) ограничивают область сессией/пользователем и очищают локальные копии | Это не серверная авторизация. Права, отозванные во время отсутствия сети, не могут быть заново проверены до ответа сервера |
| Обновления | [serviceWorkerUpdate.ts](Тили-тили/app/src/lib/serviceWorkerUpdate.ts), [AppUpdate.tsx](Тили-тили/app/src/components/AppUpdate.tsx): ожидание нового worker, подтверждение и предупреждение о потере несохранённого, controllerchange/reload | 5 unit-тестов и реальное обновление двух вкладок из main worker на текущую сборку прошли |
| Изоляция кэша | Имена содержат scope, activate удаляет только собственные старые версии; cache version вычисляется из worker и состава сборки | Тесты root/subpath/чужого кэша прошли. Рекомендация: [web.dev lifecycle](https://web.dev/articles/service-worker-lifecycle) |
| HTTP-кэш | [deploy/nginx.conf](deploy/nginx.conf): HTML/sw/manifest no-cache; хешированные assets immutable; статические ошибки 404 | Проверен конфиг, фактические заголовки сервера и TLS не измерялись |
| Установка | [manifest.webmanifest](Тили-тили/app/public/manifest.webmanifest): имя, standalone, start_url/scope, SVG any и PNG512; [index.html](Тили-тили/app/index.html): manifest и apple-touch-icon | Подтверждение установки Android/iOS отсутствует. Отсутствие explicit id допустимо: identity берётся из start_url ([MDN id](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/id)); не добавлен ./id, который ломал бы различие подпапок |

## Проверки

Команды из Тили-тили/app, каждая exit 0:

- node node_modules/vitest/vitest.mjs run src/lib/swRuntimeCache.test.ts src/lib/sw.test.ts src/lib/criticalAssets.test.ts src/lib/serviceWorkerUpdate.test.tsx — 32 теста, 4 файла.
- node node_modules/typescript/bin/tsc -b.
- node node_modules/vitest/vitest.mjs run --maxWorkers=2 — 2202 теста, 115 файлов, 0 skipped/failed; продолжительность 229.97 s из вывода Vitest.
- node node_modules/eslint/bin/eslint.js .
- node node_modules/vite/bin/vite.js build.
- node --check public/sw.js.

Сырые локальные логи — verification/ в этом worktree (не коммитятся). Существующий backend не менялся и заново не запускался: общей базой/Redis управляет другой root. Этот результат не заявляется полным init.sh или приёмкой WP00–WP16.

## Браузерная приёмка перед слиянием

Результат — [PWA-BROWSER-20261007.json](PWA-BROWSER-20261007.json): 8 сценариев PASSED, Chromium139.0.7258.5, 0 JavaScript page errors. Проверены установка worker main с33precache assets; ожидание текущего worker в двух вкладках; подтверждение настоящей кнопкой обновления и перезагрузка обоих документов; сохранение чужого контрольного кэша; runtime caching реального lazy PaymentSchedule chunk и отказ cache для redirect; offline reload и first-visit deep-link калькулятора; восстановление сети; реальная кнопка Settings logout offline удаляет synthetic tokens/3private copies, сохраняя язык устройства.

Это статический HTTP-стенд на localhost с production build, без backend/DB/Redis и пользовательского профиля. HTTP503 намеренно отсутствующего API и ERR_INTERNET_DISCONNECTED в консоли сохранены в JSON; этот запуск не заявляется безошибочным whole-app E2E. Авторизация, реальные серверные сессии и отзыв прав им не проверены. Raw script/result/screenshot и предыдущие неуспешные попытки сохранены локально в verification/. Первые попытки не считались PASS: sandbox не позволял запуск Chromium, затем исправлены точное accessible name кнопки и ожидание содержимого lazy-экрана вместо раннего чтения Suspense. Продуктовый код между full2202 и браузерной приёмкой не менялся.

## Оставшиеся отдельные проверки

1. Физическая установка Android/iOS, push, смена аккаунта через сервер и действительные заголовки/TLS production здесь не проверены. Эти ограничения не переименованы в готовность всего приложения; локальная PWA-поставка не закрывает WP00–WP16.
2. Сборка предупреждает: entry index-DJsNp1XW.js 695.15 kB minified / 212.68 kB gzip. По одному предупреждению нельзя подтвердить скорость реального устройства. Нужен замер на целевом телефоне/сети, затем обоснованное разбиение кода; порог предупреждения не повышался. Ориентир — [MDN best practices](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Best_practices).
3. Перед merge проверить CI опубликованного SHA и неизменность main/base. Независимое read-only ревью runtime уже завершено без подтверждённых дефектов; финальные документы/браузерное evidence проходят отдельную сверку. Production deploy не разрешён и не выполнен.

Вывод: проверенные runtime-дефекты исправлены, unit/full frontend и целевые browser-сценарии прошли. Утверждение «использованы лучшие подходы во всём проекте» этим аудитом подтвердить нельзя.
