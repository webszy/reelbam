/**
 * Historical billing import path.
 * Schema enums and entitlement snapshot types are defined in packages/data.
 * Checkout catalog bindings stay here because they depend on the Nuxt shared catalog.
 */

import {
  CREDIT_PACK_PRICE_CODES,
  type CreditPackPriceCode,
} from '../../shared/billing-catalog'

export {
  billingDisputeStatuses,
  billingIntervals,
  billingOrderStatuses,
  billingProductKinds,
  billingProviders,
  billingRefundStatuses,
  billingSubscriptionStatuses,
  billingTypes,
  billingWebhookEventStatuses,
  entitlementGrantStatuses,
  entitlementKeys,
  entitlementSourceTypes,
  entitlementTransactionTypes,
  entitlementTypes,
  expirationPolicies,
  grantCadences,
  type BillingDisputeStatus,
  type BillingInterval,
  type BillingOrderStatus,
  type BillingProductKind,
  type BillingProvider,
  type BillingRefundStatus,
  type BillingSubscriptionStatus,
  type BillingType,
  type BillingWebhookEventStatus,
  type EntitlementGrantStatus,
  type EntitlementKey,
  type EntitlementSnapshot,
  type EntitlementSnapshotItem,
  type EntitlementSourceType,
  type EntitlementTransactionType,
  type EntitlementType,
  type ExpirationPolicy,
  type GrantCadence,
} from '../../packages/data/src/schema/billing-values.ts'

export const billingPriceCodes = CREDIT_PACK_PRICE_CODES
export type BillingPriceCode = CreditPackPriceCode

export const checkoutFailureCodes = [
  'CHECKOUT_CREATION_UNKNOWN',
  'CHECKOUT_PROVIDER_REJECTED',
] as const

export type CheckoutFailureCode = (typeof checkoutFailureCodes)[number]

export const CHECKOUT_ENABLED_PRICE_CODES = CREDIT_PACK_PRICE_CODES

export type CheckoutEnabledPriceCode
  = (typeof CHECKOUT_ENABLED_PRICE_CODES)[number]

export { CHECKOUT_CREDIT_PACK_CONTRACTS } from '../../shared/billing-catalog'
