# WP01/T005 · основа032-A · 5 ноября2026

Поручение: продолжить17пакетов, использовать подходящие OSS. Сохраняется разрешённая поставка без новых подтверждений и отдельное разрешение на одного read-only reviewer. Production запрещён; старые FAILED/аудит/сохранённые деревья не трогать.

W=C:/Тили-тили/wp01-private-media-20261105, branch codex/wp01-private-media-20261105, base main e003f2a2d91b9303a8808dcfca47e2cf9c622762/PR86. E=C:/Тили-тили/.unlazy/wp01-private-media-20261105. Root один writer/shared-service owner, reviewer пишет только E/REVIEW.md. Копия зарегистрирована до создания, после приёмки подлежит штатной уборке с сохранением результата.

032-A реализует выключенную по умолчанию fail-closed MEDIA_* config, AWS SDK3.1162.0 Apache-2.0, exact quarantine POST policy, bounded GET/immutable clean PUT/delete, ClamD INSTREAM с абсолютным15с deadline и завершением всех await, Sharp reencode одиночного JPEG/PNG/WebP без метаданных. Вход/выход10МиБ,40Mpx/8192dimension; SDK error/control collector отдельно64КиБ. Клиенты/соединения при startup не создаются. API/контракт/UI/applied SQL1–98 не меняются; /media/upload-url сохраняет501.

Целевые проверки: config baselineRED10FAIL/1positive→GREEN11PASS; SDK body regression дофикса12selectedFAIL/13unselected→окончательные68/68/0skip native0. Реальные synthetic HTTP/TCP, socket close/backpressure/drip, error/success-control responses, redirects/лимиты/EXIF/animation. Порты проверяются повторным bind после cleanup. tsc strict именно новыхtest/helper и backend lint прошли. Raw/receipts: E/runs/media-adapters-accepted.json, S3-CONTROL-REGRESSION.json, CONFIG-REGRESSION-ACCEPTANCE.json. Отказы оснастки и неверных unit expectations сохранены отдельно, не считаются product RED.

Первый full bash init.sh ещё выполняется на новых own PG15432/Redis56379. Frontend3183/156/0skip, типы/линт/сборка уже прошли; frontend исходники неизменны. Во время backend выявлен и исправлен F3 SDK collector: поэтому первый backend-full не является квалификацией окончательного032-A; обязательны final-current полный backend/CI. FULL-FIRST-SCOPE-NOTE.json не позволяет подменить его прошлым PASS. SOURCE-DELIVERY-CANDIDATE.json фиксирует текущие источники без генерируемой .ci.

Службы: E/tmp/services/{PG-OWNER,REDIS-v2-OWNER}.json содержат точныеPID/birth/exe/cmd/cwd/ports. БД tili_ecosystem_full_20260930_test,role codex_test,RedisDB1. Первый Redis завершился из-за UTF8 директивыdir; FAILED сохранён, повтор безdir. Перед финалом штатно остановить только свои службы и проверитьPID/порты; старые offlineFAILED PG не запускались.

Dependency audit exit1:16 записей=4high+8moderate+4low, все в прежних Fastify5.12.1/fast-uri4.1.4+3.1.7, без SDK paths. DEPENDENCIES.json:26addedrecords, все прежние неизменны. Это отдельный security backlog, не clean audit. Источники и operator limits — tasks/фичи/032-private-media/OSS.md.

До слияния032-A остаются: свежий независимый SOURCE/ACTUAL GO послеF3, final-current full backend и exact-head CI, scoped commit/PR, fresh main/обычный merge; затем source restoration/необходимые FAILED/уборка своей worktree/зависимостей/temp. Итоговые remote/cleanup документы будут в E; pending не заменять историей. При передаче после поставки читать E/FINAL-REPORT.md и PUBLICATION.json, если реально созданы.

Следующий продуктовый шаг032-B: T03+T04 вместе — DB99/owner/currentJWT/session/consent, квоты живых POST grants/storage debt, nonce lease/ambiguous COMMIT, durable cleanup до cascade, stable vendor_media/profilePUT/export/erase. Затем UI/контракт и полный M01–M12/DB/migration/browser gate. Весь T005/WP01/17пакетов открыт; реальные private bucket/ClamD engine/устройства/restore — отдельные operator/WP gates.
