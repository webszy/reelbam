import assert from 'node:assert/strict'
import test from 'node:test'
import type { Capability } from '../../video-contracts/src/public.ts'
import type { RouteSnapshot } from '../../video-contracts/src/internal.ts'
import { createLocalMockRegistries, LOCAL_MOCK_MODEL, LOCAL_MOCK_ROUTE } from '../../video-core/src/development-catalog.ts'
import { ModelRegistry } from '../../video-core/src/model-registry.ts'
import { ProviderRegistry } from '../../video-core/src/providers/registry.ts'
import { validateGenerationInput } from '../../video-core/src/validation.ts'
import { TemplateRegistry } from '../src/registry.ts'
import { getTemplateGenerationAvailability, resolveTemplateGeneration } from '../src/resolver.ts'
import type { TemplateDefinition } from '../src/types.ts'
import { context, definition, errorCode } from './fixtures.ts'

function command(overrides: Partial<TemplateDefinition> = {}) {
  return { ...context(), templateRegistry: new TemplateRegistry([definition(overrides)]), slug: 'test-template', userInputs: { subject: 'A cat' } }
}

test('6 s / 9:16 / 720p resolves through existing Video Core and saves versioned independent snapshots', () => {
  const input = command()
  const result = resolveTemplateGeneration(input)
  assert.deepEqual(validateGenerationInput(result.generationInput), result.generationInput)
  assert.deepEqual(result.generationInput.parameters, { durationSeconds: 6, resolution: '720p', aspectRatio: '9:16' })
  assert.equal(result.routeSnapshot.model.id, 'mock-motion')
  assert.equal(result.routeSnapshot.model.revision, 2)
  assert.equal(result.routeSnapshot.revision, 2)
  assert.equal(result.routeSnapshot.providerId, 'mock-local')
  assert.equal(result.templateSnapshot.templateVersion, 1)
  assert.deepEqual(result.templateSnapshot.normalizedInputs, { subject: 'A cat', style: 'quiet', details: '' })
  input.userInputs.subject = 'Changed'
  assert.equal(result.templateSnapshot.normalizedInputs.subject, 'A cat')
  assert.equal(Object.isFrozen(result.templateSnapshot.normalizedInputs), true)
  const saved = JSON.parse(JSON.stringify(result)) as typeof result
  assert.deepEqual(saved, result)
  const newer = resolveTemplateGeneration(command({ version: 2, promptTemplate: 'New {{subject}}' }))
  assert.equal(saved.templateSnapshot.templateVersion, 1)
  assert.notEqual(saved.generationInput.prompt, newer.generationInput.prompt)
})

test('original 5 s capability remains supported with or without the optional ratio', () => {
  for (const parameters of [{ durationSeconds: 5, resolution: '720p' }, { durationSeconds: 5, resolution: '720p', aspectRatio: '9:16' }]) {
    assert.equal(resolveTemplateGeneration(command({ defaultParameters: parameters })).generationInput.parameters.durationSeconds, 5)
  }
})

for (const [label, parameters] of [
  ['duration', { durationSeconds: 7, resolution: '720p', aspectRatio: '9:16' }],
  ['aspect ratio', { durationSeconds: 6, resolution: '720p', aspectRatio: '16:9' }],
  ['resolution', { durationSeconds: 6, resolution: '1080p', aspectRatio: '9:16' }],
  ['seed', { durationSeconds: 6, resolution: '720p', seed: 1 }],
  ['audio', { durationSeconds: 6, resolution: '720p', generateAudio: true }],
] as const) {
  test(`unsupported ${label} fails closed`, () => {
    assert.throws(() => resolveTemplateGeneration(command({ defaultParameters: parameters })), errorCode('generation_unavailable'))
  })
}

test('unknown model and unavailable model mode fail closed', () => {
  assert.throws(() => resolveTemplateGeneration(command({ modelId: 'missing', offlineModelIds: {} })), errorCode('generation_unavailable'))
  const modelRegistry = new ModelRegistry([{ id: 'mock-motion', revision: 1, name: 'Image only', capabilities: [{
    id: 'image', mode: 'image-to-video', prompt: 'optional', durationSeconds: [6], resolutions: ['720p'], optionalParameters: {},
  }] }], [])
  assert.throws(() => resolveTemplateGeneration({ ...command(), modelRegistry }), errorCode('generation_unavailable'))
})

