import assert from 'node:assert/strict'
import test from 'node:test'
import { TemplateRegistry, validateTemplateRegistry } from '../src/registry.ts'
import { context, definition, errorCode } from './fixtures.ts'

test('registry looks up a definition by stable ID and slug and leaves unknown identities absent', () => {
  const registry = new TemplateRegistry([definition()])
  assert.equal(registry.getTemplateDefinitionById('test-template')?.version, 1)
  assert.equal(registry.getTemplateDefinitionBySlug('test-template')?.templateId, 'test-template')
  assert.equal(registry.getTemplateDefinitionBySlug('missing'), undefined)
})

test('registry rejects duplicate IDs and duplicate slugs independently', () => {
  assert.throws(() => new TemplateRegistry([definition(), definition({ slug: 'other' })]), errorCode('invalid_template'))
  assert.throws(() => new TemplateRegistry([definition(), definition({ templateId: 'other' })]), errorCode('invalid_template'))
})

for (const version of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`registry rejects version ${String(version)}`, () => {
    assert.throws(() => new TemplateRegistry([definition({ version })]), errorCode('invalid_template'))
  })
}

test('registry validates prompt variables and input defaults', () => {
  assert.throws(() => new TemplateRegistry([definition({ promptTemplate: '{{unknown}}' })]), errorCode('invalid_prompt'))
  const inputFields = [{ key: 'subject', type: 'text' as const, required: true, defaultValue: '', maxLength: 80 }]
  assert.throws(() => new TemplateRegistry([definition({ inputFields })]), errorCode('invalid_template'))
})

test('registry validates default generation parameters and rejects unsupported template modes', () => {
  assert.throws(() => new TemplateRegistry([definition({ defaultParameters: { durationSeconds: 6, resolution: '' } })]), errorCode('invalid_template'))
  assert.throws(() => new TemplateRegistry([definition({ generationMode: 'image-to-video' })]), errorCode('invalid_template'))
})

test('model-aware registry validation checks bindings and capability compatibility', () => {
  validateTemplateRegistry([definition()], context())
  assert.throws(() => validateTemplateRegistry([definition({ modelId: 'missing', offlineModelIds: {} })], context()), errorCode('generation_unavailable'))
  assert.throws(() => validateTemplateRegistry([definition({ defaultParameters: { durationSeconds: 7, resolution: '720p' } })], context()), errorCode('generation_unavailable'))
  assert.throws(() => validateTemplateRegistry([definition()], { ...context(), environment: 'production' }), errorCode('generation_unavailable'))
})

test('registry copies and freezes definitions independently of caller changes', () => {
  const source = structuredClone(definition())
  const registry = new TemplateRegistry([source])
  Object.assign(source, { version: 9, promptTemplate: 'Changed prompt' })
  assert.equal(registry.getTemplateDefinitionById('test-template')?.version, 1)
  assert.equal(Object.isFrozen(registry.getTemplateDefinitionById('test-template')?.defaultParameters), true)
})
