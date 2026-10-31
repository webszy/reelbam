import {
  getPublishedTemplateBySlug,
  listPublishedTemplates,
  type PublicTemplate,
} from './templates'

export interface TemplateSample {
  videoUrl: string
  posterUrl: string
  label: string
  description: string
  credit: string
  durationSeconds?: number
  uploadDate?: string
}

export interface TemplateCopyBlock {
  eyebrow: string
  title: string
}

export interface TemplatePage {
  h1: string
  subtitle: string
  badge: string
  chips: readonly string[]
  sampleNote: string
  samples: readonly TemplateSample[]
  problem?: TemplateCopyBlock & { items: readonly { title: string; body: string }[] }
  compare?: TemplateCopyBlock & {
    withoutLabel: string
    withLabel: string
    rows: readonly { without: string; with: string }[]
  }
  howTo: TemplateCopyBlock & {
    steps: readonly { title: string; body: string }[]
    cta: string
  }
  showcase: TemplateCopyBlock & {
    body: string
    beforeLabel: string
    beforeText: string
    afterLabel: string
  }
  about: TemplateCopyBlock & { paragraphs: readonly string[] }
  features: TemplateCopyBlock & { items: readonly { title: string; body: string }[] }
  scenes?: TemplateCopyBlock & {
    cta: string
    items: readonly { title: string; body: string; sample?: TemplateSample }[]
  }
  faq: { title: string; body: string; items: readonly { q: string; a: string }[] }
  relatedSlugs: readonly string[]
  finalCta: { title: string; body: string; cta: string }
}

export interface TemplateView {
  template: PublicTemplate
  page: TemplatePage
  related: PublicTemplate[]
}

const neonNightSample: TemplateSample = {
  videoUrl: '/assets/templates/night-walk/preview.mp4',
  posterUrl: '/assets/templates/night-walk/poster.jpg',
  label: 'Neon Night preview',
  description: 'A Reelbam demo of a slow night walk on wet pavement under colored signs.',
  credit: 'Reelbam demo preview, the same file as Night Walk. Not a render from this form.',
  durationSeconds: 6.041667,
  uploadDate: '2026-10-31',
}

