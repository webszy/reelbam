/** Public template catalog. Safe for the client, the list, and detail pages. No generation prompts. */

export type TemplateStatus = 'draft' | 'published' | 'archived'
export type TemplateFieldType = 'text' | 'textarea' | 'select'

export interface TemplateFieldOption {
  value: string
  label: string
}

export interface TemplateInputField {
  key: string
  label: string
  type: TemplateFieldType
  placeholder?: string
  required: boolean
  defaultValue?: string
  maxLength?: number
  options?: readonly TemplateFieldOption[]
}

export interface TemplateGenerationOptions {
  aspectRatio: string
  duration: number
}

export interface PublicTemplate {
  id: string
  slug: string
  title: string
  description: string
  category: string
  tags: readonly string[]
  posterUrl: string
  previewVideoUrl: string
  /** Measured poster size for the local demo file. Omit when unknown. */
  posterWidth?: number
  posterHeight?: number
  /** ffprobe duration of previewVideoUrl. Omit when it has not been measured. */
  previewDurationSeconds?: number
  /** Calendar date the preview file was added. Omit when unknown. */
  previewUploadDate?: string
  inputFields: readonly TemplateInputField[]
  generationOptions: TemplateGenerationOptions
  seoTitle: string
  seoDescription: string
  ogImage?: string
  featured: boolean
  publishedAt: string
  status: TemplateStatus
}

/** Wheel-only presentation. Not part of the public template contract. */
export interface TemplateWheelTheme {
  backBg: string
  backInk: string
  sheenHue: string
  sheenBlend: string
}

/** ffprobe format.duration on 2026-10-31 for every file in public/assets/templates. */
const DEMO_PREVIEW_DURATION_SECONDS = 6.041667
const DEMO_PREVIEW_UPLOAD_DATE = '2026-10-31'
const DEMO_POSTER = { posterWidth: 720, posterHeight: 1280 } as const
const VERTICAL_6S: TemplateGenerationOptions = { aspectRatio: '9:16', duration: 6 }

function textFields(character: string, action: string, details: string): TemplateInputField[] {
  return [
    { key: 'character', label: 'Character', type: 'text', placeholder: character, required: true, maxLength: 80 },
    { key: 'action', label: 'Action', type: 'text', placeholder: action, required: true, maxLength: 140 },
    { key: 'details', label: 'Additional details', type: 'textarea', placeholder: details, required: false, maxLength: 280 },
  ]
}

