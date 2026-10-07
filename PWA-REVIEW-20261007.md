# Проверка PWA и инструкции агента — 7 октября 2026

Проверена отдельная ветка codex/pwa-practices-20261007 от локального main 406d5e7e091c737228995e7657a89bd926c653ca. Чужой checkout и незакоммиченный FR011 не изменялись. Свежесть GitHub main в этом аудите не проверялась. Это локальная проверка исходников и production-сборки, не подтверждение работы production или установки на физическом устройстве.

## Исправлено

В [public/sw.js](Тили-тили/app/public/sw.js) фоновая запись lazy assets теперь удерживает worker через event.waitUntil, сетевой ответ возвращается до завершения записи. Отказ CacheStorage/квоты при записи обработан; redirect не кэшируется под исходным URL. Правило остаётся белым списком собственной статики, API и пользовательские файлы проходят через сеть. Основание lifetime: [MDN waitUntil](https://developer.mozilla.org/en-US/docs/Web/API/ExtendableEvent/waitUntil).

Новые [runtime-регрессии](Тили-тили/app/src/lib/swRuntimeCache.test.ts) исполняют настоящий исходник worker в VM с Request/Response: задержка записи, отказ квоты, cache hit, redirect/HTML/HTTP error, API по разным путям, чужой origin. До исправления: 2 failed / 8 passed и 1 unhandled rejection. После: 10 passed, ошибок 0. В существующем [criticalAssets.test.ts](Тили-тили/app/src/lib/criticalAssets.test.ts) mock FetchEvent дополнен waitUntil; проверка изоляции чужого кэша сохранена.

[CLAUDE.md](CLAUDE.md): актуальное состояние берётся из текущей ветки и реестра; старый длинный статус убран из вводного блока, сентябрьские заметки явно архивные. Добавлены свежесть main, сохранение чужих правок, единственный владелец общих служб, последовательные GitHub-запросы, порядок быстрых/целевых/полных проверок и условия повторения, ограничения публикации и отдельные правила приёмки PWA. Удалены устаревшие фиксированные числа тестов и автоматический выбор системной базы 5432. Источники окружения: [CI](.github/workflows/ci.yml), [disposablePgPort.ts](Тили-тили/backend/test/disposablePgPort.ts), [общий гейт](init.sh).

## Что соответствует проверенным подходам

| Область | Найденная реализация | Предел подтверждения |
|---|---|---|
| Оболочка offline | [criticalAssets.ts](Тили-тили/app/build/criticalAssets.ts), [vite.config.ts](Тили-тили/app/vite.config.ts) включают реальные entry/критические маршруты/зависимости; install отвергает неполные/HTML/redirect ответы | Сборка включила 33 файлов, все существуют. VM-тесты install прошли; offline reload в настоящем браузере здесь не выполнен |
| Приватные данные | [sw.js](Тили-тили/app/public/sw.js) использует статический allowlist; [offlineAccess.ts](Тили-тили/app/src/lib/offlineAccess.ts) и [api/client.ts](Тили-тили/app/src/lib/api/client.ts) ограничивают область сессией/пользователем и очищают локальные копии | Это не серверная авторизация. Права, отозванные во время отсутствия сети, не могут быть заново проверены до ответа сервера |
| Обновления | [serviceWorkerUpdate.ts](Тили-тили/app/src/lib/serviceWorkerUpdate.ts), [AppUpdate.tsx](Тили-тили/app/src/components/AppUpdate.tsx): ожидание нового worker, подтверждение и предупреждение о потере несохранённого, controllerchange/reload | 5 unit-тестов прошли; обновление нескольких настоящих вкладок не выполнено |
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

## Что ещё проверить

1. Настоящий production build: первый онлайн запуск, offline reload и глубокая ссылка, сохранённые критические маршруты, восстановление сети, установка Android/iOS, обновление двух вкладок, выход/смена аккаунта offline. CUA 7 октября вернул browsers: []; IAB недоступен. Эти сценарии не выполнены.
2. Сборка предупреждает: entry index-DJsNp1XW.js 695.15 kB minified / 212.68 kB gzip. По одному предупреждению нельзя подтвердить скорость реального устройства. Нужен замер на целевом телефоне/сети, затем обоснованное разбиение кода; порог предупреждения не повышался. Общий ориентир — [MDN best practices](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Best_practices).
3. Проверить фактический manifest/installability и вид иконки на целевых браузерах по [MDN installability](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable). Добавление explicit id требует сохранения идентичности уже установленного приложения и поведения подпапок.
4. Независимое read-only ревью завершено: подтверждённых дефектов не найдено. Проверены lifetime записи, фильтрация redirect, тесты, цифры логов и сохранение обязательных гейтов в CLAUDE.md. Перед интеграцией: сверка актуального main, проверка итоговой версии/CI и передача владельцу активной ветки. Production deploy не выполнен.

Вывод: несколько важных практик PWA реализованы и защищены тестами; найденные runtime-дефекты исправлены локально. Утверждение «использованы лучшие подходы во всём проекте» этим ограниченным аудитом подтвердить нельзя.
