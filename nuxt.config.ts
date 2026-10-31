const clerkConfigured = Boolean(process.env.NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() && process.env.NUXT_CLERK_SECRET_KEY?.trim())
const creemPaymentEnabled = process.env.NUXT_CREEM_PAYMENT_ENABLED === 'true'
export default defineNuxtConfig({
  compatibilityDate: '2026-07-24',
  devtools: { enabled: true },
  modules: ['@nuxt/eslint', '@nuxt/ui', ...(clerkConfigured ? ['@clerk/nuxt'] : [])],
  build: { transpile: ['@clerk/nuxt'] },
  css: ['~/assets/css/main.css', '~/assets/css/template-detail.css'],
  nitro: { preset: 'cloudflare-module' },
  runtimeConfig: {
    creemPaymentEnabled,
    wrangler: { configPath: './wrangler.jsonc', persistDir: './.wrangler/state/v3' },
    clerk: { secretKey: '' },
    public: {
      siteName: 'reelbam', siteUrl: 'http://localhost:3000', siteDescription: 'Discover trending AI video templates. Customize your own in seconds.',
      clerkConfigured, creemPaymentEnabled,
      clerk: { publishableKey: '', signInUrl: '/login', signUpUrl: '/login', signInFallbackRedirectUrl: '/', signUpFallbackRedirectUrl: '/' },
    },
  },
  app: { head: { htmlAttrs: { lang: 'en' }, viewport: 'width=device-width, initial-scale=1' } },
  typescript: { strict: true, typeCheck: true },
  ui: { fonts: false, colorMode: false },
})
