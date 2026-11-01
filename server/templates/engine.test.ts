import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import type { CreateGenerationCommand } from '../services/video/create-generation.ts'
import { createLocalMockRegistries } from '../../packages/video-core/src/development-catalog.ts'
import { ProviderRouter } from '../../packages/video-core/src/router.ts'
import { ProviderRegistry } from '../../packages/video-core/src/providers/registry.ts'
import type { ProviderAdapter } from '../../packages/video-core/src/provider.ts'
import { validateGenerationInput } from '../../packages/video-core/src/validation.ts'
import { validateTemplateRegistry } from '../../packages/template-core/src/registry.ts'
import { canonicalizeGenerationInput, hashCanonicalInput } from '../../packages/data/src/credits/contract.ts'
import { getAvailableCredits } from '../../packages/data/src/credits/spendable.ts'
import { insertGrant, insertGrantTransaction, insertUser, openLedgerDatabase } from '../../packages/data/test/ledger-harness.ts'
import { DEMO_TEMPLATES, listPublishedTemplates } from '../../shared/templates.ts'
import { localMockRegistries } from '../../workers/video-worker/src/catalog.ts'
import { errorCode } from '../../packages/template-core/test/fixtures.ts'
import { createServerTemplateRegistry, getServerTemplateGenerationAvailability, resolvePublicTemplateGeneration } from './engine.ts'
import { getPrivateTemplateConfig, listPrivateTemplateConfigs, renderPrivatePrompt } from './private.ts'
import { prepareTextToVideo } from './text-to-video.ts'

function context(environment = 'test') {
  const { models, providers } = createLocalMockRegistries('test', { nowMs: () => 1000 })
  return { environment, modelRegistry: models, providerRegistry: providers }
}

const userInputs = { character: 'A courier', action: 'Walking through the rain' }

test('adapter reuses the seven published catalog entries and their original private prompts', () => {
  const registry = createServerTemplateRegistry()
  assert.equal(registry.listDefinitions().length, 7)
  assert.equal(DEMO_TEMPLATES.length, 8)
  assert.equal(DEMO_TEMPLATES.filter(template => template.status === 'draft').length, 1)
  validateTemplateRegistry(registry.listDefinitions(), context())
  for (const template of listPublishedTemplates()) {
    const definition = registry.getTemplateDefinitionById(template.id)!
    assert.equal(definition.slug, template.slug)
    assert.equal(definition.promptTemplate, getPrivateTemplateConfig(template.slug)?.prompt)
    assert.equal(definition.defaultParameters.resolution, '720p')
    assert.equal(definition.modelId, 'unassigned')
    assert.equal(definition.version, 1)
  }
})

for (const template of listPublishedTemplates()) {
  test(`${template.slug} maps to valid 6 s / 9:16 GenerationInput in development and test`, () => {
    for (const environment of ['development', 'test']) {
      const result = resolvePublicTemplateGeneration({ ...context(environment), templateId: template.id, userInputs })
      assert.deepEqual(validateGenerationInput(result.generationInput), result.generationInput)
      assert.deepEqual(result.generationInput.parameters, { durationSeconds: 6, resolution: '720p', aspectRatio: '9:16' })
      assert.equal(result.templateSnapshot.templateId, template.id)
      assert.equal(result.templateSnapshot.templateSlug, template.slug)
      assert.equal(result.routeSnapshot.providerId, 'mock-local')
      assert.deepEqual(getServerTemplateGenerationAvailability({ ...context(environment), slug: template.slug }), { generatable: true })
    }
  })
}

test('draft, archived and unknown public identities are rejected', () => {
  assert.throws(() => resolvePublicTemplateGeneration({ ...context(), slug: 'lantern-draft', userInputs }), errorCode('template_not_published'))
  assert.throws(() => resolvePublicTemplateGeneration({ ...context(), slug: 'missing', userInputs }), errorCode('template_not_found'))
  const publicTemplates = DEMO_TEMPLATES.map(template => template.slug === 'neon-night' ? { ...template, status: 'archived' as const } : template)
  assert.throws(() => resolvePublicTemplateGeneration({ ...context(), slug: 'neon-night', userInputs }, { publicTemplates }), errorCode('template_not_published'))
})

