import { readFileSync } from 'node:fs'

/*
 * Чтение исходников проекта в тестах.
 *
 * Через node:fs, а не через vite-суффикс `?raw`: для CSS `?raw` возвращает
 * пустую строку, и проверки вида «в стилях больше нет X» проходили бы всегда,
 * ничего не проверяя. Здесь пустой файл — это ошибка, а не молчаливый успех.
 */
export function projectFile(relPath: string): string {
  const text = readFileSync(relPath, 'utf8')
  if (text.trim().length === 0) throw new Error(`пустой файл: ${relPath} — проверка была бы холостой`)
  return text
}
