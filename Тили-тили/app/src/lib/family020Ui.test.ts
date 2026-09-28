import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

describe('020 family invitation UI guards', () => {
  it('couple creates an explicit second person instead of a hidden plusOne multiplier', () => {
    const source = fs.readFileSync(path.join(ROOT, 'pages/Wedding.tsx'), 'utf8')
    expect(source).toContain("members: [{ name: familyMember.trim() }]")
    expect(source).toContain("Второй человек семьи (необязательно)")
    expect(source).toContain("const persons = (status: string) => list.filter(g => g.status === status).length")
    expect(source).not.toContain("setPlus(!plus)")
  })

  it('guest family form submits one answer per guestId', () => {
    const source = fs.readFileSync(path.join(ROOT, 'pages/Invite.tsx'), 'utf8')
    expect(source).toContain('sendFamilyRsvp(token, draft.map')
    expect(source).toContain('guestId: member.guestId')
    expect(source).toContain('Ответьте за каждого человека в приглашении отдельно')
  })

  it('transport and menu clients address an individual person while hotel stays family-scoped', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib/api/guest.ts'), 'utf8')
    expect(source).toContain('{ busId, ...(guestId ? { guestId } : {}) }')
    expect(source).toContain('{ optionId, ...(guestId ? { guestId } : {}) }')
    expect(source).toContain("{ hotelId }, { idempotencyKey: newIdempotencyKey() }")
  })
})
