import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ModelRegistry } from '../src/model-registry.ts'
import { toPublicGeneration } from '../src/public-generation.ts'
import { assertInputMatchesCapability, validateGenerationInput, VideoValidationError } from '../src/validation.ts'
import type { GenerationInput } from '../../video-contracts/src/public.ts'
import { imageCapability, input, model, routeA, routeB, setup, textCapability } from './fixtures.ts'

describe('公开输入与能力约束', () => {
  it('三种模式的必填输入和非法字段都在运行时校验', () => {
    const parameters = { durationSeconds: 4, resolution: '480p' }
    const text = { modelId: model.id, mode: 'text-to-video', prompt: 'Dance', parameters }
    const image = { modelId: model.id, mode: 'image-to-video', imageAssetId: 'image', parameters }
    assert.equal(validateGenerationInput(text).mode, 'text-to-video')
    assert.equal(validateGenerationInput(image).mode, 'image-to-video')
    assert.deepEqual(validateGenerationInput(input), input)
    for (const invalid of [
      null, {}, { ...text, prompt: '' }, { ...text, prompt: '   ' }, { ...image, imageAssetId: undefined },
      { ...input, referenceVideoAssetId: '' }, { ...input, imageAssetId: undefined },
      { ...input, mode: 'other' }, { ...input, providerEndpoint: 'https://example.invalid' },
      { ...text, imageAssetId: 'unexpected' }, { ...input, parameters: { ...parameters, seed: 1.5 } },
      { ...input, parameters: { ...parameters, durationSeconds: 0 } },
      { ...input, parameters: { ...parameters, generateAudio: 'false' } },
      { ...input, parameters: { ...parameters, unknownOption: 1 } },
    ]) assert.throws(() => validateGenerationInput(invalid), VideoValidationError)
  })

  it('Prompt 和可选参数受模型能力控制', () => {
    const image: GenerationInput = { modelId: model.id, mode: 'image-to-video', imageAssetId: 'image', parameters: input.parameters }
    assert.doesNotThrow(() => assertInputMatchesCapability(image, imageCapability))
    assert.throws(() => assertInputMatchesCapability(image, { ...imageCapability, prompt: 'required' }), /Prompt/)
    assert.throws(() => assertInputMatchesCapability({ ...image, prompt: 'yes' }, { ...imageCapability, prompt: 'unsupported' }), /Prompt/)
    for (const parameters of [
      { ...input.parameters, durationSeconds: 9 }, { ...input.parameters, resolution: '1080p' },
      { ...input.parameters, aspectRatio: '1:1' }, { ...input.parameters, seed: 101 },
      { ...input.parameters, generateAudio: true },
    ]) assert.throws(() => assertInputMatchesCapability({ ...image, parameters }, imageCapability), VideoValidationError)
    assert.doesNotThrow(() => assertInputMatchesCapability({ ...image, parameters: {
      ...input.parameters, seed: 0, aspectRatio: '9:16', generateAudio: false,
    } }, imageCapability))
  })

  it('仅公共入口和显式投影提供前端字段', async () => {
    const publicExports = await import('../../video-contracts/src/public.ts')
    assert.deepEqual(Object.keys(publicExports), [])
    const { snapshot } = setup()
    const dto = toPublicGeneration({
      id: 'generation', route: snapshot, status: 'submission_unknown', errorCode: null, outputAssetId: 'not-ready',
      handle: { providerId: 'private', providerModelId: 'private', adapterVersion: 'v1', jobId: 'job', metadata: { secret: 'private' } },
    })
    assert.deepEqual(dto, {
      id: 'generation', modelId: model.id, mode: 'reference-to-video', status: 'processing', errorCode: null, outputAssetId: null,
    })
    assert.equal(JSON.stringify(dto).includes('private'), false)
    assert.equal(toPublicGeneration({ id: 'g', route: snapshot, status: 'succeeded', errorCode: null, outputAssetId: 'output' }).outputAssetId, 'output')
  })
})

describe('Model Registry', () => {
  it('查询模型和多个路线，拒绝重复/不存在的配置', () => {
    const registry = new ModelRegistry([model], [routeA, routeB])
    assert.equal(registry.getModel(model.id)?.name, 'Mock Motion')
    assert.equal(registry.getModel('missing'), undefined)
    assert.equal(registry.listModels().length, 1)
    assert.equal(registry.routesFor(model.id).length, 2)
    assert.throws(() => new ModelRegistry([model, model], []), /duplicate/)
    assert.throws(() => new ModelRegistry([model], [routeA, routeA]), /duplicate/)
    assert.throws(() => new ModelRegistry([], [routeA]), /Invalid/)
  })

  it('Route 不得扩大模型声明，注册后不受外部配置修改影响', () => {
    assert.throws(() => new ModelRegistry([model], [{ ...routeA, capabilityConstraints: [
      { ...textCapability, resolutions: ['1080p'] },
    ] }]), /expands/)
    assert.throws(() => new ModelRegistry([model], [{ ...routeA, capabilityConstraints: [
      { ...textCapability, prompt: 'optional' },
    ] }]), /Prompt/)
    const mutable = { ...model }
    const registry = new ModelRegistry([mutable], [])
    mutable.id = 'changed'
    assert.equal(registry.getModel(model.id)?.id, model.id)
    assert.equal(Object.isFrozen(registry.getModel(model.id)?.capabilities), true)
  })
})
