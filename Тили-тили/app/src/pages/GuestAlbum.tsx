import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router'
import { AlbumPhotoImage } from '@/components/AlbumPhotoImage'
import { AsyncState, ready } from '@/components/AsyncState'
import { getGuestAlbum, getGuestAlbumImage, uploadGuestAlbumPhoto } from '@/lib/api/album'
import { ApiError, newIdempotencyKey } from '@/lib/api/client'
import { guestToken } from '@/lib/api/guest'
import type { MediaProgress } from '@/lib/api/media'
import { explainError, useApi } from '@/lib/api/useApi'
import { guestDayGeneration, guestDayIsCurrent, subscribeGuestDayChanges } from '@/lib/guestDayOffline'
import { t } from '@/lib/i18n'

export default function GuestAlbum() {
  const generation = useSyncExternalStore(subscribeGuestDayChanges, guestDayGeneration)
  const token = guestToken()
  return <main className="px-5 pt-6 pb-16 space-y-4">
    <Link to="/invite" className="press inline-flex min-h-11 items-center underline">{t('К приглашению')}</Link>
    <h1 className="text-2xl font-semibold">{t('Фотоальбом гостей')}</h1>
    {token ? <GuestAlbumContent key={generation} token={token} generation={generation} />
      : <p role="status">{t('Нужна ссылка-приглашение')}</p>}
  </main>
}

function GuestAlbumContent({ token, generation }: { token: string; generation: number }) {
  const assertCurrent = useCallback(() => {
    if (!guestDayIsCurrent(token, generation) || guestToken() !== token) throw new DOMException('Invitation changed', 'AbortError')
  }, [token, generation])
  const load = useCallback((photoId: string, signal: AbortSignal) =>
    getGuestAlbumImage(token, photoId, { assertCurrent, signal }), [token, assertCurrent])
  const album = useApi(() => getGuestAlbum(token, { assertCurrent }), [token, assertCurrent])
  const [file, setFile] = useState<{ value: File; key: string } | null>(null)
  const [consent, setConsent] = useState(false)
  const [progress, setProgress] = useState<MediaProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const operation = useRef<AbortController | null>(null)
  const sentUpload = useRef<string | null>(null)
  useEffect(() => () => operation.current?.abort(), [])

  async function submit() {
    if (!file || !consent || operation.current || !album.data?.uploadEnabled) return
    const controller = new AbortController()
    operation.current = controller
    setError(null)
    setDone(false)
    try {
      const result = await uploadGuestAlbumPhoto(token, file.value, file.key, sentUpload.current, {
        assertCurrent, signal: controller.signal, onProgress: setProgress, onSent: id => { sentUpload.current = id },
      })
      if (result.state !== 'ready') throw new ApiError('http', 409, result.errorCode ?? 'media_processing_expired', t('Проверка не завершена'))
      setDone(true)
      setConsent(false)
      setFile(null)
      sentUpload.current = null
      if (input.current) input.current.value = ''
      album.reload()
    } catch (cause) {
      if (!controller.signal.aborted) {
        try { assertCurrent(); setError(explainError(cause)) } catch { /* invitation changed */ }
      }
    } finally {
      if (operation.current === controller) operation.current = null
      if (!controller.signal.aborted) setProgress(null)
    }
  }

  const photos = album.data?.photos ?? []
  return <>
    <AsyncState q={album} />
    {ready(album) && (album.data?.uploadEnabled ? (
      <form className="card p-4 space-y-3" onSubmit={event => { event.preventDefault(); void submit() }}>
        <label className="block text-[13px] font-semibold">
          {t('Выбрать фото для альбома')}
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" disabled={!!progress} className="block mt-2 w-full text-[12px]" onChange={event => {
            const selected = event.currentTarget.files?.[0]
            setFile(selected ? { value: selected, key: newIdempotencyKey() } : null)
            sentUpload.current = null
            setConsent(false)
            setError(null)
            setDone(false)
          }} />
        </label>
        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" checked={consent} disabled={!!progress} onChange={event => setConsent(event.target.checked)} />
          {t('Согласен на публикацию этой фотографии в альбоме свадьбы')}
        </label>
        <button type="submit" disabled={!file || !consent || !!progress} className="press min-h-11 rounded-full grad px-4 text-[13px] font-semibold text-[var(--on-grad)] disabled:opacity-50">
          {progress === 'uploading' ? t('Загружаем фотографию…') : progress === 'scanning' ? t('Проверяем фотографию…') : t('Отправить фото')}
        </button>
        {error && <p role="alert" className="text-[13px] text-[var(--rose-ink)]">{error}</p>}
        {done && <p role="status" className="text-[13px]">{t('Фото отправлено паре на модерацию')}</p>}
      </form>
    ) : <p className="text-[13px]">{t('Загрузка фото пока не подключена')}</p>)}
    {ready(album) && photos.length === 0 && <p className="text-[13px]">{t('Кадров пока нет')}</p>}
    {photos.length > 0 && <div className="grid grid-cols-3 gap-2.5">
      {photos.map(photo => <div key={photo.id} className="aspect-square overflow-hidden rounded-[16px]">
        <AlbumPhotoImage photo={photo} load={load} alt={t('Фотография из альбома')} />
      </div>)}
    </div>}
  </>
}
