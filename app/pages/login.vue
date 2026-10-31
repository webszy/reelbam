<script setup lang="ts">
import { resolveSafeReturnTo } from '~/utils/safe-return-to'
const route = useRoute()
const destination = computed(() => resolveSafeReturnTo(route.query.returnTo))
useSeoMeta({ title: 'Sign in', robots: 'noindex, nofollow' })
</script>
<template><section class="auth-page"><h1>Welcome back.</h1><p>Sign in or create an account to get started.</p><AuthLoginPanel :destination="destination" /></section></template>