export const DEMO_TEMPLATES: readonly PublicTemplate[] = [
  {
    id: 'tmpl_01_night_walk',
    slug: 'night-walk',
    title: 'Night Walk',
    description: 'A quiet neon street, wet pavement, and a slow walk into the lights.',
    category: 'Cinematic',
    tags: ['night', 'street', 'cinematic'],
    posterUrl: '/assets/templates/night-walk/poster.jpg',
    previewVideoUrl: '/assets/templates/night-walk/preview.mp4',
    ...DEMO_POSTER,
    previewDurationSeconds: DEMO_PREVIEW_DURATION_SECONDS,
    previewUploadDate: DEMO_PREVIEW_UPLOAD_DATE,
    inputFields: textFields('A person in a dark coat', 'Walks slowly toward the neon', 'Rain on the pavement, no extra crowd'),
    generationOptions: VERTICAL_6S,
    seoTitle: 'Night Walk AI Video Template',
    seoDescription: 'A quiet neon street, wet pavement, and a slow walk into the lights. Describe the character and action for this 9:16 template.',
    featured: true,
    publishedAt: '2026-10-12T00:00:00.000Z',
    status: 'published',
  },
  {
    id: 'tmpl_02_product_orbit',
    slug: 'product-orbit',
    title: 'Product Orbit',
    description: 'A clean studio turnaround for a single object on a dark set.',
    category: 'Commerce',
    tags: ['product', 'studio', 'commerce'],
    posterUrl: '/assets/templates/product-orbit/poster.jpg',
    previewVideoUrl: '/assets/templates/product-orbit/preview.mp4',
    ...DEMO_POSTER,
    previewDurationSeconds: DEMO_PREVIEW_DURATION_SECONDS,
    previewUploadDate: DEMO_PREVIEW_UPLOAD_DATE,
    inputFields: textFields('A matte black bottle', 'Turns once on a dark table', 'Soft rim light, no label text'),
    generationOptions: VERTICAL_6S,
    seoTitle: 'Product Orbit AI Video Template',
    seoDescription: 'A clean studio turnaround for a single object on a dark set. Name the product and the move for this 9:16 template.',
    featured: true,
    publishedAt: '2026-10-14T00:00:00.000Z',
    status: 'published',
  },
  {
    id: 'tmpl_03_steam_kitchen',
    slug: 'steam-kitchen',
    title: 'Steam Kitchen',
    description: 'Close-up cooking with rising steam and warm counter light.',
    category: 'Food',
    tags: ['food', 'kitchen', 'close-up'],
    posterUrl: '/assets/templates/steam-kitchen/poster.jpg',
    previewVideoUrl: '/assets/templates/steam-kitchen/preview.mp4',
    ...DEMO_POSTER,
    previewDurationSeconds: DEMO_PREVIEW_DURATION_SECONDS,
    previewUploadDate: DEMO_PREVIEW_UPLOAD_DATE,
    inputFields: textFields('A cook at a small stove', 'Lifts the lid as steam rises', 'Warm counter light, one pan in frame'),
    generationOptions: VERTICAL_6S,
    seoTitle: 'Steam Kitchen AI Video Template',
    seoDescription: 'Close-up cooking with rising steam and warm counter light. Describe the cook and the action for this 9:16 template.',
    featured: true,
    publishedAt: '2026-10-16T00:00:00.000Z',
    status: 'published',
  },
  {
    id: 'tmpl_04_soft_portrait',
    slug: 'soft-portrait',
    title: 'Soft Portrait',
    description: 'A window-lit portrait with a gentle push-in and shallow focus.',
    category: 'Portrait',
    tags: ['portrait', 'soft-light', 'beauty'],
    posterUrl: '/assets/templates/soft-portrait/poster.jpg',
    previewVideoUrl: '/assets/templates/soft-portrait/preview.mp4',
    ...DEMO_POSTER,
    previewDurationSeconds: DEMO_PREVIEW_DURATION_SECONDS,
    previewUploadDate: DEMO_PREVIEW_UPLOAD_DATE,
    inputFields: textFields('A person by a bright window', 'Looks off camera as the frame moves closer', 'Shallow focus, no text overlay'),
    generationOptions: VERTICAL_6S,
    seoTitle: 'Soft Portrait AI Video Template',
    seoDescription: 'A window-lit portrait with a gentle push-in and shallow focus. Describe the subject and the action for this 9:16 template.',
    featured: true,
    publishedAt: '2026-10-18T00:00:00.000Z',
    status: 'published',
  },
  {
    id: 'tmpl_05_desk_ritual',
    slug: 'desk-ritual',
    title: 'Desk Ritual',
    description: 'Morning workspace details: coffee, paper, and a slow top-down drift.',
    category: 'Lifestyle',
    tags: ['desk', 'lifestyle', 'morning'],
    posterUrl: '/assets/templates/desk-ritual/poster.jpg',
    previewVideoUrl: '/assets/templates/desk-ritual/preview.mp4',
    ...DEMO_POSTER,
    previewDurationSeconds: DEMO_PREVIEW_DURATION_SECONDS,
    previewUploadDate: DEMO_PREVIEW_UPLOAD_DATE,
    inputFields: textFields('Hands over a morning desk', 'Sets down a cup and opens a notebook', 'Top-down drift, paper and coffee only'),
    generationOptions: VERTICAL_6S,
    seoTitle: 'Desk Ritual AI Video Template',
    seoDescription: 'Morning workspace details: coffee, paper, and a slow top-down drift. Describe the subject and action for this 9:16 template.',
    featured: true,
    publishedAt: '2026-10-20T00:00:00.000Z',
    status: 'published',
  },
  {
    id: 'tmpl_06_coastal_haze',
    slug: 'coastal-haze',
    title: 'Coastal Haze',
    description: 'Golden-hour cliffs, drifting haze, and a wide coastal hold.',
    category: 'Travel',
    tags: ['coast', 'travel', 'golden-hour'],
    posterUrl: '/assets/templates/coastal-haze/poster.jpg',
    previewVideoUrl: '/assets/templates/coastal-haze/preview.mp4',
    ...DEMO_POSTER,
    previewDurationSeconds: DEMO_PREVIEW_DURATION_SECONDS,
    previewUploadDate: DEMO_PREVIEW_UPLOAD_DATE,
    inputFields: textFields('A hiker on a coastal path', 'Stands still while haze crosses the cliff', 'Golden-hour light, no extra titles'),
    generationOptions: VERTICAL_6S,
    seoTitle: 'Coastal Haze AI Video Template',
    seoDescription: 'Golden-hour cliffs, drifting haze, and a wide coastal hold. Describe the subject and action for this 9:16 template.',
    featured: true,
    publishedAt: '2026-10-22T00:00:00.000Z',
    status: 'published',
  },
  {
    id: 'tmpl_07_neon_night',
    slug: 'neon-night',
    title: 'Neon Night',
    description: 'A vertical night walk: wet pavement, colored signs, and a slow move into the light.',
    category: 'Cinematic',
    tags: ['neon', 'night', 'street', 'text-to-video'],
    posterUrl: '/assets/templates/night-walk/poster.jpg',
    previewVideoUrl: '/assets/templates/night-walk/preview.mp4',
    ...DEMO_POSTER,
    previewDurationSeconds: DEMO_PREVIEW_DURATION_SECONDS,
    previewUploadDate: DEMO_PREVIEW_UPLOAD_DATE,
    ogImage: '/assets/templates/night-walk/poster.jpg',
    inputFields: [
      { key: 'character', label: 'Character', type: 'text', placeholder: 'A courier in a silver jacket', required: true, maxLength: 80 },
      { key: 'action', label: 'Action', type: 'text', placeholder: 'Walks through the rain toward a neon sign', required: true, maxLength: 140 },
      {
        key: 'mood',
        label: 'Mood',
        type: 'select',
        required: false,
        defaultValue: 'quiet',
        options: [
          { value: 'quiet', label: 'Quiet' },
          { value: 'hurried', label: 'In a hurry' },
          { value: 'looking-back', label: 'Looking back' },
        ],
      },
      { key: 'details', label: 'Additional details', type: 'textarea', placeholder: 'Magenta signage, rain on the lens, no extra crowd', required: false, maxLength: 280 },
    ],
    generationOptions: VERTICAL_6S,
    seoTitle: 'Neon Night AI Video Template',
    seoDescription: 'Make a vertical neon night walk from a few text fields. Reelbam keeps the wet street, the signs, and the 9:16 frame. Video generation is not open yet.',
    featured: false,
    publishedAt: '2026-10-31T00:00:00.000Z',
    status: 'published',
  },
  {
    id: 'tmpl_08_lantern_draft',
    slug: 'lantern-draft',
    title: 'Lantern Draft',
    description: 'Unpublished draft. This template must not be indexed or shown.',
    category: 'Cinematic',
    tags: ['draft'],
    posterUrl: '/assets/templates/night-walk/poster.jpg',
    previewVideoUrl: '/assets/templates/night-walk/preview.mp4',
    inputFields: textFields('Draft subject', 'Draft action', 'Draft detail'),
    generationOptions: VERTICAL_6S,
    seoTitle: 'Lantern Draft',
    seoDescription: 'Draft template. Not for publication.',
    featured: false,
    publishedAt: '2026-10-31T00:00:00.000Z',
    status: 'draft',
  },
]

