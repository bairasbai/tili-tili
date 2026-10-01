import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, isAuthorized } from './client'
import { t } from '../i18n'

/*
 * Один способ показывать серверные данные на экране.
 *
 * До этого хука каждый экран изобретал бы свои три состояния — грузится,
 * ошибка, данные — и они разъехались бы по формулировкам и поведению уже на
 * третьем экране. Здесь они заданы один раз, вместе с правилом: пока данных
 * нет, экран честно говорит, что происходит, а не показывает пустоту.
 */

export interface AsyncData<T> {
  data: T | null
  /** Первая загрузка. Обновление уже показанных данных сюда не попадает. */
  loading: boolean
  /**
   * Перечитывание за спиной у показанного ответа: с `reload()` до прихода
   * свежего. Данные на экране в это окно — прежние, и действие по ним ждёт
   * свежих: сдвиг тайминга по старым часам уходил вторым POST, а список,
   * собранный из старого ответа, откатывал только что принятую правку
   * (ревью R3-01, R3-02). При первой загрузке здесь `false` — это `loading`.
   */
  refreshing: boolean
  /** Текст для человека, не код ошибки. Null — всё в порядке. */
  error: string | null
  /** Machine-readable failure for offline/refusal decisions; never infer from translated text. */
  failure?: ApiError | null
  /** Отказ по правам: раздел закрыт роли. Повторять бессмысленно. */
  forbidden: boolean
  /** Слова сервера при отказе по правам (403) — чем именно закрыт раздел (R-284). Нет отказа — `undefined`. */
  forbiddenText?: string
  reload: () => void
}

/** Сообщение для человека: «сервер лежит» и «сервер отказал» — разные вещи. */
export function explainError(e: unknown): string {
  /* Текст сервера — через словарь: известные отказы («Слот уже занят»…)
     переводятся, неизвестные остаются как есть (ревью 015). */
  if (e instanceof ApiError) return e.isDown ? t('Сервер недоступен. Попробуйте позже') : t(e.message)
  return t('Что-то пошло не так')
}

/*
 * Экран свадьбы без свадьбы (ревью 015, FB6).
 *
 * У вошедшего свадьбы может не быть: подрядчик, новый аккаунт, партнёр
 * отменил. Запросы бюджета, гостей, тайминга, маршрутов и вишлиста раньше
 * отвечали на это `Promise.resolve([])` — и экран показывал «0 гостей»,
 * «0 ₽» как факт (инвариант 13: ноль — не «неизвестно»). Теперь это отказ
 * со своими словами; `AsyncState` узнаёт его по коду и ведёт в квиз.
 * Ключ словаря — русская строка, перевод при показе.
 */
export const NO_WEDDING = 'Свадьбы пока нет — заведите её, и здесь появятся данные'
export const NO_WEDDING_CODE = 'no_wedding'
/** Без входа свадьбы нет по другой причине — и ответ другой: «войдите», а не «заведите». */
export const SIGN_IN_FIRST = 'Войдите, чтобы увидеть свою свадьбу'
export function noWedding<T = never>(): Promise<T> {
  if (!isAuthorized()) return Promise.reject(new ApiError('http', 401, 'unauthorized', t(SIGN_IN_FIRST)))
  return Promise.reject(new ApiError('http', 0, NO_WEDDING_CODE, t(NO_WEDDING)))
}

/**
 * Загрузка данных с сервера.
 *
 * `deps` перечисляет то, от чего зависит запрос: сменился город или категория —
 * данные перезапрашиваются. Ответ устаревшего запроса отбрасывается: без этого
 * быстрый перебор фильтров оставляет на экране результат того запроса, который
 * ушёл раньше, но вернулся позже.
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: readonly unknown[]): AsyncData<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [failure, setFailure] = useState<ApiError | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [forbiddenText, setForbiddenText] = useState<string | undefined>(undefined)
  const [tick, setTick] = useState(0)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fetcher, deps)
  /* Какой запрос уже показан: по нему отличаем смену адреса от перечитывания. */
  const lastRun = useRef<typeof run | null>(null)
  /* Есть ли на экране ответ этого запроса. Ссылка, а не `data` в зависимостях
     эффекта: от смены данных перечитывать не надо. */
  const settled = useRef(false)
  /* Чей ответ показан: запрос и его номер. `refreshing` выводится сравнением
     с текущими, а не выставляется в эффекте: `reload()` и снятие «занято»
     после действия приходят одним рендером, и флаг, поднятый эффектом, дал бы
     кадр с открытой кнопкой между ними. */
  const [shown, setShown] = useState<{ run: typeof run; tick: number } | null>(null)

  useEffect(() => {
    let alive = true
    /*
     * Сменился запрос — старые данные сбрасываем: они относятся к другому
     * адресу. Без этого экран подрядчика, открытый по ссылке на удалённую
     * анкету, показывал карточку того, кого смотрели до неё, вместе с живой
     * кнопкой «Добавить в свадьбу»: проверка «анкета не пришла» не срабатывала,
     * потому что в состоянии лежала чужая.
     *
     * А вот на `reload()` того же запроса данные остаются: список перечитывают
     * после каждой галочки, и очистка давала бы мигание на ровном месте.
     * И `loading` при этом не поднимается — так обещает `AsyncData.loading`,
     * а до ревью RF-02 код делал иначе: минутный опрос дня X на секунды
     * превращал карточку «СЕЙЧАС» в «Загружаем…» и выключал «+15 мин».
     * После отказа данных нет, и «Повторить» по-прежнему показывает загрузку.
     */
    if (lastRun.current !== run) {
      lastRun.current = run
      settled.current = false
      setData(null)
      setShown(null)
    }
    if (!settled.current) setLoading(true)
    setError(null)
    setFailure(null)
    setForbidden(false)
    setForbiddenText(undefined)
    run()
      .then(v => { if (alive) { settled.current = true; setData(v); setShown({ run, tick }); setLoading(false) } })
      .catch(e => {
        if (!alive) return
        /* И при отказе тоже: показывать данные рядом с сообщением об ошибке
           значит утверждать, что они актуальны. */
        settled.current = false
        setFailure(e instanceof ApiError ? e : null)
        setData(null)
        setShown(null)
        /* Слова сервера, не только флаг: «Нужно согласие…» и «Кабинет доступен
           только подрядчику» — разные отказы, и экран должен называть свой,
           а не молчать под видом пустой выдачи (R-284). */
        if (e instanceof ApiError && e.status === 403) { setForbidden(true); setForbiddenText(t(e.message)) }
        else setError(explainError(e))
        setLoading(false)
      })
    return () => { alive = false }
  }, [run, tick])

  const reload = useCallback(() => setTick(n => n + 1), [])
  /* Показан ответ, но не на этот запрос: свежий ещё в пути. */
  const refreshing = shown !== null && (shown.run !== run || shown.tick !== tick)
  return { data, loading, refreshing, error, failure, forbidden, forbiddenText, reload }
}
