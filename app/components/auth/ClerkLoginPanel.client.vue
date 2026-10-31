<script setup lang="ts">
import { useAuth } from '@clerk/nuxt/composables'
import { SignIn } from '@clerk/nuxt/components'
import { resolveSafeReturnTo } from '~/utils/safe-return-to'
const props = defineProps<{ destination: string }>()
const destination = computed(() => resolveSafeReturnTo(props.destination))
const { isLoaded, isSignedIn } = useAuth()
const { close } = useLoginModal()
watch([isLoaded, isSignedIn], ([loaded, signedIn]) => {
  if (loaded && signedIn) { close(); void navigateTo(destination.value) }
}, { immediate: true })
</script>
<template><p v-if="!isLoaded" role="status">Loading sign in…</p><SignIn v-else-if="!isSignedIn" routing="hash" :with-sign-up="true" :transferable="true" :force-redirect-url="destination" :sign-up-force-redirect-url="destination" /></template>
