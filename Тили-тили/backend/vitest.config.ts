import { readFileSync } from 'node:fs'
import { defineConfig, configDefaults } from 'vitest/config'

/* Серийная группа (F6, шаг 8): проходы табличных задач и правка общего
 * справочника категорий делят состояние всей базы между файлами (FP-1) —
 * такие файлы идут по одному и после остальных, а не параллельно. Список
 * ведёт F6 (единственный владелец, до FINAL) в `vitest.serial.json`;
 * устройство прогона проверяет сторож `test/audit53.test.ts`.
 */
const SERIAL: string[] = JSON.parse(readFileSync(new URL('./vitest.serial.json', import.meta.url), 'utf8'))

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    /* Здесь почти все наборы ходят в ЖИВУЮ базу, и файлы идут параллельно:
     * тридцать восемь наборов делят один PostgreSQL. Пять секунд по
     * умолчанию рассчитаны на модульный тест без ввода-вывода — под
     * нагрузкой они дают ложные падения в случайном файле.
     *
     * Двадцать секунд, а не пятнадцать: у пула стоит `statement_timeout`
     * в 15 с, и настоящее зависание должно приходить понятной ошибкой
     * базы, а не таймаутом vitest, по которому не видно, что случилось. */
    testTimeout: 20_000,
    hookTimeout: 30_000,
    /* Покрытие всего исходного кода, а не только изменённых строк. До
     * 2026-09-24 инструмента в репозитории не было вовсе: ревью 016 меряло
     * покрытие своих правок внешней установкой, а общее число никто
     * никогда не видел. Сгенерированные файлы контракта исключены:
     * их не пишут руками, и их объём затопил бы остальное. */
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/contract/*.generated.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
    },
    /* `include` корня сюда не возвращать (R6-1): `extends: true` склеивает
     * корневую конфигурацию с конфигурацией проекта через `mergeConfig`,
     * а он МАССИВЫ конкатенирует, а не заменяет — корневой `include` дал бы
     * серийной группе `['test/**\/*.test.ts', ...SERIAL]` (все файлы), а
     * не-серийным путям — двойной проход. */
    projects: [
      {
        extends: true,
        test: {
          name: 'parallel',
          include: ['test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...SERIAL],
        },
      },
      {
        extends: true,
        test: {
          name: 'serial',
          include: SERIAL,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
