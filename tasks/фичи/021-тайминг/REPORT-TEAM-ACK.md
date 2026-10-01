# WP03 / T007: Сводка Ознакомления Для Пары И Команды

2026-09-30. Локально, не весь T007/WP03. Production/remote операции отсутствуют.

## Реализация

- GET /weddings/{weddingId}/timeline/acknowledgments: только actual couple/helper/
  coordinator membership своей активной свадьбы. Explicit GET-only rule перед
  общим timeline rule, не расширение vendor/guest прав. Wedding share lock,
  live account/session/member/role после ожидания. Cancelled/archived404.
- Общий readProgram с зарегистрированным vendor reader, не копия SQL/digest.
  Только active booked/paid_deposit/done deals; одна registered строка на анкету,
  несколько её сделок объединяются перед projection; external identity у dealID,
  не по совпадению имени. BlockCount из фактических назначений.
- Lock order wedding->user->vendor->deal совпадает с vendor reader/ack.
  Если ownership изменилось между selection и locked read, program_actors_changed409
  вместо неполного actor snapshot. No fake SQL success, check после настоящего wait.
- Current acknowledgment требует real live owner, exact sourceVersion и digest
  текущей разрешённой projection. Правка title без revision также invalidates
  old ack. Новая редакция/новый owner не наследуют old green.
- State pending/acknowledged/unassigned/unavailable/not_supported различаются.
  External assigned deal пока not_supported: это видимый остаток реализации,
  не фиктивное ожидание/подтверждение. Unavailable для deleted currentowner,
  не подтверждение доставки/прочтения. Отмена последней committed сделки убирает строку.
- Current actual acknowledgedAt/acknowledgedBy отдельно от previousAcknowledgment
  version/time/actor. Имя реального user_id берётся из текущего профиля, не
  исторический снимок имени; deleted/пустое имя null. История в БД сохраняется
  при tested owner change/revision/cancel. Последнее previous/current читаются
  bounded limit1, весь журнал клиенту не выгружается.
- No readToken/digest/session/userIDs/phones/finance/program_snapshot в DTO.
  GET read-only/no-store; ETag/sourceVersion/context под тем же wedding lock.
  API0.59.0,158paths/208operations/109schemas, normal generators; новой миграции нет.
- /wedding/timeline: unframed team summary, actual count/name/status/actor/time;
  separate native details для предыдущего подтверждения. Current rows только
  при совпадении main timeline ETag, summary ETag и summary body sourceVersion.
  Missing/malformed/current green without actual receipt не показываются как факт.
- Explicit refresh обеих частей, no stale green during refresh; после отказа
  данные снимаются. Offline/session-expired event unmount; reconnect fresh GET.
  No persistent cache и no automatic remote-revocation discovery claims.
- RU/EN. Related VendorPrograms GET403 тоже получает actual forbiddenText, не
  ошибочную подпись «раздел ведёт пара»; two new regressions.

## Проверки

External C:/Тили-тили/.unlazy/wp03-shift-20260930/:

- vendor-before-team-ack.log2newfailed/50oldpassed: missing route404, witness
  отсутствующей функции, не существующей утечки.
- vendor-team-ack-first.log52passed после первых двух real DB/API cases.
- vendor-team-ack-races.log68passed, прирост68-50=18: current/past receipt,
  helper/coordinator public invitation/accept, vendor/foreign/realguesttoken deny,
  same-version visible-content change, real owner transfer, unavailable/unassigned,
  public external booking, multi-deal grouping, public cancel preserving history,
  six waiting wedding-lock revocations + actual vendor-lock owner change409.
- Ownership/account/revocation flags в специальных races меняются SQL fixture,
  не объявлены новым public ownership API. Wedding locks наблюдаются реально,
  backend SQL execution не подменяется. Guest token реально redeemed.
- ackui-team-ack-current.log62passed:17 new summary cases +22vendor cases
  (20previous+2GET403) +23 existing audit31. Exact count62=17+22+23.
  Summary tests cover versions/body/ETag/receipt/past distinct/unsupported/denial/
  retry/no-empty/down/late response/offline/session expiry/EN.
- First direct summary unit run16passed/1failed: actual403 reason dropped by
  AsyncState caller; fixed explicit forbiddenText, not weakened assertion.
  This direct tool output is not presented as a nonexistent saved log.
- full-team-ack-current.log1185passed/2failed frontend: old planning tests selected
  global alert, new malformed-summary fixture added another. Scope tightened to
  actual planning form with same error text/draft assertions; no suppressed alerts
  or weakened API fixture. Backend not reached in that failed full run.
- Final full-team-ack-final.log: fresh tili_codex_teamackfinal_20260930_test plus
  real RedisDB13, init.sh exit0;86frontendfiles/1187tests,111backendfiles/1432tests,
  no skipped/types/lint/build/contracts passed. Deltafrontend1187-1168=19
  (17summary+2vendor403); deltabackend1432-1414=18 real API cases. App/backend
  code не менялся после final; последующие docs/external browser runner отдельно.
- Actual Chromium teamack2:16passed, page_errors empty, runner exit0. Actual
  vendor checkbox/POST -> couple receipt -> owner revision -> pending with separate
  past history -> new vendor acknowledgment -> helper/coordinator read -> RU/EN ->
  offline/reconnect -> public booking cancellation -> member removal/GET404/reload.
  Helper membership comes from the explicit browser fixture; coordinator role is
  granted through actual owner PATCH. It does not prove vendor-only team access.
  Evidence C:/Тили-тили/.unlazy/wp03-team-ack-20260930/browser-evidence-teamack2/.
- Six region PNGs team320/390/1440, history390, team-en390, cancelled390 and
  viewport-team320 were visually inspected. Current runner verifies whole region
  above mobile navigation after scrolling, no horizontal overflow and unobstructed
  refresh hit target. Prior teamack1 screenshots included fixed navigation over
  lower rows; no product CSS change was needed, available page padding/scrolling
  exposes the complete region. No claim that arbitrary scroll positions never
  cross fixed navigation. Physical devices/provider delivery/external ack unverified.
  Runner stops its API/Vite/Python processes and removes private token fixture.

Scoped team ledger status then approve: ALL MET5; CRLF-aware git diff check
exit0. Intentional isolated teamack2 preview healthok/API3001, UI3000 timeline200.
No GitHub/production operations. Only this stage accepted locally, not full feature.

## Остаток

External guest-vendor and delegated company actors need real exact-version ack,
not_supported is not completion. T009 full versioned offline/access cleanup;
T006 individual event invitees/RSVP/transfers; T008 event management; final whole
T010 SC/NFR and T011 feature commit/push/main. Все WP00–WP16 сохраняются.
Статус всего T007/WP03 остаётся open, этот отчёт не меняет объём.
