type AnalyticsWindow = Window & { dataLayer?: unknown[], gtag?: (...args: unknown[]) => void }

function analyticsUrl(value: string) {
  try {
    const url = new URL(value)
    return /^https?:$/.test(url.protocol) ? `${url.origin}${url.pathname}` : ''
  } catch {
    return ''
  }
}

export default defineNuxtPlugin((nuxtApp) => {
  const measurementId = 'G-SNYP5DWY31'
  const target = window as AnalyticsWindow
  target.dataLayer ??= []
  target.gtag ??= function () {
    // gtag.js expects an Arguments object for each queued command.
    // eslint-disable-next-line prefer-rest-params
    target.dataLayer!.push(arguments)
  }
  let previousLocation = analyticsUrl(document.referrer)
  target.gtag('js', new Date())
  target.gtag('config', measurementId, {
    send_page_view: false,
    page_location: `${window.location.origin}${window.location.pathname}`,
    page_referrer: previousLocation,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  })
  const script = document.createElement('script')
  script.async = true
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`
  document.head.append(script)

  const head = injectHead()
  let lastPath = ''
  async function trackPageView() {
    // Nuxt updates the head after resolving a page; wait for its title.
    await nextTick()
    await head?.render()
    const path = window.location.pathname
    if (path === lastPath) return
    lastPath = path
    // Do not send checkout IDs, auth hashes or other query parameters to analytics.
    const page = {
      page_location: `${window.location.origin}${path}`,
      page_path: path,
      page_title: document.title,
      page_referrer: previousLocation,
    }
    target.gtag?.('set', page)
    target.gtag?.('event', 'page_view', { ...page, send_to: measurementId })
    previousLocation = page.page_location
  }
  // Initial hydration and subsequent navigation share the same deduplication.
  onNuxtReady(trackPageView)
  nuxtApp.hook('page:finish', () => {
    if (!nuxtApp.isHydrating) return trackPageView()
  })
})
