<script setup lang="ts">
const config = useRuntimeConfig()
definePageMeta({ layout: 'landing' })
useSeoMeta({
  title: 'Home',
  description: 'Discover trending AI video templates. Customize your own in seconds.',
})
useHead({
  link: [
    { rel: 'canonical', href: new URL('/', config.public.siteUrl).href },
    { rel: 'stylesheet', href: '/assets/css/00-0zhda6xe5ycum.css', key: 'revolver-css' },
  ],
})
</script>

<template>
  <HomeRevolverStage />
</template>
