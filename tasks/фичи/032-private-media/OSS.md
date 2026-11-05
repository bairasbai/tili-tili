# OSS и границы032-A

Используется официальный [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3), Apache-2.0: точные `@aws-sdk/client-s3` и `@aws-sdk/s3-presigned-post`3.1162.0. Provenance подтверждён GitHub repository metadata и repository/license полями установленных пакетов; pnpm lock фиксирует содержимое. Код чужого приложения не копируется; лицензии остаются в дистрибутивах.

Backend multipart parser не добавлен. Подписанная POST policy ограничивает MIME/key/bucket/размер/срок. Bucket privacy/CORS/IAM/lifecycle — отдельная операторская приёмка. Только явные endpoint/credentials; автоматическая AWS credentials chain не используется.

Сканер следует [официальному ClamD protocol](https://docs.clamav.net/manual/Usage/ClamdProtocol.html): zINSTREAM+NUL, длины32-bitBE, нулевой финальный chunk, ограниченный ответ. TCP ClamD не шифрует и не аутентифицирует соединение: нужна доверенная внутренняя сеть. Для032-B ещё обязательны настоящий выбранный ClamD, актуальные сигнатуры и лимиты StreamMaxLength, clean/EICAR. Здесь проверен синтетический transport, не antivirus engine.

Используется прежний Sharp0.35.5; [официальная документация вывода](https://sharp.pixelplumbing.com/api-output/) описывает удаление метаданных по умолчанию. Фактические тесты проверяют EXIF/ICC/XMP/orientation после перекодирования. Нормализация приглашений не меняется.

`pnpm audit --prod --json`05.11.2026 дал exit1:16 записей в прежних fastify/fast-uri, без путей нового SDK. Это не чистый общий аудит и не доказательство применимости каждой advisory к приложению. Raw/точные URLs сохранены в E, отдельный backlog в tasks.md. Прежние версии в032-A не меняются.
