/**
 * Pure billing enums and entitlement snapshot types used by the Drizzle schema.
 * Checkout catalog codes stay in the Nuxt server; this module does not import it.
 */

export const billingProductKinds = [
  'credit_pack',
  'subscription',
] as const

export type BillingProductKind = (typeof billingProductKinds)[number]

export const billingTypes = [
  'one_time',
  'recurring',
] as const

export type BillingType = (typeof billingTypes)[number]

export const billingIntervals = [
  'month',
  'year',
] as const

export type BillingInterval = (typeof billingIntervals)[number]

export const billingProviders = [
  'creem',
] as const

export type BillingProvider = (typeof billingProviders)[number]

export const entitlementKeys = [
  'credits',
] as const

export type EntitlementKey = (typeof entitlementKeys)[number]

export const entitlementTypes = [
  'consumable',
  'feature',
  'limit',
] as const

export type EntitlementType = (typeof entitlementTypes)[number]

export const grantCadences = [
  'purchase',
  'monthly',
  'subscription',
] as const

export type GrantCadence = (typeof grantCadences)[number]

export const expirationPolicies = [
  'fixed_duration',
  'grant_period_end',
  'subscription_end',
] as const

export type ExpirationPolicy = (typeof expirationPolicies)[number]

export const billingOrderStatuses = [
  'pending',
  'paid',
  'failed',
  'expired',
  'refunded',
  'partially_refunded',
] as const

export type BillingOrderStatus = (typeof billingOrderStatuses)[number]

export const billingSubscriptionStatuses = [
  'pending',
  'trialing',
  'active',
  'past_due',
  'paused',
  'canceled',
  'expired',
] as const

export type BillingSubscriptionStatus
  = (typeof billingSubscriptionStatuses)[number]

export const billingRefundStatuses = [
  'pending',
  'succeeded',
  'failed',
  'canceled',
] as const

export type BillingRefundStatus = (typeof billingRefundStatuses)[number]

export const billingDisputeStatuses = [
  'opened',
] as const

export type BillingDisputeStatus = (typeof billingDisputeStatuses)[number]

export const billingWebhookEventStatuses = [
  'received',
  'processing',
  'processed',
  'failed',
] as const

export type BillingWebhookEventStatus
  = (typeof billingWebhookEventStatuses)[number]

export const entitlementGrantStatuses = [
  'active',
  'expired',
  'revoked',
] as const

export type EntitlementGrantStatus
  = (typeof entitlementGrantStatuses)[number]

export const entitlementSourceTypes = [
  'order',
  'subscription_cycle',
  'admin',
  'migration',
  'promotion',
] as const

export type EntitlementSourceType
  = (typeof entitlementSourceTypes)[number]

export const entitlementTransactionTypes = [
  'grant',
  'consume',
  'refund',
  'expire',
  'adjustment',
  'revoke',
] as const

export type EntitlementTransactionType
  = (typeof entitlementTransactionTypes)[number]

export interface EntitlementSnapshotItem {
  entitlement_key: EntitlementKey | (string & {})
  entitlement_type: EntitlementType
  quantity: number | null
  grant_cadence: GrantCadence
  expiration_policy: ExpirationPolicy
  duration_days: number | null
}

export type EntitlementSnapshot = EntitlementSnapshotItem[]
