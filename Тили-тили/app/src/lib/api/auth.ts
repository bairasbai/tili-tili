import { api, ApiError, saveTokens, url } from './client'
import { disableDevicePush } from '../push'

/*
 * Свой профиль.
 *
 * Нужен там, где надо отличить себя от собеседника: в чате сообщение
 * выравнивается по автору, а `senderId` — это идентификатор пользователя.
 * Разбирать его из токена на клиенте было бы короче, но токен — не источник
 * профиля: имя и язык меняются без перевыпуска.
 */
export const getMe = () => api.get('/users/me')

/**
 * Настройки профиля: имя, язык, зона, четыре канала push и тихие часы.
 *
 * Пропущенное поле сервер не трогает — можно слать только изменённое.
 * Тихие часы выключаются пустым окном (`22:00–22:00`), а не отсутствием
 * полей: «не прислали» на сервере значит «оставить как было».
 */
export const patchMe = (patch: {
  name?: string
  lang?: 'ru' | 'en'
  tz?: string
  push?: Partial<Record<'tasks' | 'chats' | 'deals' | 'tips', boolean>>
  quietHours?: { from: string; to: string }
}) => api.patch('/users/me', patch)

/** Устройства, с которых входили. `current` — то, где человек прямо сейчас. */
export const getSessions = () => api.get('/users/me/sessions')

/** Завершить чужую сессию. Свою гасить этим путём нельзя — это выход. */
export const endSession = (sessionId: string) =>
  api.delete(url('/users/me/sessions/{sessionId}', { sessionId }))

/**
 * Push-подписки человека на всех устройствах (контракт v0.29.0, фича 005).
 *
 * Наружу уходит только хост push-службы и дата: полный `endpoint` — секрет
 * устройства. `endpoint` этого устройства передаётся строкой запроса, чтобы
 * сервер отметил его подписку как `mine`; без него «это устройство» сервер
 * назвать не может, и экран его не называет.
 */
export const getPushSubscriptions = (endpoint: string | null) =>
  api.get((endpoint
    ? `/users/me/push-subscriptions?endpoint=${encodeURIComponent(endpoint)}`
    : '/users/me/push-subscriptions') as '/users/me/push-subscriptions')

/** Снять push на ВСЕХ устройствах: пути «снять чужую по одной» в контракте нет. */
export const deleteAllPushSubscriptions = () => api.delete('/users/me/push-subscriptions')

/** Ключ sessionStorage с кодом приглашения в команду, отложенным до входа (D1-21). */
export const JOIN_CODE_KEY = 'tt_join_code'

/**
 * Забыть аккаунт на этом устройстве: токены и всё, что лежало рядом
 * (`tt_wedding_id`, дата, избранное, черновики). Только после того, как
 * сервер сделал своё: чистить раньше значит оставить живую сессию и потерять
 * причину отказа.
 */
/* Свойства устройства (тема, язык, город) — не данные человека: они живут
   и после выхода, как настройки телефона (CLAUDE.md §5 п. 12). */
const DEVICE_KEYS = ['tt_theme', 'tt_lang', 'tt_city', 'tt_city_region'] as const

export function forgetLocally(): void {
  saveTokens(null)
  try {
    const keep = DEVICE_KEYS.map(k => [k, localStorage.getItem(k)] as const)
    localStorage.clear()
    for (const [k, v] of keep) if (v !== null) localStorage.setItem(k, v)
  } catch { /* приватный режим */ }
}