const neonNightPage: TemplatePage = {
  h1: 'Neon Night AI Video',
  subtitle: 'Name the character and the action. This template keeps the vertical night street: wet pavement, colored signs, and a slow walk into the light.',
  badge: 'Trending on TikTok',
  chips: ['Vertical 9:16', 'Preset 6 second look', 'Text in, no photo'],
  sampleNote: 'The clip on this page is a Reelbam demo. It shows the intended look. It is not a video generated from the form.',
  samples: [neonNightSample],
  problem: {
    eyebrow: 'The catch',
    title: 'A night street clip is awkward to shoot on purpose',
    items: [
      { title: 'The pavement has to be wet', body: 'Dry concrete and a clear sky do not read as this template. Rain, reflections, and colored light are the whole point.' },
      { title: 'The pace is easy to miss', body: 'A fast walk turns the shot into a pass-by. The template is built around a slow move toward the signs.' },
      { title: 'Vertical framing is unforgiving', body: 'A landscape phone clip crops the signs and the stride. Reshooting it again at night takes another trip.' },
    ],
  },
  compare: {
    eyebrow: 'Side by side',
    title: 'Shooting the walk vs. using Neon Night',
    withoutLabel: 'Shoot it yourself',
    withLabel: 'With Neon Night',
    rows: [
      { without: 'Find a rainy street after dark', with: 'Start from the preset night street' },
      { without: 'Direct the person and the pace', with: 'Write the character and the action' },
      { without: 'Reshoot until the frame is vertical', with: 'The frame stays 9:16' },
      { without: 'Trim a hook in another app', with: 'The preset length is already a short clip' },
    ],
  },
  howTo: {
    eyebrow: 'How it works',
    title: 'How to make a Neon Night video',
    steps: [
      { title: 'Name the character', body: 'Say who or what is in the frame. One subject is enough.' },
      { title: 'Describe the action', body: 'Say what they do on the street. The template keeps the signs, the wet ground, and the pace.' },
      { title: 'Check the form', body: 'Generation is not open yet. A valid form stays in this browser. No video is created and no credits are used.' },
    ],
    cta: 'Back to the form',
  },
  showcase: {
    eyebrow: 'The look',
    title: 'Words in, a night clip out',
    body: 'You do not upload a photo. The street, the light, and the pace already belong to the template. Your text says who is there and what they do.',
    beforeLabel: 'What you write',
    beforeText: 'Character: a courier in a silver jacket\nAction: walks toward a magenta sign\nMood: quiet\nDetails: rain on the lens, no extra crowd',
    afterLabel: 'Template preview',
  },
  about: {
    eyebrow: 'About this template',
    title: 'What Neon Night is',
    paragraphs: [
      'Neon Night is a Reelbam text-to-video template for a short vertical night walk. The scene stays fixed: a dark street, wet ground, and colored light. You change the subject and the action with a few fields.',
      'The page does not show the internal prompt or a model picker. Those stay on the server for a later generation API. This version only checks the form.',
    ],
  },
  features: {
    eyebrow: 'Features',
    title: 'What this template keeps still',
    items: [
      { title: 'Text instead of a photo', body: 'Character, action, mood, and optional detail. There is no upload step.' },
      { title: 'The street stays put', body: 'Wet pavement, neon signs, and the slow walk are the template. Your fields do not rebuild the location from scratch.' },
      { title: 'Vertical and ready to post', body: 'The preset frame is 9:16, the shape used by TikTok, Reels, and Shorts.' },
      { title: 'Length is preset', body: 'The demo look is 6 seconds. This page does not ask you to pick a model or edit a timeline.' },
      { title: 'Nothing is sent yet', body: 'While generation is closed, the form does not upload your text or start a job.' },
      { title: 'No credit charge here', body: 'Reelbam sells credit packs on the pricing page. This form does not quote or spend a per-video cost.' },
    ],
  },
  scenes: {
    eyebrow: 'Uses',
    title: 'Ways to use the night walk',
    cta: 'Fill the form',
    items: [
      { title: 'Open a city clip', body: 'Use the walk as the first shot of a night vlog, then cut to the place you actually filmed.', sample: neonNightSample },
      { title: 'Introduce a night product', body: 'Put a courier or a single object in the street and keep the signs as the background.' },
      { title: 'Cut a short hook', body: 'The preset length is a hook, not a full scene. Write one action, not a plot.' },
    ],
  },
  faq: {
    title: 'Questions, answered',
    body: 'Generation is closed on this page. Credit packs, when purchases are open, live on the pricing page.',
    items: [
      { q: 'What is Neon Night?', a: 'Neon Night is a Reelbam template for a vertical night-street walk. You describe the character and the action. The wet pavement, signs, and pace stay with the template.' },
      { q: 'Do I upload a photo?', a: 'No. This template is text-to-video. The form asks for words, not a picture or a reference clip.' },
      { q: 'Can I generate a video now?', a: 'No. The Generate video button checks the fields and then stops. It does not create a video, start a job, or use credits.' },
      { q: 'How long is the clip, and what shape is it?', a: 'The preset is 9:16 and 6 seconds. Those values are fixed for this template. The preview file measures about 6.04 seconds.' },
      { q: 'Where is the full prompt?', a: 'The internal prompt stays on the server. The form does not include a prompt editor, and this page does not print the prompt.' },
      { q: 'Will this spend credits?', a: 'No. There is no reliable per-video price on this page, so it does not show one and does not charge. Pack prices are only listed on the pricing page.' },
    ],
  },
  relatedSlugs: ['night-walk', 'steam-kitchen', 'coastal-haze'],
  finalCta: {
    title: 'Write the night walk',
    body: 'Character, action, and any extra detail. The button checks the form. It will not render a video until generation is open.',
    cta: 'Go to the form',
  },
}

const PAGE_OVERRIDES: Readonly<Record<string, TemplatePage>> = {
  'neon-night': neonNightPage,
}

function demoSample(template: PublicTemplate): TemplateSample {
  return {
    videoUrl: template.previewVideoUrl,
    posterUrl: template.posterUrl,
    label: `${template.title} preview`,
    description: template.description,
    credit: 'Reelbam demo preview. Not a customer render.',
    durationSeconds: template.previewDurationSeconds,
    uploadDate: template.previewUploadDate,
  }
}

