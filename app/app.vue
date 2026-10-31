<script setup lang="ts">
const config = useRuntimeConfig()
useHead({ titleTemplate: title => title ? `${title} · ${config.public.siteName}` : config.public.siteName })
useSeoMeta({ description: () => config.public.siteDescription })
</script>
<template>
  <UApp><NuxtRouteAnnouncer /><AuthLoginModal /><NuxtLayout><NuxtPage /></NuxtLayout></UApp>
</template>
