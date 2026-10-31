import { readFileSync } from 'node:fs'
const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))
const issues = []
if (!config.d1_databases?.[0]?.database_id || config.d1_databases[0].database_id === '00000000-0000-0000-0000-000000000000') issues.push('Set your own D1 database_id in wrangler.jsonc.')
if (config.vars.APP_ENVIRONMENT !== 'production') issues.push('Set APP_ENVIRONMENT=production for live deployment (development uses the Creem test API).')
try {
  const origin = new URL(config.vars.APP_URL)
  if (origin.protocol !== 'https:' || origin.origin !== config.vars.APP_URL || origin.hostname === 'example.com') throw new Error()
} catch { issues.push('Set APP_URL to your real HTTPS origin without a trailing slash or path.') }
if (!process.env.NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.NUXT_CLERK_SECRET_KEY) issues.push('Set both Clerk keys in the build environment/.env, and separately in Worker secrets.')
if (config.vars.NUXT_PUBLIC_SITE_URL !== config.vars.APP_URL) issues.push('NUXT_PUBLIC_SITE_URL must match APP_URL.')
if (issues.length) { console.error(issues.join('\n')); process.exit(1) }
console.log('Deployment configuration checked. Ensure Worker secrets and D1 migrations are provisioned before deploying.')
