import fs from 'node:fs'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

function rootTriggerBlock(source: string): string {
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => /^(?:on|'on'|"on"):\s*(?:\{\})?\s*$/.test(line))
  if (start < 0) return ''

  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[^\s#][^:]*:\s*/.test(lines[i]!)) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

describe('GitHub Actions browser gates', () => {
  it('keeps Offers 019 E2E on pull requests to main and available for manual reruns', () => {
    const source = fs.readFileSync(
      new URL('../../../.github/workflows/offers-e2e.yml', import.meta.url),
      'utf8',
    )
    const trigger = rootTriggerBlock(source)

    expect(trigger).not.toBe('')
    expect(trigger).toMatch(/^\s{2}pull_request:\s*$/m)
    expect(trigger).toMatch(/^\s{4}branches:\s*$/m)
    expect(trigger).toMatch(/^\s{4}-\s+main\s*$/m)
    expect(trigger).toMatch(/^\s{2}workflow_dispatch:\s*(?:\{\})?\s*$/m)
  })

  // Имя проверки в PR — `name` job'а, а без него — его id. Три job'а `browser`
  // давали три неразличимые строки «browser»: по имени их нельзя было ни
  // прочитать, ни сделать обязательными в защите main.
  it('gives every job a check name unique across all workflows', () => {
    const dir = new URL('../../../.github/workflows/', import.meta.url)
    const names = fs
      .readdirSync(dir)
      .filter((file) => /\.ya?ml$/.test(file))
      .flatMap((file) => {
        const workflow = yaml.load(fs.readFileSync(new URL(file, dir), 'utf8')) as { jobs: Record<string, { name?: string }> }
        return Object.entries(workflow.jobs).map(([id, job]) => job.name ?? id)
      })

    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([])
    expect(names).toEqual(expect.arrayContaining(['frontend', 'backend', 'offers-browser', 'payment-browser', 'task-browser']))
  })
})
