import { writeFileSync } from 'node:fs'
import { CHECKOUT_CREDIT_PACK_CONTRACTS } from '../shared/billing-catalog.ts'
const quote = value => `'${String(value).replaceAll("'", "''")}'`
const statements = ['-- Generated from shared/billing-catalog.ts. No live Creem products; purchases remain disabled.', '-- Existing catalog rows are never overwritten. Use a migration for changes after launch.']
for (const [code, contract] of Object.entries(CHECKOUT_CREDIT_PACK_CONTRACTS)) {
  const productCode = code.replace(/_usd$/, '')
  const productId = `product_${productCode}`
  const entitlement = contract.entitlement
  statements.push(`INSERT INTO billing_products (id, code, name, description, product_kind, active, created_at, updated_at) VALUES (${quote(productId)}, ${quote(productCode)}, ${quote(`${entitlement.quantity} Credits`)}, 'One-time credit pack', 'credit_pack', 0, unixepoch(), unixepoch()) ON CONFLICT(code) DO NOTHING;`)
  statements.push(`INSERT INTO billing_prices (id, product_id, code, billing_type, amount, currency, provider, active, created_at, updated_at) VALUES (${quote(`price_${code}`)}, ${quote(productId)}, ${quote(code)}, 'one_time', ${contract.amount}, ${quote(contract.currency)}, 'creem', 0, unixepoch(), unixepoch()) ON CONFLICT(code) DO NOTHING;`)
  statements.push(`INSERT INTO product_entitlements (id, product_id, entitlement_key, entitlement_type, quantity, grant_cadence, expiration_policy, duration_days, created_at, updated_at) VALUES (${quote(`entitlement_${productCode}`)}, ${quote(productId)}, 'credits', 'consumable', ${entitlement.quantity}, 'purchase', 'fixed_duration', ${entitlement.duration_days}, unixepoch(), unixepoch()) ON CONFLICT(product_id, entitlement_key) DO NOTHING;`)
}
writeFileSync(new URL('../database/catalog.sql', import.meta.url), statements.join('\n') + '\n')
