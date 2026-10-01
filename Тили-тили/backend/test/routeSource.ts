import ts from 'typescript'

/** Read route registrations and only the local helpers they actually call.
 * Parsing source never executes it. Bindings are resolved in lexical scope. */
export function routeSources(text: string): { method: string; path: string; text: string }[] {
  const source = ts.createSourceFile('routes.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const routes: { method: string; path: string; text: string }[] = []
  function bindings(node: ts.Node): Map<string, ts.Node> {
    const result = new Map<string, ts.Node>()
    for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
      if (ts.isForOfStatement(scope) && ts.isVariableDeclarationList(scope.initializer)) {
        const pattern = scope.initializer.declarations[0]?.name
        if (pattern && ts.isArrayBindingPattern(pattern)) for (const element of pattern.elements) {
          if (ts.isBindingElement(element) && ts.isIdentifier(element.name) && !result.has(element.name.text)) result.set(element.name.text, element)
        }
      }
      if (ts.isFunctionDeclaration(scope) || ts.isArrowFunction(scope) || ts.isFunctionExpression(scope)) {
        for (const parameter of scope.parameters) if (ts.isIdentifier(parameter.name) && !result.has(parameter.name.text)) result.set(parameter.name.text, parameter)
      }
      if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue
      for (const statement of scope.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name && !result.has(statement.name.text)) result.set(statement.name.text, statement)
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer && !result.has(declaration.name.text)) result.set(declaration.name.text, declaration.initializer)
        }
      }
    }
    return result
  }
  function stringValue(node: ts.Node, seen = new Set<ts.Node>(), values = new Map<ts.Node, ts.Node>()): string | undefined {
    if (seen.has(node)) return undefined
    seen.add(node)
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isIdentifier(node)) {
      const binding = bindings(node).get(node.text)
      const value = binding ? values.get(binding) ?? binding : undefined
      return value ? stringValue(value, seen, values) : undefined
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = stringValue(node.left, new Set(seen), values), right = stringValue(node.right, new Set(seen), values)
      if (left !== undefined && right !== undefined) return left + right
    }
    if (ts.isTemplateExpression(node)) {
      let result = node.head.text
      for (const span of node.templateSpans) {
        const value = stringValue(span.expression, new Set(seen), values)
        if (value === undefined) return undefined
        result += value + span.literal.text
      }
      return result
    }
    return undefined
  }
  function withHelpers(node: ts.Node, seen = new Set<ts.Node>()): string {
    if (seen.has(node)) return ''
    seen.add(node)
    const parts = [node.getText(source)]
    function calls(child: ts.Node): void {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
        const helper = bindings(child).get(child.expression.text)
        if (helper && (ts.isFunctionDeclaration(helper) || ts.isArrowFunction(helper) || ts.isFunctionExpression(helper))) parts.push(withHelpers(helper, seen))
      }
      ts.forEachChild(child, calls)
    }
    ts.forEachChild(node, calls)
    return parts.join('\n')
  }
  function visit(node: ts.Node, values = new Map<ts.Node, ts.Node>()): void {
    // Expand only literal finite route tables; never evaluate application code
    // or guess the values of dynamic route registrations.
    if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
      const declaration = node.initializer.declarations[0]
      const table = ts.isAsExpression(node.expression) ? node.expression.expression : node.expression
      if (declaration && ts.isArrayBindingPattern(declaration.name) && ts.isArrayLiteralExpression(table)) {
        for (const row of table.elements) {
          if (!ts.isArrayLiteralExpression(row)) continue
          const scoped = new Map(values)
          declaration.name.elements.forEach((element, index) => {
            if (ts.isBindingElement(element) && ts.isIdentifier(element.name) && row.elements[index]) scoped.set(element, row.elements[index]!)
          })
          visit(node.statement, scoped)
        }
        return
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'app' &&
      ['get', 'post', 'put', 'patch', 'delete'].includes(node.expression.name.text) && node.arguments[0]) {
      const path = stringValue(node.arguments[0], new Set(), values)
      if (path !== undefined) routes.push({ method: node.expression.name.text, path, text: withHelpers(node) })
    }
    ts.forEachChild(node, child => visit(child, values))
  }
  visit(source)
  return routes
}
