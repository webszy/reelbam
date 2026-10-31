export const CHECKOUT_CREDIT_PACK_CONTRACTS = {
  credit_pack_5_usd: {
    amount: 499,
    currency: 'USD',
    units: 1,
    entitlement: {
      entitlement_key: 'credits',
      entitlement_type: 'consumable',
      quantity: 5,
      grant_cadence: 'purchase',
      expiration_policy: 'fixed_duration',
      duration_days: 365,
    },
  },
  credit_pack_10_usd: {
    amount: 899,
    currency: 'USD',
    units: 1,
    entitlement: {
      entitlement_key: 'credits',
      entitlement_type: 'consumable',
      quantity: 10,
      grant_cadence: 'purchase',
      expiration_policy: 'fixed_duration',
      duration_days: 365,
    },
  },
  credit_pack_30_usd: {
    amount: 1999,
    currency: 'USD',
    units: 1,
    entitlement: {
      entitlement_key: 'credits',
      entitlement_type: 'consumable',
      quantity: 30,
      grant_cadence: 'purchase',
      expiration_policy: 'fixed_duration',
      duration_days: 365,
    },
  },
} as const

export type CreditPackPriceCode = keyof typeof CHECKOUT_CREDIT_PACK_CONTRACTS
export const CREDIT_PACK_PRICE_CODES = Object.keys(CHECKOUT_CREDIT_PACK_CONTRACTS) as CreditPackPriceCode[]
