<script setup lang="ts">
withDefaults(defineProps<{ destination?: string }>(), { destination: '/' })
const configured = useRuntimeConfig().public.clerkConfigured
</script>
<template><ClientOnly v-if="configured"><AuthClerkLoginPanel :destination="destination" /><template #fallback><p role="status">Loading sign in…</p></template></ClientOnly><p v-else class="notice" role="status">Sign in is not available yet. Please try again later.</p></template>
