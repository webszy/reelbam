<script setup lang="ts">
const configured = useRuntimeConfig().public.clerkConfigured
const { open } = useLoginModal()
</script>
<template><ClientOnly v-if="configured"><AuthClerkActions /><template #fallback><NuxtLink to="/login">Sign in</NuxtLink></template></ClientOnly><UButton v-else @click="open()">Sign in</UButton></template>
