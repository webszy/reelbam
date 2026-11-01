<script setup lang="ts">
import markup from '~/assets/revolver/home.html?raw'
import { listFeaturedTemplates, type PublicTemplate } from '~~/shared/templates'

type RevolverWindow = Window & {
  __revolverMount?: () => void
  __revolverUnmount?: () => void
  __revolverOnIndex?: (index: number) => void
  __revolverUseTemplate?: () => void
}

const templates = listFeaturedTemplates()
const selectedIndex = ref(0)

function revolverWindow() {
  return window as RevolverWindow
}

function loadRevolverScript() {
  if (revolverWindow().__revolverMount) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const fail = () => reject(new Error('Revolver interaction script failed to load.'))
    const existing = document.querySelector<HTMLScriptElement>('script[data-revolver]')
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', fail, { once: true })
      return
    }
    const script = document.createElement('script')
    script.src = '/revolver/fixes.js'
    script.async = false
    script.dataset.revolver = ''
    script.onload = () => resolve()
    script.onerror = fail
    document.body.appendChild(script)
  })
}

function sectionEl() {
  return document.querySelector<HTMLElement>('[data-rev-scope]')
}

function shouldPlayPreview() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  return window.innerWidth >= 768
}

function decorateStage(section: HTMLElement) {
  const caption = [...section.querySelectorAll('[data-rev-reveal-late]')].find(element => /\d{2} — 06/.test(element.textContent || ''))
  const name = caption?.querySelector('[data-rev-name]')
  if (caption && name && !caption.querySelector('[data-rev-category]')) {
    const chip = document.createElement('div')
    chip.setAttribute('data-rev-category', '')
    name.parentElement?.insertBefore(chip, name)
  }

  section.querySelectorAll('[data-rev-card]').forEach((card, index) => {
    const back = card.children[1]
    back?.querySelectorAll('div.absolute').forEach((element) => {
      const text = element.textContent || ''
      if (text.includes('REESE HILLS') || text.includes('4496') || text.includes('Motion Financial')) {
        element.classList.add('rev-finance')
      }
    })

    const img = card.querySelector('img')
    const template = templates[index]
    if (!img || !template || card.querySelector('video')) return
    img.src = template.posterUrl
    img.alt = `${template.title} template preview`
    const video = document.createElement('video')
    video.className = 'rev-card-video'
    video.muted = true
    video.loop = true
    video.playsInline = true
    video.setAttribute('playsinline', '')
    video.setAttribute('webkit-playsinline', '')
    video.preload = 'none'
    video.poster = template.posterUrl
    video.setAttribute('aria-hidden', 'true')
    video.addEventListener('error', () => {
      video.dataset.failed = '1'
      video.removeAttribute('src')
      video.style.opacity = '0'
    })
    img.insertAdjacentElement('afterend', video)
  })
}

function syncLeft(template: PublicTemplate | undefined) {
  const section = sectionEl()
  if (!section || !template) return
  const chip = section.querySelector('[data-rev-category]')
  if (chip) chip.textContent = template.category
}

function syncVideos(index: number) {
  const section = sectionEl()
  if (!section) return
  const play = shouldPlayPreview()
  section.querySelectorAll<HTMLVideoElement>('video.rev-card-video').forEach((video, current) => {
    const template = templates[current]
    const active = play && current === index && video.dataset.failed !== '1' && template
    if (active && template) {
      if (video.getAttribute('src') !== template.previewVideoUrl) {
        video.src = template.previewVideoUrl
      }
      video.style.opacity = '1'
      const attempt = video.play()
      attempt.catch(() => {
        video.style.opacity = '0'
      })
      return
    }
    video.pause()
    video.style.opacity = '0'
    if (video.getAttribute('src')) {
      video.removeAttribute('src')
      video.load()
    }
  })
}

function onIndex(index: number) {
  selectedIndex.value = index
  syncLeft(templates[index])
  syncVideos(index)
}

onMounted(async () => {
  try {
    await nextTick()
    await loadRevolverScript()
    const host = revolverWindow()
    host.__revolverOnIndex = onIndex
    host.__revolverUseTemplate = () => {
      const template = templates[selectedIndex.value]
      if (template) navigateTo(`/templates/${template.slug}`)
    }
    host.__revolverMount?.()
    const section = sectionEl()
    if (section) decorateStage(section)
    onIndex(selectedIndex.value)
    window.addEventListener('resize', onResize)
  }
  catch (error) {
    console.error(error)
  }
})

function onResize() {
  syncVideos(selectedIndex.value)
}

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  const host = revolverWindow()
  host.__revolverOnIndex = undefined
  host.__revolverUseTemplate = undefined
  sectionEl()?.querySelectorAll<HTMLVideoElement>('video.rev-card-video').forEach((video) => {
    video.pause()
    video.removeAttribute('src')
    video.load()
  })
  host.__revolverUnmount?.()
})
</script>

<template>
  <!-- The carousel script binds refs by walking this captured element tree. -->
  <div class="revolver-landing" v-html="markup" />
</template>

<style>
.revolver-landing [data-rev-scope] {
  height: 100svh;
}

.revolver-landing [data-rev-stage] {
  top: 64px !important;
  bottom: 24px !important;
  perspective-origin: 50% 50% !important;
}

.revolver-landing [data-rev-card] {
  aspect-ratio: 9 / 16;
  height: auto !important;
  border-radius: var(--rev-cardr);
  box-shadow: 0 12px 32px rgb(12 10 8 / 12%), 0 2px 8px rgb(12 10 8 / 8%);
}

.revolver-landing [data-rev-scope]:not([data-rev-portrait-ready]) [data-rev-card] {
  visibility: hidden !important;
}

.revolver-landing [data-rev-card] > div:first-child {
  backface-visibility: hidden;
}

@media (max-width: 767px) {
  .revolver-landing [data-rev-scope] {
    display: flex;
    flex-direction: column;
    height: auto;
    min-height: 100svh;
    padding-bottom: 72px;
  }

  .revolver-landing [data-rev-hero] {
    position: relative !important;
    inset: auto !important;
    order: 0;
    margin: 0 24px;
    padding-top: 104px;
  }

  .revolver-landing [data-rev-stage] {
    position: relative !important;
    inset: auto !important;
    order: 1;
    flex: none;
    width: 100%;
    height: min(540px, 66svh);
    margin: 24px 0 20px;
    overflow: visible !important;
    mask-image: none !important;
    -webkit-mask-image: none !important;
  }

  .revolver-landing [data-rev-caption] {
    position: relative !important;
    inset: auto !important;
    order: 2;
    margin: 0 24px;
  }
}

@media (max-width: 767px) and (max-height: 740px) {
  .revolver-landing [data-rev-hero] h1 {
    font-size: 30px !important;
  }

  .revolver-landing [data-rev-hero] > div[data-rev-reveal] {
    margin-top: 16px !important;
  }
}
</style>