test('adapter rejects duplicate public IDs and slugs, including unpublished entries', () => {
  const template = DEMO_TEMPLATES[0]!
  for (const duplicate of [{ ...template, slug: 'duplicate' }, { ...template, id: 'duplicate' }]) {
    assert.throws(() => createServerTemplateRegistry({ publicTemplates: [...DEMO_TEMPLATES, duplicate] }), errorCode('invalid_template'))
  }
})

test('adapter rejects missing and duplicate private configurations', () => {
  const configs = listPrivateTemplateConfigs()
  assert.throws(() => createServerTemplateRegistry({ privateConfigs: configs.slice(1) }), errorCode('invalid_template'))
  assert.throws(() => createServerTemplateRegistry({ privateConfigs: [...configs, configs[0]!] }), errorCode('invalid_template'))
  assert.deepEqual(getServerTemplateGenerationAvailability({ ...context(), slug: 'neon-night' }, { privateConfigs: [] }), { generatable: false, reason: 'invalid_template' })
})

test('adapter rejects public/private template ID mismatches', () => {
  const privateConfigs = listPrivateTemplateConfigs().map((config, index) => index === 0 ? { ...config, templateId: 'wrong-id' } : config)
  assert.throws(() => createServerTemplateRegistry({ privateConfigs }), errorCode('invalid_template'))
})

test('adapter rejects public/private slug mismatches', () => {
  const privateConfigs = listPrivateTemplateConfigs().map((config, index) => index === 0 ? { ...config, slug: 'wrong-slug' } : config)
  assert.throws(() => createServerTemplateRegistry({ privateConfigs }), errorCode('invalid_template'))
})

test('adapter rejects an invalid private template version', () => {
  const privateConfigs = listPrivateTemplateConfigs().map(config => ({ ...config, templateVersion: 0 }))
  assert.throws(() => createServerTemplateRegistry({ privateConfigs }), errorCode('invalid_template'))
})

test('all production templates fail with generation_unavailable even with offline registries injected', () => {
  for (const template of listPublishedTemplates()) {
    assert.throws(() => resolvePublicTemplateGeneration({ ...context('production'), slug: template.slug, userInputs }), errorCode('generation_unavailable'))
    assert.deepEqual(getServerTemplateGenerationAvailability({ ...context('production'), slug: template.slug }), { generatable: false, reason: 'generation_unavailable' })
    assert.deepEqual(prepareTextToVideo(template.slug), { available: false, reason: 'generation_not_open' })
  }
})

test('private helper shares strict compiler/validator rules and rejects prototype property lookup', () => {
  assert.throws(() => renderPrivatePrompt('neon-night', { character: 'Courier' }), errorCode('invalid_inputs'))
  assert.throws(() => renderPrivatePrompt('neon-night', { ...userInputs, extra: 'bad' }), errorCode('invalid_inputs'))
  assert.match(renderPrivatePrompt('neon-night', userInputs)!, /Mood: quiet\. Detail: \./)
  assert.equal(getPrivateTemplateConfig('constructor'), undefined)
  assert.equal(getPrivateTemplateConfig('__proto__'), undefined)
  assert.equal(renderPrivatePrompt('constructor', {}), undefined)
})

test('server resolver rejects client attempts to override trusted generation parameters', () => {
  assert.throws(() => resolvePublicTemplateGeneration({ ...context(), slug: 'neon-night', userInputs: { ...userInputs, resolution: '1080p' } }), errorCode('invalid_inputs'))
})

