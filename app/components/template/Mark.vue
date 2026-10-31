<script setup lang="ts">
defineProps<{
  name: 'flame' | 'x' | 'check' | 'arrow' | 'plus' | 'type' | 'film' | 'phone' | 'clock' | 'shield' | 'spark'
}>()
</script>

<template>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="name === 'flame'">
      <path d="M12 3c2 3 2 4 0 6 3 0 6 3 6 7a6 6 0 0 1-12 0c0-2 1-3 2-4 0 2 2 2 2 0 0-3-1-5 2-9Z" />
    </template>
    <template v-else-if="name === 'x'">
      <path d="M6 6l12 12M18 6 6 18" />
    </template>
    <template v-else-if="name === 'check'">
      <path d="M5 12.5 9.2 17 19 7" />
    </template>
    <template v-else-if="name === 'arrow'">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </template>
    <template v-else-if="name === 'plus'">
      <path d="M12 5v14M5 12h14" />
    </template>
    <template v-else-if="name === 'type'">
      <path d="M5 6h14M12 6v12M9 18h6" />
    </template>
    <template v-else-if="name === 'film'">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4" />
    </template>
    <template v-else-if="name === 'phone'">
      <rect x="8" y="3" width="8" height="18" rx="2" />
      <path d="M11 18h2" />
    </template>
    <template v-else-if="name === 'clock'">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4.5L15 15" />
    </template>
    <template v-else-if="name === 'shield'">
      <path d="M12 3 19 6v6c0 4.5-3 7-7 9-4-2-7-4.5-7-9V6l7-3Z" />
    </template>
    <template v-else>
      <path d="M12 3.5 13.6 9H19l-4.4 3.2 1.7 5.3L12 14.8 7.7 17.5 9.4 12.2 5 9h5.4L12 3.5Z" />
    </template>
  </svg>
</template>