function fallbackPage(template: PublicTemplate): TemplatePage {
  const sample = demoSample(template)
  const ratio = template.generationOptions.aspectRatio
  const seconds = template.generationOptions.duration
  return {
    h1: `${template.title} AI Video`,
    subtitle: template.description,
    badge: template.category,
    chips: [...template.tags, ratio],
    sampleNote: `This ${template.title} preview is a Reelbam demo clip. The form does not generate it.`,
    samples: [sample],
    problem: {
      eyebrow: 'The catch',
      title: `Getting a ${template.title} shot takes more than pressing record`,
      items: [
        { title: 'The setup is specific', body: template.description },
        { title: 'The frame is easy to miss', body: `${template.title} is built as a ${ratio} clip. A casual landscape take usually crops the subject.` },
        { title: 'One action is enough', body: 'A long performance is hard to trim into the preset length. The template wants a single clear move.' },
      ],
    },
    compare: {
      eyebrow: 'Side by side',
      title: `Filming ${template.title} vs. using the template`,
      withoutLabel: 'Film it yourself',
      withLabel: `With ${template.title}`,
      rows: [
        { without: 'Build the set and the light', with: 'Start from the preset look' },
        { without: 'Direct the subject on camera', with: 'Write the character and the action' },
        { without: `Reframe for ${ratio}`, with: `The frame stays ${ratio}` },
        { without: 'Edit the length afterward', with: `The preset length is ${seconds} seconds` },
      ],
    },
    howTo: {
      eyebrow: 'How it works',
      title: `How to make a ${template.title} video`,
      steps: [
        { title: 'Name the character', body: `Say who or what appears in ${template.title}.` },
        { title: 'Describe the action', body: 'One move is enough. Extra detail is optional.' },
        { title: 'Check the form', body: 'Generation is not open yet. Checking the form does not create a video or use credits.' },
      ],
      cta: 'Back to the form',
    },
    showcase: {
      eyebrow: 'The look',
      title: `Words in, a ${template.title} clip out`,
      body: `${template.description} You describe the subject. The template keeps the setup.`,
      beforeLabel: 'What you write',
      beforeText: `Character: the subject of ${template.title}\nAction: one clear move\nDetails: optional`,
      afterLabel: 'Template preview',
    },
    about: {
      eyebrow: 'About this template',
      title: `What ${template.title} is`,
      paragraphs: [
        `${template.title} is a Reelbam ${template.category.toLowerCase()} template. ${template.description}`,
        'The fields on this page are the only public inputs. The internal prompt and model settings stay on the server, and this version does not call a generator.',
      ],
    },
    features: {
      eyebrow: 'Features',
      title: `What ${template.title} keeps still`,
      items: [
        { title: 'Text fields', body: 'Fill the labeled fields. There is no photo upload and no prompt box.' },
        { title: 'Preset frame', body: `The aspect ratio is ${ratio}.` },
        { title: 'Preset length', body: `The template length is ${seconds} seconds.` },
        { title: 'Closed generation', body: 'The button validates text only. It does not start a render.' },
      ],
    },
    scenes: {
      eyebrow: 'Uses',
      title: `Ways to use ${template.title}`,
      cta: 'Fill the form',
      items: [
        { title: `Lead with ${template.title}`, body: template.description, sample },
        { title: 'Change only the subject', body: `Keep the ${template.category.toLowerCase()} setup and rewrite the character and action.` },
      ],
    },
    faq: {
      title: 'Questions, answered',
      body: 'Generation is closed on this page. This form does not show a per-video credit cost.',
      items: [
        { q: `What is ${template.title}?`, a: `${template.title} is a Reelbam template. ${template.description}` },
        { q: 'Do I upload a photo?', a: 'No. The public inputs are text fields defined for this template.' },
        { q: 'Can I generate a video now?', a: 'No. The button checks the form and stops. It does not create a video or use credits.' },
        { q: 'What frame and length does it use?', a: `${template.title} is preset to ${ratio} and ${seconds} seconds.` },
      ],
    },
    relatedSlugs: [],
    finalCta: {
      title: `Write a ${template.title} clip`,
      body: 'The form checks your text. Video generation is not open, and nothing is charged.',
      cta: 'Go to the form',
    },
  }
}

export function resolveTemplateView(slug: string): TemplateView | undefined {
  const template = getPublishedTemplateBySlug(slug)
  if (!template) return undefined
  const page = PAGE_OVERRIDES[template.slug] ?? fallbackPage(template)
  const slugs = page.relatedSlugs.length > 0
    ? page.relatedSlugs
    : listPublishedTemplates().filter(item => item.slug !== template.slug).slice(0, 3).map(item => item.slug)
  const related = slugs
    .map(item => getPublishedTemplateBySlug(item))
    .filter((item): item is PublicTemplate => item !== undefined && item.slug !== template.slug)
  return { template, page, related }
}
