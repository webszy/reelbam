<script setup lang="ts">
const props = defineProps<{
  video: string
  poster: string
  label?: string
  credit?: string
}>()

const videoRef = ref<HTMLVideoElement | null>(null)
const reducedMotion = ref(false)
let observer: IntersectionObserver | undefined

onMounted(() => {
  const element = videoRef.value
  if (!element) return
  reducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reducedMotion.value) return
  observer = new IntersectionObserver(([entry]) => {
    if (!entry) return
    if (entry.isIntersecting) void element.play().catch(() => {})
    else element.pause()
  }, { threshold: 0.35 })
  observer.observe(element)
})

onUnmounted(() => observer?.disconnect())
</script>

<template>
  <figure class="tpl-video">
    <div class="tpl-video-frame">
      <video
        ref="videoRef"
        :src="props.video"
        :poster="props.poster"
        muted
        loop
        playsinline
        preload="metadata"
        :controls="reducedMotion"
        :aria-label="props.label || props.credit || 'Template preview'"
      />
      <span v-if="props.label" class="tpl-video-label">{{ props.label }}</span>
    </div>
    <figcaption v-if="props.credit">{{ props.credit }}</figcaption>
  </figure>
</template>
