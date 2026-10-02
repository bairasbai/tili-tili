import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { CATEGORY_BRIEFS, type BriefField, type CategoryBrief } from '../../../backend/src/orders/catalog'
import { EN_ORDERS } from './i18n.en.orders'
import { EN_RESOURCES } from './i18n.en.resources'

const sourcePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))
function source(relative: string): ts.SourceFile {
  const path = sourcePath(relative)
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

/** Read dictionaries as data. Importing the production EN object would also
 * import EN_ORDERS after integration and could hide a missing new entry. */
function existingTranslations(): Record<string, string> {
  const translations: Record<string, string> = {}
  for (const path of ['./i18n.en.ts', './i18n.en.data.ts']) {
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /^EN(?:_DATA.*)?$/.test(node.name.text)
        && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        for (const property of node.initializer.properties) {
          if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name) && ts.isStringLiteral(property.initializer)) {
            translations[property.name.text] = property.initializer.text
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source(path))
  }
  return translations
}

/** Only possible text RESULTS are translation keys. Conditional predicates
 * such as kind === 'supply' are domain IDs, not user-visible wording. */
function literalResults(node: ts.Node | undefined): string[] {
  if (!node) return []
  if (ts.isStringLiteralLike(node)) return [node.text]
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return literalResults(node.expression)
  if (ts.isConditionalExpression(node)) return [...literalResults(node.whenTrue), ...literalResults(node.whenFalse)]
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
    return [...literalResults(node.left), ...literalResults(node.right)]
  }
  return []
}
function componentLabels(tree: ts.SourceFile): string[] {
  const labels = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (['t', 'key'].includes(node.expression.text)) literalResults(node.arguments[0]).forEach(label => labels.add(label))
      // Actual part-field descriptor labels live in f(key, label, type,...).
      if (node.expression.text === 'f') literalResults(node.arguments[1]).forEach(label => labels.add(label))
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return [...labels]
}
function fieldLabels(fields: readonly BriefField[]): string[] { return fields.flatMap(field => [field.label, ...(field.options ?? [])]) }
function catalogLabels(category: CategoryBrief): string[] {
  return [category.label, ...fieldLabels(category.fields), ...(category.subtypes ?? []).flatMap(subtype => [subtype.label, ...fieldLabels(subtype.fields)])]
}
const existing = existingTranslations()
const additions: Readonly<Record<string, string>> = { ...EN_ORDERS, ...EN_RESOURCES }
const combined: Readonly<Record<string, string>> = { ...additions, ...existing }
function requireEnglish(labels: readonly string[]) {
  for (const label of labels) {
    const translation = combined[label]
    expect(translation, `Missing English translation for ${JSON.stringify(label)}`).toBeTypeOf('string')
    expect(translation?.trim(), `Empty translation for ${JSON.stringify(label)}`).toBeTruthy()
    expect(translation, `Russian fallback remains for ${JSON.stringify(label)}`).not.toMatch(/[А-Яа-яЁё]/)
    if (!existing[label]) expect(additions[label], `New label must have an explicit domain translation: ${JSON.stringify(label)}`).toBe(translation)
  }
}

