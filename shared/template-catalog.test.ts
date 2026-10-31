import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { validateTemplateFields } from './template-form.ts'
import { isQualifiedVideoSample, templateStructuredData } from './template-seo.ts'
import { getPublishedTemplateBySlug, getTemplateBySlug, listFeaturedTemplates, listPublishedTemplates } from './templates.ts'
import { resolveTemplateView } from './template-view.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('published catalog keeps the six featured wheel templates and adds Neon Night', () => {
  assert.deepEqual(listFeaturedTemplates().map(template => template.slug), [
    'night-walk',
    'product-orbit',
    'steam-kitchen',
    'soft-portrait',
    'desk-ritual',
    'coastal-haze',
  ])
  assert.equal(listPublishedTemplates().some(template => template.slug === 'neon-night'), true)
  assert.equal(listPublishedTemplates().some(template => template.slug === 'lantern-draft'), false)
  assert.equal(getTemplateBySlug('lantern-draft')?.status, 'draft')
  assert.equal(getPublishedTemplateBySlug('lantern-draft'), undefined)
  assert.equal(resolveTemplateView('lantern-draft'), undefined)
  assert.equal(resolveTemplateView('missing-template'), undefined)
})

test('Neon Night page is its own copy and does not expose a prompt', () => {
  const neon = resolveTemplateView('neon-night')
  const night = resolveTemplateView('night-walk')
  assert.ok(neon)
  assert.ok(night)
  assert.equal(neon.page.h1, 'Neon Night AI Video')
  assert.notEqual(neon.page.h1, night.page.h1)
  assert.notEqual(neon.page.faq.items[0]?.q, night.page.faq.items[0]?.q)
  assert.deepEqual(neon.template.inputFields.map(field => field.type), ['text', 'text', 'select', 'textarea'])
  assert.equal(neon.template.generationOptions.aspectRatio, '9:16')
  assert.equal(neon.template.generationOptions.duration, 6)
  assert.equal('credits' in neon.template.generationOptions, false)
  const blob = JSON.stringify(neon) + JSON.stringify(night)
  assert.equal(blob.includes('internal-template-prompt'), false)
  assert.deepEqual(neon.related.map(item => item.slug), ['night-walk', 'steam-kitchen', 'coastal-haze'])
})

test('template fields validate text, length, and select options', () => {
  const fields = getPublishedTemplateBySlug('neon-night')!.inputFields
  assert.deepEqual(Object.keys(validateTemplateFields(fields, { character: '', action: '', mood: 'quiet', details: '' })), ['character', 'action'])
  const long = { character: 'courier', action: 'walks', mood: 'quiet', details: 'x'.repeat(281) }
  assert.match(validateTemplateFields(fields, long).details ?? '', /280/)
  assert.ok(validateTemplateFields(fields, { character: 'courier', action: 'walks', mood: 'nope', details: '' }).mood)
  assert.deepEqual(validateTemplateFields(fields, { character: ' courier ', action: 'walks', mood: '', details: '' }), {})
})

test('VideoObject is emitted only for measured preview files', () => {
  const neon = resolveTemplateView('neon-night')
  assert.ok(neon)
  const data = templateStructuredData(neon, 'https://reelbam.app', 'reelbam')
  const graph = data['@graph'] as Array<Record<string, unknown>>
  const videos = graph.filter(item => item['@type'] === 'VideoObject')
  assert.equal(videos.length, 1)
  assert.equal(videos[0]?.contentUrl, 'https://reelbam.app/assets/templates/night-walk/preview.mp4')
  assert.equal(videos[0]?.duration, 'PT6.042S')
  assert.equal(isQualifiedVideoSample({ ...neon.page.samples[0]!, durationSeconds: undefined }), false)
  const webpage = graph.find(item => item['@type'] === 'WebPage')
  assert.equal(webpage?.url, 'https://reelbam.app/templates/neon-night')
})

test('app code does not contain the private prompt marker', () => {
  const appDir = path.join(root, 'app')
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(vue|ts|css)$/.test(entry)) files.push(full)
    }
  }
  walk(appDir)
  const sharedDir = path.join(root, 'shared')
  for (const entry of readdirSync(sharedDir)) {
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) files.push(path.join(sharedDir, entry))
  }
  const blob = files.map(file => readFileSync(file, 'utf8')).join('\n')
  assert.equal(blob.includes('internal-template-prompt'), false)
})
