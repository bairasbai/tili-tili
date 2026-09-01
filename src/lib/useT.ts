import { useStore } from './store'
import { EN } from './i18n.en'

/* Хук-вариант t(): подписывает компонент на смену языка из store. */
export function useT() {
  const { lang } = useStore()
  return (s: string) => (lang === 'en' ? (EN[s] ?? s) : s)
}