describe('English order wording follows the actual catalog and UI', () => {
  it.each(CATEGORY_BRIEFS.map(category => [category.categoryId, category] as const))('covers every %s label, optional field, subtype and selectable value', (_id, category) => {
    requireEnglish(catalogLabels(category))
  })

  it('covers actual OrderDraft literal translations, conditional alternatives and part/kind descriptor labels', () => {
    const labels = componentLabels(source('../components/OrderDraft.tsx'))
    expect(labels).toContain('Состав заказа')
    expect(labels).toContain('Сохранить работу')
    expect(labels).toContain('Добавить в черновик')
    expect(labels).toContain('Доставка от')
    expect(labels).toContain('Работа на мероприятии')
    expect(labels).not.toContain('deliverable')
    expect(labels).not.toContain('true')
    requireEnglish(labels)
  })

  it('covers the actual optional resource editor without turning declared capacity into availability', () => {
    const labels = componentLabels(source('../components/VendorResources.tsx'))
    expect(labels).toContain('Ресурсы компании')
    expect(labels).toContain('Учтено в обязательствах:')
    expect(labels).toContain('Второе повторение')
    requireEnglish(labels)
    expect(EN_RESOURCES['Необязательный учёт людей, оборудования и вместимости. Запись ресурса не подтверждает свободное время, бронь или готовность.']).toContain('does not confirm availability, a booking or readiness')
    expect(EN_RESOURCES['Старые обязательства сохраняются при смене режима.']).toContain('preserved')
    expect(EN_RESOURCES['Часовой пояс не выбран. Местное время окон пока неизвестно.']).toContain('unknown')
  })

  const termsPath = sourcePath('../components/OrderTerms.tsx')
  it.skipIf(!existsSync(termsPath))('covers the current OrderTerms component once its owned source exists', () => {
    const labels = componentLabels(source('../components/OrderTerms.tsx'))
    expect(labels.length, 'Terms controls must have identifiable translated wording').toBeGreaterThan(0)
    requireEnglish(labels)
  })

  it('distinguishes rendered conditional text from non-translated business predicates', () => {
    const tree = ts.createSourceFile('conditional.tsx', "t(kind === 'supply' ? 'Поставка' : 'Готовый результат'); key('Не указано'); f('quantity', 'Количество', 'integer')", ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    expect(componentLabels(tree)).toEqual(['Поставка', 'Готовый результат', 'Не указано', 'Количество'])
  })

  it('keeps unknown, explicit yes/no and draft completion semantically distinct', () => {
    expect(combined['Не указано']).toBe('Not specified')
    expect(combined['Да']).toBe('Yes'); expect(combined['Нет']).toBe('No')
    expect(combined['Черновик сохранён']).toBe('Draft saved')
    expect(combined['Отменено в черновике']).toBe('Cancelled in the draft')
    expect(combined['Необязательный черновик пожеланий и работ. Он не меняет цену, бронь или договор и не подтверждает наличие или готовность.']).toContain('does not change the price, booking or contract, or confirm availability or readiness')
  })

  it('keeps sales/delivery separate from floral installation and childcare separate from entertainment', () => {
    const flowers = CATEGORY_BRIEFS.find(category => category.categoryId === 'florist')!, children = CATEGORY_BRIEFS.find(category => category.categoryId === 'nanny')!
    const shop = flowers.subtypes!.find(subtype => subtype.id === 'shop')!, installation = flowers.subtypes!.find(subtype => subtype.id === 'installation')!
    const supervision = children.subtypes!.find(subtype => subtype.id === 'supervision')!, entertainment = children.subtypes!.find(subtype => subtype.id === 'entertainment')!
    expect(combined[shop.label]).toBe('Flower sales and delivery')
    expect(combined[installation.label]).toBe('Venue floral installation')
    // A supply can be collected rather than delivered; the kind label must
    // not silently promise transport which the draft leaves optional.
    expect(combined['Поставка']).toBe('Supply')
    expect(combined[supervision.label]).toBe('Child supervision')
    expect(combined[entertainment.label]).toBe('Entertainment program')
    expect(combined[supervision.label]).not.toBe(combined[entertainment.label])
    expect(combined['Информация об аллергенах от исполнителя']).toContain('supplied by the vendor')
    expect(combined['Полномочия для отдельного приглашения']).toContain('separate invitation')
  })

  it('distinguishes an optional terms proposal, recorded acceptance and an agreed version without claiming a changed payment or booking', () => {
    expect(combined['Предложенная редакция']).toBe('Proposed version')
    expect(combined['Согласованная редакция']).toBe('Agreed version')
    expect(combined['Принятие этой редакции пока не записано']).toBe('No acceptance of this version has been recorded yet')
    expect(combined['Принято со стороны пары']).toBe('Accepted on the couple’s side')
    expect(combined['Принято со стороны исполнителя']).toBe('Accepted on the vendor’s side')
    expect(combined['Необязательное согласование описания заказа. Принятие этой редакции не меняет оплату или бронь.']).toContain('does not change payments or the booking')
    expect(combined['Я ознакомился с этой редакцией и хочу принять её условия']).toBe('I have reviewed this version and want to accept its terms')
  })

  it('production dictionary contains only nonempty plain translations with no duplicate keys or executable category rules', () => {
    const tree = source('./i18n.en.orders.ts')
    const declaration = tree.statements.find(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === 'EN_ORDERS'))
    expect(declaration).toBeTruthy()
    if (!declaration || !ts.isVariableStatement(declaration)) throw new Error('Missing EN_ORDERS declaration')
    const dictionary = declaration.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === 'EN_ORDERS')?.initializer
    if (!dictionary || !ts.isObjectLiteralExpression(dictionary)) throw new Error('EN_ORDERS must be a plain dictionary')
    const names: string[] = []
    for (const property of dictionary.properties) {
      expect(ts.isPropertyAssignment(property)).toBe(true)
      if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name) || !ts.isStringLiteral(property.initializer)) throw new Error('Order dictionary must contain only literal string pairs')
      names.push(property.name.text); expect(property.initializer.text.trim()).not.toBe(''); expect(property.initializer.text).not.toMatch(/[А-Яа-яЁё]/)
    }
    expect(new Set(names).size).toBe(names.length)
    expect(tree.statements.some(statement => ts.isImportDeclaration(statement))).toBe(false)
  })
})
