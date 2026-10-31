<script setup lang="ts">
import type { BillingOrderStatusResponse } from '~~/server/types/api'
const props = defineProps<{ order: string }>()
const status = ref('Confirming your payment…')
const order = props.order
let timer: ReturnType<typeof setTimeout> | undefined
let stopped = false
const started = Date.now()
async function poll() {
  if (!order) { status.value = 'This link does not contain an order.'; return }
  try {
    const result = await $fetch<BillingOrderStatusResponse>(`/api/billing/orders/${encodeURIComponent(order)}`)
    if (stopped) return
    if (!result.success) throw new Error(result.code)
    if (result.data.status !== 'pending') {
      status.value = result.data.status === 'paid' ? 'Payment confirmed. Your credits are ready.' : `Order status: ${result.data.status}.`
      return
    }
    status.value = 'Your payment is still being confirmed. This can take a moment.'
  } catch { if (!stopped) status.value = 'We couldn’t confirm the payment yet. Checking again…' }
  if (stopped) return
  if (Date.now() - started >= 120000) { status.value = 'Confirmation is taking longer than expected. Please check again shortly.'; return }
  timer = setTimeout(poll, 2000)
}
onMounted(poll)
onBeforeUnmount(() => { stopped = true; clearTimeout(timer) })
</script>
<template><section class="card"><h2>Payment status.</h2><p role="status">{{ status }}</p><UButton to="/pricing">Back to pricing</UButton></section></template>
