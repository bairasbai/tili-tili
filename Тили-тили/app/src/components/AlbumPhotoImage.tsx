import { useEffect, useRef, useState } from 'react'
import type { AlbumPhoto } from '@/lib/api/album'
import { t } from '@/lib/i18n'

type LoadImage = (id: string, signal: AbortSignal) => Promise<Blob>

function CheckedImage({ id, load, alt }: { id: string; load: LoadImage; alt: string }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')
  const [result, setResult] = useState<{ src: string | null } | null>(null)

  useEffect(() => {
    if (visible) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setVisible(true)
    })
    if (anchor.current) observer.observe(anchor.current)
    return () => observer.disconnect()
  }, [visible])

  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    let objectUrl: string | undefined
    void load(id, controller.signal).then(blob => {
      if (controller.signal.aborted) return
      if (blob.type !== 'image/webp' || blob.size > 10 * 1024 * 1024) throw new Error('Invalid album preview')
      objectUrl = URL.createObjectURL(blob)
      setResult({ src: objectUrl })
    }).catch(() => { if (!controller.signal.aborted) setResult({ src: null }) })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [id, load, visible])

  return <span ref={anchor} className="block aspect-square w-full bg-[var(--track)]">
    {result?.src ? <img src={result.src} alt={alt} className="w-full h-full object-cover" />
      : result ? <span className="grid h-full place-items-center px-1 text-[10px]">{t('Кадр недоступен')}</span> : null}
  </span>
}

export function AlbumPhotoImage({ photo, load, alt }: { photo: AlbumPhoto; load: LoadImage; alt: string }) {
  return photo.managed ? <CheckedImage id={photo.id} load={load} alt={alt} />
    : <img src={photo.url} alt={alt} referrerPolicy="no-referrer" loading="lazy" className="w-full h-full object-cover" />
}
