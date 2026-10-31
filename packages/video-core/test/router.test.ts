import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ModelRegistry } from '../src/model-registry.ts'
import { ProviderRouter, RoutingError } from '../src/router.ts'
import { ProviderRegistry } from '../src/providers/registry.ts'
import { createMockProvider } from '../src/providers/mock.ts'
import { transitionGeneration } from '../src/state-machine.ts'
import { VideoValidationError } from '../src/validation.ts'
import { input, model, referenceCapability, routeA, routeB, setup } from './fixtures.ts'

describe('确定性多 Provider Route', () => {
  it('按实际能力筛选：较高优先级 A 不支持时选择 B', () => {
    const { router } = setup()
    assert.equal(router.select(input).providerId, 'mock-provider-a')
    const longInput = { ...input, parameters: { durationSeconds: 8, resolution: '720p' } }
    assert.equal(router.select(longInput).providerId, 'mock-provider-b')
    assert.equal(router.select({ modelId: model.id, mode: 'text-to-video', prompt: 'Dance', parameters: input.parameters }).providerId, 'mock-provider-b')
    const restricted = setup({ routes: [{ ...routeA, capabilityConstraints: [{ ...referenceCapability, prompt: 'required' }] }, routeB] })
    assert.equal(restricted.router.select(input).routeId, 'route-b')
    assert.equal(restricted.router.select({ ...input, prompt: 'Dance' }).routeId, 'route-a')
    const noSeedOnA = setup({ routes: [{ ...routeA, capabilityConstraints: [{ ...referenceCapability, optionalParameters: {} }] }, routeB] })
    assert.equal(noSeedOnA.router.select({ ...input, parameters: { ...input.parameters, seed: 1 } }).routeId, 'route-b')
  })

  it('优先级相同使用 Route ID 排序，与注册次序无关', () => {
    const a = { ...routeA, priority: 10 }
    const b = { ...routeB, priority: 10 }
    assert.equal(setup({ routes: [b, a] }).snapshot.routeId, 'route-a')
    assert.equal(setup({ routes: [a, b] }).snapshot.routeId, 'route-a')
    assert.equal(setup({ routes: [routeA, { ...routeB, priority: 0 }] }).snapshot.routeId, 'route-b')
  })

  it('禁用 A 只改变新任务；旧快照经 JSON 保存后仍解析原 Provider/版本', async () => {
    const old = setup()
    const saved = JSON.parse(JSON.stringify(old.snapshot)) as typeof old.snapshot
    const next = setup({ routes: [{ ...routeA, enabled: false }, routeB] })
    assert.equal(next.snapshot.providerId, 'mock-provider-b')
    assert.equal(saved.providerId, 'mock-provider-a')
    assert.equal(old.snapshot.routeId, 'route-a')
    assert.equal(Object.isFrozen(old.snapshot.input.parameters), true)
    const a = next.providers.forSnapshot(saved)
    assert.equal(a.id, 'mock-provider-a')
    assert.equal((await a.submit({ snapshot: saved, submissionKey: 'original-key', submittedAtMs: 1000 })).kind, 'accepted')
    assert.throws(() => next.providers.forSnapshot({ ...saved, adapterVersion: 'missing-version' }), /unavailable/)
    assert.throws(() => new ProviderRegistry([]).forSnapshot(saved), /unavailable/)
  })

  it('不存在的模型、不支持的模式/参数、任意内部字段及无路线时明确失败', () => {
    const { router, providers } = setup()
    assert.throws(() => router.select({ ...input, modelId: 'missing' }), (e: unknown) => e instanceof RoutingError && e.code === 'model_not_found')
    const restricted = new ProviderRouter(new ModelRegistry([{ ...model, capabilities: [referenceCapability] }], [routeA]), providers)
    assert.throws(() => restricted.select({ modelId: model.id, mode: 'text-to-video', prompt: 'Dance', parameters: input.parameters }), (e: unknown) => e instanceof RoutingError && e.code === 'mode_not_supported')
    assert.throws(() => router.select({ ...input, parameters: { durationSeconds: 99, resolution: '480p' } }), VideoValidationError)
    assert.throws(() => router.select({ ...input, providerId: 'mock-provider-b' }), VideoValidationError)
    assert.throws(() => router.select({ ...input, endpoint: 'https://example.invalid' }), VideoValidationError)
    const disabled = setup({ routes: [{ ...routeA, enabled: false }, { ...routeB, enabled: false }] })
    assert.throws(() => disabled.router.select(input), (e: unknown) => e instanceof RoutingError && e.code === 'no_compatible_route')
    const onlyA = setup({ routes: [routeA] })
    assert.throws(() => onlyA.router.select({ ...input, parameters: { durationSeconds: 8, resolution: '720p' } }), /No enabled/)
    assert.throws(() => new ProviderRouter(new ModelRegistry([model], [routeA]), new ProviderRegistry([])).select(input), /No enabled/)
  })

  it('新增 Provider 不改变纯状态机，也不会自动 fallback', async () => {
    const { clock } = setup()
    const c = { ...routeB, routeId: 'route-c', providerId: 'mock-provider-c', priority: 0 }
    const adapter = createMockProvider({ environment: 'test', providerId: c.providerId, scenario: { submit: 'rejected' } }, clock)
    const registry = new ProviderRegistry([adapter])
    const router = new ProviderRouter(new ModelRegistry([model], [c]), registry)
    const snapshot = router.select(input)
    const result = await registry.forSnapshot(snapshot).submit({ snapshot, submissionKey: 'c-key', submittedAtMs: 1000 })
    assert.equal(result.kind, 'rejected')
    assert.equal(snapshot.providerId, 'mock-provider-c')
    assert.equal(transitionGeneration('queued', 'start_submission'), 'submitting')
    assert.equal(transitionGeneration('submitting', 'submission_rejected'), 'failed')
    assert.throws(() => new ProviderRegistry([adapter, adapter]), /duplicate/)
  })
})
