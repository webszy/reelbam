import type { TemplateSample, TemplateView } from './template-view'

export function absoluteSiteUrl(siteUrl: string, path: string): string {
  return new URL(path, siteUrl).href
}

export function templateCanonical(siteUrl: string, slug: string): string {
  return absoluteSiteUrl(siteUrl, `/templates/${slug}`)
}

function isoDuration(seconds: number): string {
  const rounded = Math.round(seconds * 1000) / 1000
  return `PT${rounded}S`
}

export function isQualifiedVideoSample(sample: TemplateSample): boolean {
  if (!sample.videoUrl.startsWith('/') && !sample.videoUrl.startsWith('https://')) return false
  if (!sample.posterUrl.startsWith('/') && !sample.posterUrl.startsWith('https://')) return false
  if (!sample.label.trim() || !sample.description.trim() || !sample.credit.trim()) return false
  if (sample.durationSeconds === undefined || !Number.isFinite(sample.durationSeconds) || sample.durationSeconds <= 0) return false
  if (!sample.uploadDate || !/^\d{4}-\d{2}-\d{2}$/.test(sample.uploadDate)) return false
  return true
}

export function templateStructuredData(view: TemplateView, siteUrl: string, siteName: string): Record<string, unknown> {
  const url = templateCanonical(siteUrl, view.template.slug)
  const origin = new URL(siteUrl).origin
  const graph: Record<string, unknown>[] = [
    {
      '@type': 'WebPage',
      name: view.template.seoTitle,
      description: view.template.seoDescription,
      url,
      inLanguage: 'en',
      isPartOf: { '@type': 'WebSite', name: siteName, url: origin },
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: absoluteSiteUrl(siteUrl, '/') },
        { '@type': 'ListItem', position: 2, name: 'Templates', item: absoluteSiteUrl(siteUrl, '/templates') },
        { '@type': 'ListItem', position: 3, name: view.template.title, item: url },
      ],
    },
  ]
  if (view.page.faq.items.length > 0) {
    graph.push({
      '@type': 'FAQPage',
      mainEntity: view.page.faq.items.map(item => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a },
      })),
    })
  }
  for (const sample of view.page.samples) {
    if (!isQualifiedVideoSample(sample)) continue
    graph.push({
      '@type': 'VideoObject',
      name: sample.label,
      description: sample.description,
      thumbnailUrl: absoluteSiteUrl(siteUrl, sample.posterUrl),
      contentUrl: absoluteSiteUrl(siteUrl, sample.videoUrl),
      uploadDate: sample.uploadDate,
      duration: isoDuration(sample.durationSeconds!),
      inLanguage: 'en',
    })
  }
  return { '@context': 'https://schema.org', '@graph': graph }
}

export function jsonLdInnerHtml(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}
