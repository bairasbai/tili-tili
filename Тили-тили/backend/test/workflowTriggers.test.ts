import fs from 'node:fs'
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
})
