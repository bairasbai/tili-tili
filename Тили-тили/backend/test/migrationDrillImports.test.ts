import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const backend = fileURLToPath(new URL('../', import.meta.url))
const source = readFileSync(new URL('../scripts/ecosystem-migration-drill.mjs', import.meta.url), 'utf8')
const parent = ts.createSourceFile('drill.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const erasure = parent.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'eraseCurrentVendorFixture')
if (!erasure?.body) throw new Error('The real current-vendor erasure drill must remain present')
const child = erasure.body.statements.filter(ts.isVariableStatement)
  .flatMap(node => [...node.declarationList.declarations])
  .find(node => ts.isIdentifier(node.name) && node.name.text === 'child')?.initializer
if (!child || !ts.isTemplateExpression(child)) throw new Error('The erasure child must remain an inspectable inline module')
// Substitute syntax placeholders only. Do not execute the parent, privacy worker or database writes.
const program = child.head.text + child.templateSpans.map(span => `null${span.literal.text}`).join('')
const imports = (file: ts.SourceFile) => file.statements.filter(ts.isImportDeclaration)
  .map(node => { if (!ts.isStringLiteral(node.moduleSpecifier)) throw new Error('Nonliteral import'); return node.moduleSpecifier.text })
const childImports = imports(ts.createSourceFile('child.mjs', program, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS))

describe('preserving migration drill executable module boundaries', () => {
  it('the actual inline child remains valid module syntax', () => {
    const checked = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      cwd: backend, input: program, encoding: 'utf8', timeout: 10_000,
    })
    expect(checked.error).toBeUndefined()
    expect(checked.status, checked.stderr).toBe(0)
  })

  it('every child import resolves from its real backend working directory without executing it', () => {
    const checked = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import {accessSync} from 'node:fs';
      import {fileURLToPath} from 'node:url';
      for (const specifier of ${JSON.stringify(childImports)}) {
        const resolved = import.meta.resolve(specifier);
        if (resolved.startsWith('file:')) accessSync(fileURLToPath(resolved));
      }
    `], { cwd: backend, encoding: 'utf8', timeout: 10_000 })
    expect(checked.error).toBeUndefined()
    expect(checked.status, checked.stderr).toBe(0)
  })

  it('keeps the dependency migration in the parent and the actual privacy worker in the child', () => {
    expect(imports(parent).filter(path => path === './task-dependency-migration-drill.mjs')).toHaveLength(1)
    expect(source).toContain('await taskDependencyMigrationDrill(')
    expect(childImports).toContain('./src/jobs/index.ts')
    expect(childImports).toContain('./src/orders/resource-plan.ts')
    expect(childImports).not.toContain('./task-dependency-migration-drill.mjs')
    expect(program).toContain('await eraseUser(c,f.vendorOwner)')
    expect(program).toContain('ACTUAL_ERASE_USER_CURRENT_VENDOR_PRESERVED_PLAN_UNAVAILABLE')
  })
})