test('Neon Night full integration validates service input and routing with zero submit, network, task or credit effects', async (t) => {
  const db = openLedgerDatabase(':memory:')
  const now = new Date('2026-11-01T00:00:00Z')
  try {
    await insertUser(db.database, 'template-user', now)
    await insertGrant(db.database, { id: 'template-grant', userId: 'template-user', sourceType: 'promotion', sourceId: 'template-test', granted: 10, remaining: 10, now })
    await insertGrantTransaction(db.database, { id: 'template-initial', userId: 'template-user', grantId: 'template-grant', quantity: 10, sourceType: 'promotion', sourceId: 'template-test', idempotencyKey: 'template-initial', now })
    const before = db.sqlite.prepare('SELECT total_changes() AS changes').get()
    db.sqlite.exec('PRAGMA query_only = ON')
    const calls = { submit: 0, poll: 0, network: 0 }
    t.mock.method(globalThis, 'fetch', () => { calls.network += 1; throw new Error('Network is forbidden during template resolution') })
    const guarded: ProviderAdapter = {
      id: 'mock-local', adapterVersion: 'mock-v1', submissionIdempotency: 'deterministic_mock',
      async submit() { calls.submit += 1; throw new Error('Submit is forbidden during template resolution') },
      async getStatus() { calls.poll += 1; throw new Error('Polling is forbidden during template resolution') },
    }
    const deps = { ...context(), providerRegistry: new ProviderRegistry([guarded]) }
    const result = resolvePublicTemplateGeneration({ ...deps, slug: 'neon-night', userInputs: { ...userInputs, character: ' A courier ', details: 'Rain on wet asphalt' } })
    const serviceInput: CreateGenerationCommand['input'] = result.generationInput
    assert.deepEqual(validateGenerationInput(serviceInput), result.generationInput)
    assert.equal(canonicalizeGenerationInput(result.generationInput).length > 0, true)
    assert.equal(hashCanonicalInput(result.generationInput).length, 64)
    assert.deepEqual(new ProviderRouter(deps.modelRegistry, deps.providerRegistry).select(serviceInput), result.routeSnapshot)
    assert.equal(result.generationInput.prompt, 'internal-template-prompt neon-night. Vertical night street, wet asphalt, colored signs, slow pace. Subject: A courier. Action: Walking through the rain. Mood: quiet. Detail: Rain on wet asphalt. No readable text. No logos.')
    assert.deepEqual(result.templateSnapshot.normalizedInputs, { character: 'A courier', action: 'Walking through the rain', mood: 'quiet', details: 'Rain on wet asphalt' })
    assert.equal(result.templateSnapshot.templateVersion, 1)
    assert.deepEqual(result.routeSnapshot.model, { id: 'mock-motion', revision: 2 })
    assert.equal(result.routeSnapshot.providerId, 'mock-local')
    assert.equal(result.routeSnapshot.providerModelId, 'mock-motion')
    assert.equal(result.routeSnapshot.adapterVersion, 'mock-v1')
    assert.deepEqual(calls, { submit: 0, poll: 0, network: 0 })
    assert.equal(await getAvailableCredits(db.database, 'template-user', now), 10)
    assert.deepEqual(db.sqlite.prepare('SELECT total_changes() AS changes').get(), before)
    for (const table of ['video_generations', 'video_attempts', 'video_outbox', 'video_credit_operations']) {
      assert.equal(db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0)
    }
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM entitlement_transactions').get()?.n, 1)
    assert.equal('prompt' in result.templateSnapshot, false)
    assert.doesNotMatch(JSON.stringify(listPublishedTemplates()) + JSON.stringify(prepareTextToVideo('neon-night')), /internal-template-prompt|promptTemplate|offlineModelIds/)
  }
  finally { db.close() }
})

test('Worker and template server consume one shared local model and route definition', () => {
  const server = createLocalMockRegistries('test', { nowMs: () => 1000 })
  const worker = localMockRegistries('test', { nowMs: () => 1000 })
  const result = resolvePublicTemplateGeneration({ ...context(), slug: 'neon-night', userInputs })
  assert.deepEqual(server.models.listModels(), worker.models.listModels())
  assert.deepEqual(new ProviderRouter(worker.models, worker.providers).select(result.generationInput), result.routeSnapshot)
})

test('Template Core imports only its own modules, contracts and Video Core', () => {
  const directory = new URL('../../packages/template-core/src/', import.meta.url)
  for (const file of readdirSync(directory)) {
    const source = readFileSync(new URL(file, directory), 'utf8')
    for (const [, specifier] of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert.ok(specifier?.startsWith('./') || specifier?.startsWith('../../video-core/src/') || specifier?.startsWith('@reelbam/video-contracts'), `${file}: ${specifier}`)
    }
    assert.doesNotMatch(source, /\beval\s*\(|new Function\b|\bfetch\s*\(/)
  }
})
