<script setup lang="ts">
import { useAuth } from '@clerk/nuxt/composables'
import type { CheckoutResponse } from '~~/server/types/api'
const props = defineProps<{ priceCode: string }>()
const { isLoaded, isSignedIn, userId } = useAuth()
const config = useRuntimeConfig()
const { open } = useLoginModal()
const pending = ref(false)
const message = ref('')
async function checkout() {
  if (pending.value || !config.public.creemPaymentEnabled) return
  if (!isSignedIn.value) { open('/pricing'); return }
  pending.value = true
  message.value = ''
  // Persist retries through navigation/network failure; the server binds this key to its owner and pack.
  const storageKey = `checkout:${userId.value}:${props.priceCode}`
  try {
    let key = sessionStorage.getItem(storageKey)
    if (!key) { key = crypto.randomUUID(); sessionStorage.setItem(storageKey, key) }
    const response = await $fetch<CheckoutResponse>('/api/billing/checkout', { method: 'POST', headers: { 'Idempotency-Key': key }, body: { priceCode: props.priceCode } })
    if (!response.success) throw new Error(response.code)
    sessionStorage.removeItem(storageKey)
    await navigateTo(response.data.checkoutUrl, { external: true })
  } catch (error) {
    const code = (error as { data?: { code?: string } }).data?.code
    // Only discard keys for definitively terminal checkout attempts.
    if (code === 'CHECKOUT_FAILED') sessionStorage.removeItem(storageKey)
    message.value = code === 'CHECKOUT_EMAIL_REQUIRED' ? 'Add an email address to your account before purchasing.' : 'Checkout could not be opened. Please try again shortly.'
  } finally { pending.value = false }
}
</script>
<template><UButton :loading="pending" :disabled="!isLoaded || !config.public.creemPaymentEnabled" @click="checkout">{{ config.public.creemPaymentEnabled ? 'Buy credits' : 'Purchases unavailable' }}</UButton><p v-if="message" role="alert" class="error">{{ message }}</p></template>