/**
 * Выйти из аккаунта — со всех устройств, включая это (ревью D1-20, D4-05, D4-06).
 *
 * Три шага, и у каждого своя причина:
 *
 * 1. Push этого устройства снимается ПЕРВЫМ, пока токен ещё жив: подписка
 *    браузера привязана к endpoint, а не к человеку. Общий телефон: A вышел,
 *    вошёл B — сервер продолжал слать push A на тот же endpoint, и B читал
 *    первые строки чужой переписки и суммы чужих сделок. Отписка идёт только
 *    по своему endpoint: подписки других устройств A остаются.
 * 2. `DELETE /users/me/sessions` гасит все ЧУЖИЕ сессии и намеренно оставляет
 *    текущую: на сервере это «выгнать постороннего, не выгоняя себя». Поэтому
 *    дальше находим свою в списке (`current`) и гасим отдельно — последней и
 *    по идентификатору из списка: угадывать её нечем, а погасив раньше, мы
 *    потеряли бы доступ к самому списку.
 * 3. Локальное чистится после ответа сервера. Сервер не ответил — уйти всё
 *    равно даём, иначе человек заперт в аккаунте, из которого хочет выйти;
 *    живая сессия при этом остаётся, и это честнее, чем не пустить его на
 *    экран входа.
 *
 * Общая для «Выйти со всех устройств» в настройках и «Выйти из аккаунта» на
 * экране «Мы»: вторая кнопка раньше была `nav('/auth')` — ни запроса, ни
 * очистки, сессия жила ещё 30 дней, а следующий вошедший на этом телефоне
 * видел чужую дату, избранное и свадьбу.
 */
export async function signOutEverywhere(): Promise<void> {
  try {
    await disableDevicePush().catch(() => undefined)
    await api.delete('/users/me/sessions')
    const mine = (await api.get('/users/me/sessions'))?.find(x => x.current)
    if (mine?.id) await api.delete(url('/users/me/sessions/{sessionId}', { sessionId: mine.id }))
  } catch (e) {
    /* см. шаг 3 — но только когда сервер НЕ СМОГ ответить. Отказ по делу
       (4xx, кроме 401 — сессия уже мертва) — не выход: токены остаются, а
       причина уходит экрану словами; иначе кнопка молча делала вид, что
       вышла, при живой сессии (ревью 015, FA2). */
    if (refusedOnPurpose(e)) throw e
  }
  forgetLocally()
}

/** Сервер ответил отказом по делу, а не упал: 4xx, кроме 401 (сессии уже нет — уходить есть от чего). */
function refusedOnPurpose(e: unknown): boolean {
  return e instanceof ApiError && e.kind === 'http' && e.status !== 401 && e.status < 500
}

/**
 * Выйти только на этом устройстве (фича 007, настройки подрядчика).
 *
 * Те же шаги, что у `signOutEverywhere`, без гашения чужих сессий: push этого
 * устройства снимается первым, пока токен жив (D4-06); своя сессия находится
 * в списке по `current` и гасится по идентификатору — `DELETE
 * /users/me/sessions/{id}`, так приложение и выходит (ERR-0233); локальное
 * чистится после ответа. Сервер не ответил — уйти всё равно даём, как и при
 * выходе со всех устройств: запереть человека в аккаунте хуже живой сессии.
 */
export async function signOutHere(): Promise<void> {
  try {
    await disableDevicePush().catch(() => undefined)
    const mine = (await api.get('/users/me/sessions'))?.find(x => x.current)
    if (mine?.id) await api.delete(url('/users/me/sessions/{sessionId}', { sessionId: mine.id }))
  } catch (e) {
    /* см. шаг 3 у signOutEverywhere; отказ по делу — наружу (FA2) */
    if (refusedOnPurpose(e)) throw e
  }
  forgetLocally()
}

/**
 * Отозвать согласие на обработку данных (ревью D1-23).
 *
 * На сервере это одна транзакция: согласие помечается отозванным, аккаунт —
 * удалённым (стирается через 30 дней), все сессии гасятся. Живые сделки при
 * этом НЕ проверяются — в отличие от `DELETE /users/me` с его 409
 * `active_deals`. Экран говорит ровно это.
 */
export const withdrawConsent = () => api.delete('/users/me/consent')

/** Применить чужой реферальный код: один раз на аккаунт, 404 — кода нет, 409 — уже применён или свой. */
export const applyReferralCode = (code: string) =>
  api.post(url('/referral/{code}/apply', { code }))

/**
 * Свой реферальный код, число приглашённых и начисленное.
 *
 * Код выдаёт сервер (вида `ТИЛИ-ИМЯ`). Экран показывал написанный в разметке
 * «ТИЛИ-АЛИНА» и «приглашено: 2» — код чужой выдуманной пары, который кнопка
 * «Копировать» честно клала человеку в буфер обмена.
 */
export const getReferral = () => api.get('/users/me/referral')
