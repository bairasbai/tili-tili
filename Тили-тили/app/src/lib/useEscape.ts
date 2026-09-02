import { useEffect } from 'react'

/**
 * Закрытие оверлея по Escape.
 * Шторки закрываются тапом по подложке — но подложка это `div`, до неё не
 * добраться с клавиатуры. На десктопе (приложение адаптивно от 900px) диалог
 * без Escape становится ловушкой.
 */
export function useEscape(onClose: () => void, active = true) {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, active])
}
