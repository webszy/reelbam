<script setup lang="ts">
import { resolveTemplateView } from '~~/shared/template-view'
import { absoluteSiteUrl, jsonLdInnerHtml, templateCanonical, templateStructuredData } from '~~/shared/template-seo'

const route = useRoute()
const config = useRuntimeConfig()
const slug = computed(() => String(route.params.slug ?? ''))
const view = computed(() => resolveTemplateView(slug.value))

if (!view.value) {
  throw createError({ statusCode: 404, statusMessage: 'Template not found', fatal: true })
}

onBeforeRouteUpdate((to) => {
  if (!resolveTemplateView(String(to.params.slug ?? ''))) {
    return abortNavigation(createError({ statusCode: 404, statusMessage: 'Template not found', fatal: true }))
  }
})

const canonical = computed(() => templateCanonical(config.public.siteUrl, view.value?.template.slug || slug.value))
const image = computed(() => {
  const current = view.value?.template
  if (!current) return ''
  return absoluteSiteUrl(config.public.siteUrl, current.ogImage || current.posterUrl)
})

useSeoMeta({
  title: () => view.value?.template.seoTitle ?? 'Template',
  description: () => view.value?.template.seoDescription ?? '',
  ogTitle: () => view.value?.template.seoTitle ?? 'Template',
  ogDescription: () => view.value?.template.seoDescription ?? '',
  ogType: 'website',
  ogUrl: () => canonical.value,
  ogImage: () => image.value,
  ogImageWidth: () => view.value?.template.posterWidth,
  ogImageHeight: () => view.value?.template.posterHeight,
  ogImageAlt: () => view.value ? `${view.value.template.title} preview` : '',
  twitterCard: 'summary_large_image',
  twitterTitle: () => view.value?.template.seoTitle ?? 'Template',
  twitterDescription: () => view.value?.template.seoDescription ?? '',
  twitterImage: () => image.value,
})

useHead(() => {
  const current = view.value
  return {
    link: [{ rel: 'canonical', href: canonical.value, key: 'template-canonical' }],
    script: current
      ? [{
          key: 'template-jsonld',
          type: 'application/ld+json',
          innerHTML: jsonLdInnerHtml(templateStructuredData(current, config.public.siteUrl, config.public.siteName)),
        }]
      : [],
  }
})
</script>

<template>
  <TemplateLanding v-if="view" :key="view.template.id" :view="view" />
</template>