test('disabled routes and missing Provider adapters are unavailable', () => {
  const modelRegistry = new ModelRegistry([LOCAL_MOCK_MODEL], [{ ...LOCAL_MOCK_ROUTE, enabled: false }])
  assert.throws(() => resolveTemplateGeneration({ ...command(), modelRegistry }), errorCode('generation_unavailable'))
  assert.throws(() => resolveTemplateGeneration({ ...command(), providerRegistry: new ProviderRegistry([]) }), errorCode('generation_unavailable'))
  assert.deepEqual(getTemplateGenerationAvailability({ ...command(), modelRegistry }), { generatable: false, reason: 'generation_unavailable' })
})

test('route constraints can reject parameters accepted by the model', () => {
  const capability = LOCAL_MOCK_MODEL.capabilities[0]!
  const restricted: Capability = { ...capability, durationSeconds: [5] }
  const modelRegistry = new ModelRegistry([LOCAL_MOCK_MODEL], [{ ...LOCAL_MOCK_ROUTE, capabilityConstraints: [restricted] }])
  assert.throws(() => resolveTemplateGeneration({ ...command(), modelRegistry }), errorCode('generation_unavailable'))
})

test('Draft and Archived definitions cannot use the public resolver', () => {
  for (const status of ['draft', 'archived'] as const) {
    assert.throws(() => resolveTemplateGeneration(command({ status })), errorCode('template_not_published'))
  }
  assert.throws(() => resolveTemplateGeneration({ ...command(), slug: 'missing' }), errorCode('template_not_found'))
})

test('production ignores offline overrides and also rejects an explicitly misbound Mock', () => {
  assert.throws(() => resolveTemplateGeneration({ ...command(), environment: 'production' }), errorCode('generation_unavailable'))
  assert.throws(() => resolveTemplateGeneration({ ...command({ modelId: 'mock-motion' }), environment: 'production' }), errorCode('generation_unavailable'))
  assert.deepEqual(getTemplateGenerationAvailability({ ...command(), environment: 'production' }), { generatable: false, reason: 'generation_unavailable' })
  assert.throws(() => createLocalMockRegistries('production', { nowMs: () => 0 }), /explicit development or test/)
})

test('missing and unsupported environments cannot silently become development', () => {
  for (const environment of [undefined, null, '', 'staging', 'preview', 'Production', ' test ']) {
    assert.throws(() => resolveTemplateGeneration({ ...command(), environment }), errorCode('invalid_environment'))
  }
})

test('readiness checks all routes without invoking input validation or submitting a job', () => {
  assert.deepEqual(getTemplateGenerationAvailability(command()), { generatable: true })
  assert.deepEqual(getTemplateGenerationAvailability({ ...command(), slug: 'missing' }), { generatable: false, reason: 'template_not_found' })
})

test('revision 1 RouteSnapshot restores with the current adapter without selecting a new route', async () => {
  const capability: Capability = { id: 'text', mode: 'text-to-video', prompt: 'required', durationSeconds: [5], resolutions: ['720p'], optionalParameters: {} }
  const snapshot: RouteSnapshot = JSON.parse(JSON.stringify({
    schemaVersion: 1, routeId: 'mock-motion-local', revision: 1,
    model: { id: 'mock-motion', revision: 1 }, providerId: 'mock-local', providerModelId: 'mock-motion', adapterVersion: 'mock-v1',
    capability, input: { modelId: 'mock-motion', mode: 'text-to-video', prompt: 'Saved original prompt', parameters: { durationSeconds: 5, resolution: '720p' } },
  }))
  const first = context().providerRegistry.forSnapshot(snapshot)
  assert.ok(first.projectSubmission)
  const projected = await first.projectSubmission({ snapshot, submissionKey: 'legacy-key', submittedAtMs: 1000 })
  assert.equal(projected.kind, 'accepted')
  if (projected.kind !== 'accepted') assert.fail('Expected a projected local handle')
  const restarted = context().providerRegistry.forSnapshot(snapshot)
  const status = await restarted.getStatus(projected.handle, snapshot)
  assert.equal(status.state, 'completed')
  assert.equal(snapshot.revision, 1)
  assert.deepEqual(snapshot.capability.durationSeconds, [5])
  assert.equal(snapshot.input.prompt, 'Saved original prompt')
})
