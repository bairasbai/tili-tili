# WP03 / T008: Интервалы И Часы Основного DayX

2026-09-30. Локальный этап; полный T008/WP03/WP00-WP16 ещё не принят.
Код незакоммичен/не опубликован, production не затронут.

## Реализация

- `timelineClock.ts` выбирает все известные активные интервалы по условию
  start <= now < end, независимо от ручного sort. Завершённый, нулевой,
  обратный или неизвестный интервал не получает LIVE. Отсутствующее окончание
  не вычисляется из соседей. Следующий блок имеет ближайший будущий start.
- Все параллельные активные блоки показаны отдельно. Непустая законченная
  программа отличается от пустой; при неполных интервалах текущий блок
  обозначен как неопределённый. Минутное обновление сохранено без очистки
  отображённых данных; оно теперь перечитывает также свадьбу и мероприятия.
- DayX читает timeline/event snapshots с настоящими ETag. Пояс и название
  eventId используются только при равенстве версий обоих ответов. При разных
  или отсутствующих ETag контекст не смешивается: явная метка и кнопка
  перечитывания обоих запросов. Это не перебазирует preview сдвига.
- Строки программы показывают начало и известное окончание с полной местной
  датой, IANA-поясом и названием мероприятия. Каждый eventId имеет свой пояс;
  чужой/неизвестный ID, отсутствующий/неверный пояс не наследуют wedding tz.
  Совместимые строки без eventId используют только реально загруженный wedding tz.
- Unknown context показывает исходную ISO-отметку с явной меткой неизвестного
  пояса, не часы браузера. ISO без Z/offset не считается известным instant.
  Snapshot savedAt остаётся временем устройства, а не временем мероприятия.
- Старые offline copies не имеют доказанного исторического пояса: показываются
  как копия, без LIVE и без подстановки сегодняшнего wedding/event context.
  Их реальные endsAt/eventId доступны через тип, но не реконструируются.
  Полный versioned offline/access cleanup остаётся T009.
- Ошибки/403 чтения контекста показаны словами сервера; отказ не пустая выдача.
  Network failure допускает повтор, 403 не предлагает бессмысленный retry.
  RU/EN добавлены, часы/имена переносятся внутри мобильных строк.

## Доказательства

Логи: `C:/Тили-тили/.unlazy/wp03-shift-20260930/`.

- `dayx-before-clock.log`: первый новый набор выявил также неоднозначные
  locator имён (заголовок + строка). Он не считается восемью behavioral witnesses.
- `dayx-before-clock-locators.log`: после исправления locators восемь новых
  failures / 70 прежних passed: ended/unknown LIVE, потерянная parallel ветка,
  manual-sort next, half-open boundary, browser zone, unknown event и offline LIVE.
- `dayx-clock-labels.log`: 78/78. `full-dayx-clock.log` обнаружил потерянный
  forbiddenText; `dayx-clock-denial.log` после исправления 83/83.
- `full-dayx-final.log`: исторический промежуточный 1136 frontend / 1381 backend,
  типы/линт/сборки, exit 0. Он предшествует version-coherence fix и не является
  итоговым доказательством текущего кода.
- `dayx-before-context-hours-count.log`: один regression failed / 83 passed;
  при timeline ETag 1 / contexts ETag 2 экран действительно показывал 18:00
  дважды из смешанного snapshot. `dayx-context-version.log`: 84/84, включая
  запрет смешивания и явное перечитывание с последующим совпадением версий.
- `full-dayx-revisions-final.log`: итоговый init.sh exit 0, 84 frontend files /
  1137 tests, 111 backend files / 1381 tests; skipped нет, типы/линт/сборки
  прошли. После него прикладной код не менялся.
- `browser-evidence-dayx1/timeline-browser-result.json`: 15 actual Chromium/API
  checks passed, page_errors пуст. Пояс браузера явно UTC; основной экран
  показывает Ufa/Moscow часы/оба конца/дату второго дня, ended history не LIVE.
  320/390/1440 без horizontal overflow; screenshots просмотрены, включая
  parallel390 и dialog320. Полный прежний shift сценарий повторён: actual scopes,
  роли, stale, lost committed response/replay и manual coordinator resolution.
  Parallel boundary использует реальные API интервалы и явно управляемые
  browser-clock 2027-06-14T09:15Z -> 09:36Z, не поддельное серверное время;
  API пишет/проверяет по собственному real clock. Оба LIVE сняты после концов.
  Runner/API/Vite/Python завершены, private fixture удалён. Это headless,
  не physical devices/offline lifecycle/load/pilot/providers acceptance.

После приёмки данного этапа запущен отдельный local preview на 127.0.0.1:3000,
API health 127.0.0.1:3001, оба HTTP200. External preview-api.mts жёстко использует
только loopback *_test DB dayx1, env=test/Redis=null, без background worker и без
нового seeding. Это интерфейс на тестовой БД, не production/real OTP delivery.
Процессы preview намеренно оставлены отдельно от завершённых test runners;
точные PID и безопасный следующий шаг — session-handoff.md.

Прирост frontend 1137 - 1123 = 14 новых тестов: 10 component scenarios +
4 pure clock checks. Backend 1381 не изменился. Прежние
audit29/audit30 сохраняют проверку перехода/refresh/no blink/unmount; их
фикстуры теперь явно имеют окончания, вместо прежнего предположения о них.

## Остаток

Этот этап не реализует T006 human-readable последствия/полные preview-интервалы,
event invitations/RSVP/transfers, T007 exact-version acknowledgment, остальной
T008 UI, T009 полноценный offline snapshot/отзыв доступа и всю SC/NFR приёмку.
Провайдеры/production/физические устройства/нагрузка/пилот не проверялись.
