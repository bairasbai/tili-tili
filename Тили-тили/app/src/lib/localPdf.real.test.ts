// @vitest-environment node
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createTextPdf } from './localPdf'
import { seatingPdfBody } from './seatingPdf'
import { setI18nLang, t } from './i18n'
import type { SeatingRead } from './useSeating'
import { contractPdfBody, guestListPdfBody, programPdfBody } from './documentPdf'

it.each(['ru', 'en'] as const)('generates actual contract, program and guest PDFs in %s without HTML sinks', async language => {
  setI18nLang(language)
  const font = new Uint8Array(readFileSync(resolve('public/fonts/pdf/ProjectSans.ttf')))
  const hostile = '<script>alert(1)</script> <a href="javascript:alert(2)">Әлиә Ғәлиева</a>'
  const documents = [
    { name: 'contract', title: t('Договор с фотографом'), body: contractPdfBody({ city: 'Уфа', customer: 'Анна "Иванова"', passport: 'TEST PASSPORT', vendor: hostile, date: '14.06.2027', amount: '90 000 ₽' }, '03.11.2026') },
    { name: 'program', title: t('Программа свадьбы'), body: programPdfBody([{ time: '14:00', name: 'Әлиә Ғәлиева', loc: 'Уфа', who: 'Coordinator' }], '14.06.2027') },
    { name: 'guests', title: t('Список гостей'), body: guestListPdfBody(Array.from({ length: 200 }, (_, i) => ({ name: `${i + 1}. Әлиә Ғәлиева`, status: i % 2 ? 'yes' : 'no', phone: 'PRIVATE_PHONE', diet: 'PRIVATE_DIET' }))) },
  ]
  for (const document of documents) {
    expect(document.body).not.toContain('PRIVATE_')
    const bytes = await createTextPdf(document.title, document.body, font)
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('%PDF')
    const evidence = process.env.LOCAL_PDF_EVIDENCE_DIR
    if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(resolve(evidence, `${document.name}-${language}.pdf`), bytes) }
  }
}, 30_000)

it.each(['ru', 'en'] as const)('generates an actual multi-page A3 seating PDF in %s', async language => {
  setI18nLang(language)
  const font = new Uint8Array(readFileSync(resolve('public/fonts/pdf/ProjectSans.ttf')))
  const data = {
    generation: 1,
    tables: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, name: `${t('Стол')} ${i + 1}`, capacity: 8 })),
    guests: Array.from({ length: 161 }, (_, i) => ({ id: `g${i}`, name: `${i + 1}. Әлиә Ғәлиева Guest`, status: 'yes', tableId: i < 160 ? `t${Math.floor(i / 8)}` : null,
      phone: 'PRIVATE_PHONE', diet: 'PRIVATE_DIET', token: 'PRIVATE_TOKEN' })),
  } as unknown as SeatingRead
  const body = seatingPdfBody(data)
  expect(body).not.toContain('PRIVATE_')
  expect(body).toContain('161. Әлиә Ғәлиева Guest')
  const bytes = await createTextPdf(t('Рассадка'), body, font, 'A3')
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('%PDF')
  const evidence = process.env.LOCAL_PDF_EVIDENCE_DIR
  if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(resolve(evidence, `seating-${language}.pdf`), bytes) }
}, 30_000)
