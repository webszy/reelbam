<script setup lang="ts">
defineProps<{ priceCode: string }>()
const config = useRuntimeConfig()
</script>
<template><ClientOnly v-if="config.public.clerkConfigured"><BillingClerkCheckoutButton :price-code="priceCode" /><template #fallback><UButton disabled>Loading…</UButton></template></ClientOnly><UButton v-else disabled>Purchases unavailable</UButton></template>