export const TEMPLATE_WHEEL_THEMES: Readonly<Record<string, TemplateWheelTheme>> = {
  tmpl_01_night_walk: {
    backBg: 'linear-gradient(165deg,#0b1020,#1a2340)',
    backInk: '#dce7ff',
    sheenHue: 'rgba(180,210,255,0.42)',
    sheenBlend: 'screen',
  },
  tmpl_02_product_orbit: {
    backBg: 'linear-gradient(165deg,#161616,#2a2a2a)',
    backInk: '#f0f0ef',
    sheenHue: 'rgba(240,242,244,0.4)',
    sheenBlend: 'screen',
  },
  tmpl_03_steam_kitchen: {
    backBg: 'linear-gradient(165deg,#3a220e,#7a4a1c)',
    backInk: '#ffe8c8',
    sheenHue: 'rgba(255,214,160,0.45)',
    sheenBlend: 'screen',
  },
  tmpl_04_soft_portrait: {
    backBg: 'linear-gradient(165deg,#4a2e36,#d7a8b4)',
    backInk: '#fff1f4',
    sheenHue: 'rgba(255,214,228,0.5)',
    sheenBlend: 'screen',
  },
  tmpl_05_desk_ritual: {
    backBg: 'linear-gradient(165deg,#edf1f1,#f8f9f8)',
    backInk: '#262b2c',
    sheenHue: 'rgba(70,84,88,0.4)',
    sheenBlend: 'multiply',
  },
  tmpl_06_coastal_haze: {
    backBg: 'linear-gradient(165deg,#1b4a4e,#e2b15a)',
    backInk: '#fff6e4',
    sheenHue: 'rgba(255,224,170,0.45)',
    sheenBlend: 'screen',
  },
}

export function isPublishedTemplate(template: PublicTemplate): boolean {
  return template.status === 'published'
}

export function listPublishedTemplates(): PublicTemplate[] {
  return DEMO_TEMPLATES.filter(isPublishedTemplate)
}

export function listFeaturedTemplates(): PublicTemplate[] {
  return listPublishedTemplates().filter(template => template.featured)
}

export function getTemplateBySlug(slug: string): PublicTemplate | undefined {
  return DEMO_TEMPLATES.find(template => template.slug === slug)
}

export function getPublishedTemplateBySlug(slug: string): PublicTemplate | undefined {
  const template = getTemplateBySlug(slug)
  return template && isPublishedTemplate(template) ? template : undefined
}

export function getTemplateById(id: string): PublicTemplate | undefined {
  return DEMO_TEMPLATES.find(template => template.id === id)
}

export function toWheelCard(template: PublicTemplate) {
  const theme = TEMPLATE_WHEEL_THEMES[template.id]
  return {
    name: template.title,
    img: template.posterUrl,
    caption: template.description,
    backBg: theme?.backBg ?? 'linear-gradient(165deg,#111,#222)',
    backInk: theme?.backInk ?? '#f5f5f5',
    sheenHue: theme?.sheenHue ?? 'rgba(255,255,255,0.4)',
    sheenBlend: theme?.sheenBlend ?? 'screen',
  }
}
