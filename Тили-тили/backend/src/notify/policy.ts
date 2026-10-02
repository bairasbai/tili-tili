import type { AttentionState } from '../wedding/attention.js'

export interface PushPolicyInput {
  purpose: 'information' | 'operational' | 'decision' | 'incident'
  recipientRole: 'couple' | 'helper' | 'coordinator' | 'vendor' | 'guest'
  attention: AttentionState
  pushEnabled: boolean
  urgentIncidents: boolean
  incidentVerified: boolean
  isSelectedCoordinator?: boolean
  assignedToRecipient?: boolean
}

export interface PushDecision {
  push: 'none' | 'normal' | 'urgent'
  requiresIncidentContext: boolean
}

/** Audience/access must already be authorized by the caller. Modes never grant a role or a scope. */
export function decidePush(input: PushPolicyInput): PushDecision {
  const requiresIncidentContext = input.purpose === 'incident'
  const result = (push: PushDecision['push']): PushDecision => ({ push, requiresIncidentContext })
  if (!input.pushEnabled || input.purpose === 'information') return result('none')
  if (input.purpose === 'incident') return result(input.incidentVerified && input.urgentIncidents ? 'urgent' : 'normal')
  if (input.purpose === 'decision') return result(input.recipientRole === 'couple' || input.recipientRole === 'vendor' ? 'normal' : 'none')
  const selectedCoordinator = input.recipientRole === 'coordinator' && input.isSelectedCoordinator === true
    && input.attention.effectiveMode === 'coordinator' && input.attention.coordinatorState === 'active'
  const detailedCouple = input.recipientRole === 'couple' && input.attention.effectiveMode === 'detailed'
  return result(input.assignedToRecipient === true || selectedCoordinator || detailedCouple ? 'normal' : 'none')
}
