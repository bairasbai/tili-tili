# OSS и границы032-A

Используется официальный [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3), Apache-2.0: точные `@aws-sdk/client-s3` и `@aws-sdk/s3-presigned-post`3.1162.0. Provenance подтверждён GitHub repository metadata и repository/license полями установленных пакетов; pnpm lock фиксирует содержимое. Код чужого приложения не копируется; лицензии остаются в дистрибутивах.

Backend multipart parser не добавлен. Подписанная POST policy ограничивает MIME/key/bucket/размер/срок. Bucket privacy/CORS/IAM/lifecycle — отдельная операторская приёмка. Только явные endpoint/credentials; автоматическая AWS credentials chain не используется.

Сканер следует [официальному ClamD protocol](https://docs.clamav.net/manual/Usage/ClamdProtocol.html): zINSTREAM+NUL, длины32-bitBE, нулевой финальный chunk, ограниченный ответ. TCP ClamD не шифрует и не аутентифицирует соединение: нужна доверенная внутренняя сеть. Для032-B ещё обязательны настоящий выбранный ClamD, актуальные сигнатуры и лимиты StreamMaxLength, clean/EICAR. Здесь проверен синтетический transport, не antivirus engine.

Используется прежний Sharp0.35.5; [официальная документация вывода](https://sharp.pixelplumbing.com/api-output/) описывает удаление метаданных по умолчанию. Фактические тесты проверяют EXIF/ICC/XMP/orientation после перекодирования. Нормализация приглашений не меняется.

`pnpm audit --prod --json`05.11.2026 дал exit1:16 записей в прежних fastify/fast-uri, без путей нового SDK. Это не чистый общий аудит и не доказательство применимости каждой advisory к приложению. Raw/точные URLs сохранены в E, отдельный backlog в tasks.md. Прежние версии в032-A не меняются.


## Security increment после032-A ·05.11.2026

Исходные16production records выше относятся к032-A и устранены следующей поставкой отmain8db687d: [Fastify5.12.8](https://github.com/fastify/fastify/security/advisories/GHSA-3qgw-9275-xf8w), fast-uri[3.1.9/4.2.3](https://github.com/fastify/fast-uri/security/advisories/GHSA-333x-w4r6-6crp) и требуемый router find-my-way9.10.0. Дополнительная header propertyNames граница закрыта[5.12.6+](https://github.com/fastify/fastify/security/advisories/GHSA-389g-gv7q-r4x8); floor5.12.8 покрывает её тоже. Fastify/router MIT, fast-uri BSD-3-Clause по установленным package metadata. API/framework major не менялся. Два scoped pnpm overrides удерживают affected URI major3/4 на их patched versions; остальные package records неизменны. Версия pnpm10.34.5 закреплена, lock генерируется штатно; см.[pnpm10 overrides](https://pnpm.io/10.x/settings#overrides).

Production audit сейчас exit0/0records; ALL audit exit1/22devtool records (10high/11moderate/1low), paths/raw в E/DEVELOPMENT-AUDIT-FINDINGS.json. Это отдельный OPEN backlog glob/js-yaml/brace-expansion/source-map-js/Vite/mocker/minimatch. Devtools используются для migration/generation/test и не объявляются безвредными; общийsecurity audit не чистый. Current tests49security+9contractPASS/0skip и targeted independentGO не заменяют finalhead fullCI. Реальные облако/antivirus engine/операторские gates032-B остаютсяOPEN.
