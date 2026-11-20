import type { VerifiedPayment } from './orders.js'

export type ServicePaymentRequest = {
  orderId: string
  amount: number
  currency: 'RUB'
  quoteExpiresAt: Date
  description: string
  returnPath: string
}

export interface ServicePaymentProvider {
  readonly code: string

  // Use the local orderId as the provider's stable merchant reference.
  ensurePayment(request: ServicePaymentRequest): Promise<{
    status: VerifiedPayment
    confirmationUrl: string | null
  }>

  // Read using server credentials; a callback body or browser return is
  // a reason to query, never evidence of a transition by itself.
  readPayment(orderId: string): Promise<VerifiedPayment | null>
}
