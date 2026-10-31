<script setup lang="ts">
import { listPublishedTemplates } from '~~/shared/templates'

const config = useRuntimeConfig()
const templates = listPublishedTemplates()

useSeoMeta({
  title: 'Templates',
  description: 'Published Reelbam templates. This index is a reserved route, not a marketplace.',
})
useHead({
  link: [{ rel: 'canonical', href: new URL('/templates', config.public.siteUrl).href }],
})
</script>

<template>
  <section class="template-preview">
    <p class="eyebrow">Templates</p>
    <h1>The library is not open yet.</h1>
    <p class="lede">This page reserves the Templates route. Search, categories, and a marketplace grid are not part of this preview.</p>
    <div class="notice">
      Published templates open a detail page. Drafts stay off this list.
    </div>
    <ul class="template-index">
      <li v-for="template in templates" :key="template.id">
        <NuxtLink :to="`/templates/${template.slug}`">{{ template.title }}</NuxtLink>
        <span>{{ template.category }}</span>
      </li>
    </ul>
  </section>
</template>
