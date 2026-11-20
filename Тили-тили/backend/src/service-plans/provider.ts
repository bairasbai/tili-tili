import type { VerifiedPayment } from './orders.js'

export type ServicePaymentRequest = {
  orderId: string
  amount: number
  currency: 'RUB'
  quoteExpiresAt: Date
  description: string
  returnPath: string
}

export type ServicePaymentLookup = {
  amount: number
  createdAt: Date
}

export type ServicePaymentStatus = VerifiedPayment | { orderId: string; state: 'not_registered' }

export type ServicePaymentRegistration = ServicePaymentRequest & {
  createdAt: Date
  firstAttempt: boolean
  claimRetry: () => Promise<boolean>
}

export interface ServicePaymentProvider {
  readonly code: string

  // Use the local orderId as the provider's stable merchant reference.
  ensurePayment(request: ServicePaymentRegistration): Promise<{
    status: ServicePaymentStatus
    confirmationUrl: string | null
  }>

  // Read using server credentials; a callback body or browser return is
  // a reason to query, never evidence of a transition by itself.
  readPayment(orderId: string, lookup: ServicePaymentLookup): Promise<ServicePaymentStatus | null>
}
