<script setup lang="ts">
const { isOpen, returnTo } = useLoginModal()
</script>
<template><UModal v-model:open="isOpen" title="Welcome back" description="Sign in or create an account to continue."><template #body><AuthLoginPanel :destination="returnTo" /></template></UModal></template>
