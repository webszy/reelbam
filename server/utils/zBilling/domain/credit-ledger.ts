import type { productEntitlements } from '../../../database/schema'
import type { EntitlementSnapshotItem } from '../../../types/billing'

export function matchesCheckoutEntitlement(
  row: typeof productEntitlements.$inferSelect,
  expected: EntitlementSnapshotItem,
): boolean {
  return (
    row.entitlementKey === expected.entitlement_key
    && row.entitlementType === expected.entitlement_type
    && row.quantity === expected.quantity
    && row.grantCadence === expected.grant_cadence
    && row.expirationPolicy === expected.expiration_policy
    && row.durationDays === expected.duration_days
  )
}
