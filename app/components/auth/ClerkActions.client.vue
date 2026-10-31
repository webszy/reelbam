<script setup lang="ts">
import { useAuth } from '@clerk/nuxt/composables'
import { UserButton } from '@clerk/nuxt/components'
const { isLoaded, isSignedIn } = useAuth()
const { open } = useLoginModal()
</script>
<template><template v-if="isLoaded && isSignedIn"><UserButton /></template><UButton v-else :disabled="!isLoaded" @click="open()">Sign in</UButton></template>
