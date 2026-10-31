<script setup lang="ts">
import { CHECKOUT_CREDIT_PACK_CONTRACTS } from '~~/shared/billing-catalog'
const plans = Object.entries(CHECKOUT_CREDIT_PACK_CONTRACTS).map(([priceCode, plan]) => ({ priceCode, ...plan }))
const money = (amount: number, currency: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount / 100)
</script>
<template><div class="grid-cards"><article v-for="plan in plans" :key="plan.priceCode" class="card"><h2>{{ plan.entitlement.quantity }} credits</h2><p class="price">{{ money(plan.amount, plan.currency) }}</p><p>One-time purchase<br>Valid for {{ plan.entitlement.duration_days }} days</p><BillingCheckoutButton :price-code="plan.priceCode" /></article></div></template>
