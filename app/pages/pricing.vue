<script setup lang="ts">
const route = useRoute()
const order = computed(() => typeof route.query.order === 'string' ? route.query.order : '')
useSeoMeta({ title: 'Pricing', robots: () => order.value ? 'noindex, nofollow' : undefined })
</script>
<template>
  <div><h1>Simple, flexible pricing.</h1><p>One-time credit packs. Choose what works for you.</p><BillingPaymentStatus v-if="order" :key="order" :order="order" /><BillingPlans />  </div>
</template>
